const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const bs58 = require('bs58').default;
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');

const {
  NftRpcScheduler,
} = require('../../dist/modules/season-nfts/resources/nft-worker/rpc-scheduler');
const {
  withDbOnlyRetry,
} = require('../../dist/modules/season-nfts/resources/nft-worker/db-only-retry');
const seasonNftConfig = require('../../dist/config/season-nft.config').default;
const {
  NftLeaderSession,
  NftWorker,
} = require('../../dist/modules/season-nfts/resources/nft-worker/nft-worker');
const {
  NftRuntimeQueue,
  NftOperationRetryError,
  NftOperationPermanentError,
} = require('../../dist/modules/season-nfts/resources/nft-worker/nft-runtime-queue');
const {
  PgTransactionRunner,
} = require('../../dist/database/transaction/pg-transaction.runner');
const {
  ClaimRepository,
} = require('../../dist/modules/season-nfts/resources/claim/claim.repository');
const {
  NftTransactionRepository,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction.repository');
const {
  NftTransactionDispatcher,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher');
const {
  SeasonNftRepository,
} = require('../../dist/modules/season-nfts/resources/season-nft/season-nft.repository');

class FakeClock {
  constructor() {
    this.time = 0;
    this.waiters = [];
  }

  now() {
    return this.time;
  }

  sleep(delay) {
    return new Promise((resolve) => {
      this.waiters.push({ at: this.time + delay, resolve });
    });
  }

  async advanceTo(time) {
    this.time = time;
    for (;;) {
      const ready = this.waiters.filter((waiter) => waiter.at <= time);
      this.waiters = this.waiters.filter((waiter) => waiter.at > time);
      if (ready.length === 0) break;
      ready.forEach((waiter) => waiter.resolve());
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

async function flushMicrotasks(count = 20) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

test('shared rolling limiter counts reads and sends and spaces sends by 1200ms', async () => {
  const clock = new FakeClock();
  const starts = [];
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    clock,
  );
  const run = (kind) =>
    scheduler.enqueue({
      kind,
      run: async () => {
        starts.push({ kind, at: clock.now() });
      },
    });

  const first = run('USER_SEND');
  await flushMicrotasks();
  await clock.advanceTo(100);
  const reads = [
    run('USER_CHECK'),
    run('USER_CHECK'),
    run('USER_CHECK'),
    run('USER_CHECK'),
  ];
  await flushMicrotasks();
  await clock.advanceTo(400);
  const blockedRead = run('USER_CHECK');
  const secondSend = run('USER_SEND');
  await clock.advanceTo(999);
  await flushMicrotasks();
  assert.equal(starts.length, 5);
  await clock.advanceTo(1200);
  await flushMicrotasks();
  await Promise.all([first, ...reads, blockedRead, secondSend]);

  assert.equal(starts.filter((item) => item.kind === 'USER_SEND').length, 2);
  assert.ok(starts.filter((item) => item.kind === 'USER_SEND')[1].at >= 1200);
  for (const start of starts) {
    assert.ok(
      starts.filter((item) => item.at > start.at - 1000 && item.at <= start.at)
        .length <= 5,
    );
  }
});

test('scheduler gives release preparation one turn after ten user jobs', async () => {
  const order = [];
  const scheduler = new NftRpcScheduler(
    { readRps: 100, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  const jobs = [];
  for (let index = 0; index < 12; index += 1) {
    jobs.push(
      scheduler.enqueue({
        kind: 'USER_CHECK',
        run: async () => order.push(`user-${index}`),
      }),
    );
  }
  jobs.push(
    scheduler.enqueue({
      kind: 'RELEASE_PREPARE',
      run: async () => order.push('release'),
    }),
  );
  await Promise.all(jobs);
  assert.equal(order.indexOf('release'), 10);
});

test('release preparation writes consume the shared send gap without changing release priority', async () => {
  const clock = new FakeClock();
  const starts = [];
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    clock,
  );
  const first = scheduler.enqueue({
    kind: 'RELEASE_PREPARE',
    rpcType: 'SEND',
    run: async () => starts.push(clock.now()),
  });
  await flushMicrotasks();
  const second = scheduler.enqueue({
    kind: 'RELEASE_PREPARE',
    rpcType: 'SEND',
    run: async () => starts.push(clock.now()),
  });
  await clock.advanceTo(1199);
  await flushMicrotasks();
  assert.deepEqual(starts, [0]);
  await clock.advanceTo(1200);
  await Promise.all([first, second]);
  assert.deepEqual(starts, [0, 1200]);
});

test('storage lane does not block chain lane', async () => {
  let finishUpload;
  const pendingUpload = new Promise((resolve) => {
    finishUpload = resolve;
  });
  const order = [];
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  const storage = scheduler.enqueueStorage(async () => {
    order.push('upload-start');
    await pendingUpload;
    order.push('upload-end');
  });
  await Promise.resolve();
  await scheduler.enqueue({
    kind: 'USER_CHECK',
    run: async () => order.push('chain'),
  });
  assert.deepEqual(order, ['upload-start', 'chain']);
  finishUpload();
  await storage;
});

test('leader loss prevents queued storage work from starting', async () => {
  let active = true;
  let finishFirst;
  const firstWait = new Promise((resolve) => {
    finishFirst = resolve;
  });
  let secondStarts = 0;
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    undefined,
    () => active,
  );
  const first = scheduler.enqueueStorage(() => firstWait);
  const second = scheduler.enqueueStorage(async () => {
    secondStarts += 1;
  });
  await flushMicrotasks();
  active = false;
  scheduler.stop();
  finishFirst();
  await first;
  await assert.rejects(second, /stopped|active leader/);
  assert.equal(secondStarts, 0);
});

test('DB-only retry caps serialization and deadlock failures at three attempts', async () => {
  for (const code of ['40001', '40P01']) {
    let attempts = 0;
    await assert.rejects(
      withDbOnlyRetry(async () => {
        attempts += 1;
        throw Object.assign(new Error('retryable'), { code });
      }),
      /retryable/,
    );
    assert.equal(attempts, 3);
  }
  let attempts = 0;
  await assert.rejects(
    withDbOnlyRetry(async () => {
      attempts += 1;
      throw Object.assign(new Error('not retryable'), { code: '23505' });
    }),
  );
  assert.equal(attempts, 1);
});

test('enabled worker config validates exact limits and private persistence roots', () => {
  const previous = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'cameo-nft-config-'));
  const uploads = join(root, 'uploads');
  const keys = join(root, 'keys');
  const snapshots = join(root, 'canvas');
  const serviceKey = join(root, 'service-key.json');
  mkdirSync(uploads, { mode: 0o700 });
  mkdirSync(keys, { mode: 0o700 });
  mkdirSync(snapshots, { mode: 0o700 });
  writeFileSync(serviceKey, JSON.stringify(Array(64).fill(1)), { mode: 0o600 });
  chmodSync(root, 0o700);
  Object.assign(process.env, {
    SEASON_NFT_ENABLED: 'true',
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: 'https://rpc.example.invalid',
    SOLANA_SERVICE_KEYPAIR_PATH: serviceKey,
    NFT_STORAGE_UPLOAD_URL: 'https://upload.example.invalid',
    NFT_STORAGE_PAYMENT_URL: 'https://payment.example.invalid',
    NFT_STORAGE_GATEWAY_URL: 'https://gateway.example.invalid',
    NFT_UPLOAD_WORK_DIR: uploads,
    NFT_PREPARATION_KEY_DIR: keys,
    CANVAS_SNAPSHOT_ENABLED: 'true',
    CANVAS_SNAPSHOT_STORAGE_ROOT: snapshots,
    NFT_RPC_READ_RPS: '5',
    NFT_RPC_SEND_INTERVAL_MS: '1200',
    NFT_PRIORITY_FEE_MAX_LAMPORTS: '0',
  });
  try {
    assert.deepEqual(seasonNftConfig(), {
      enabled: true,
      network: 'devnet',
      rpcUrl: 'https://rpc.example.invalid',
      serviceKeypairPath: serviceKey,
      storageUploadUrl: 'https://upload.example.invalid',
      storagePaymentUrl: 'https://payment.example.invalid',
      storageGatewayUrl: 'https://gateway.example.invalid',
      uploadWorkDir: uploads,
      preparationKeyDir: keys,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      priorityFeeMaxLamports: 0n,
    });
    process.env.NFT_RPC_READ_RPS = '6';
    assert.throws(() => seasonNftConfig(), /NFT_RPC_READ_RPS/);
    process.env.NFT_RPC_READ_RPS = '5';
    process.env.NFT_RPC_SEND_INTERVAL_MS = '1199';
    assert.throws(() => seasonNftConfig(), /NFT_RPC_SEND_INTERVAL_MS/);
    process.env.NFT_RPC_SEND_INTERVAL_MS = '1200';
    process.env.NFT_PREPARATION_KEY_DIR = uploads;
    assert.throws(() => seasonNftConfig(), /must be separate/);
    process.env.NFT_PREPARATION_KEY_DIR = keys;
    process.env.CANVAS_SNAPSHOT_ENABLED = 'false';
    assert.throws(() => seasonNftConfig(), /CANVAS_SNAPSHOT_ENABLED/);
    process.env.CANVAS_SNAPSHOT_ENABLED = 'true';
    const exposed = join(snapshots, 'snapshots', 'private-keys');
    mkdirSync(join(snapshots, 'snapshots'), { mode: 0o700 });
    mkdirSync(exposed, { mode: 0o700 });
    process.env.NFT_PREPARATION_KEY_DIR = exposed;
    assert.throws(() => seasonNftConfig(), /public snapshot subtree/);
  } finally {
    process.env = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dedicated advisory clients allow one leader and same-session takeover', async () => {
  const database = await testDatabaseModule();
  const first = new NftLeaderSession(database.pool, 1, () => {});
  const second = new NftLeaderSession(database.pool, 1, () => {});
  try {
    assert.equal(await first.acquire(), true);
    assert.equal(await second.acquire(), false);
    await first.close();
    assert.equal(await second.acquire(), true);
  } finally {
    await first.close();
    await second.close();
  }
});

test('leader connection loss stops every queued new external start', async () => {
  class FakeClient extends EventEmitter {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock'))
        return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    release() {}
  }
  const client = new FakeClient();
  const config = {
    read: () => ({
      enabled: true,
      network: 'devnet',
      advisoryNetworkKey: 1,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      jobScanIntervalMs: 60_000,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 15_000,
    }),
  };
  let starts = 0;
  const queue = {
    scan: async (scheduler) => {
      await scheduler.enqueue({
        kind: 'USER_CHECK',
        run: async () => {
          starts += 1;
        },
      });
    },
  };
  const worker = new NftWorker(config, { connect: async () => client }, queue);
  await worker.onApplicationBootstrap();
  assert.equal(starts, 1);
  client.emit('end');
  await worker.scanNow();
  assert.equal(starts, 1);
  await worker.onModuleDestroy();
});

test('shutdown during delayed leader acquire never installs a scheduler', async () => {
  let resolveLock;
  let releases = 0;
  class DelayedClient extends EventEmitter {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock'))
        return new Promise((resolve) => {
          resolveLock = resolve;
        });
      if (sql.includes('pg_advisory_unlock'))
        return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    release() {
      releases += 1;
    }
  }
  const config = {
    read: () => ({
      enabled: true,
      network: 'devnet',
      advisoryNetworkKey: 1,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      jobScanIntervalMs: 60_000,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 15_000,
    }),
  };
  let scans = 0;
  const worker = new NftWorker(
    config,
    { connect: async () => new DelayedClient() },
    {
      scan: async () => {
        scans += 1;
      },
    },
  );
  const boot = worker.onApplicationBootstrap();
  await flushMicrotasks();
  const shutdown = worker.onModuleDestroy();
  resolveLock({ rows: [{ acquired: true }] });
  await Promise.all([boot, shutdown]);
  assert.equal(scans, 0);
  assert.equal(releases, 1);
});

test('shutdown uses one deadline and discards a session whose lock query stalls', async () => {
  let releaseArgument;
  class StalledClient extends EventEmitter {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return new Promise(() => {});
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    release(discard) {
      releaseArgument = discard;
    }
  }
  const config = {
    read: () => ({
      enabled: true,
      network: 'devnet',
      advisoryNetworkKey: 1,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      jobScanIntervalMs: 60_000,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 20,
    }),
  };
  const worker = new NftWorker(
    config,
    { connect: async () => new StalledClient() },
    { scan: async () => {} },
  );
  void worker.onApplicationBootstrap();
  await flushMicrotasks();
  const result = await Promise.race([
    worker.onModuleDestroy().then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
  ]);
  assert.equal(result, 'closed');
  assert.equal(releaseArgument, true);
});

test('a pool connect completing after shutdown self-discards without querying or leading', async () => {
  let resolveConnect;
  let queries = 0;
  let releaseArgument;
  let scans = 0;
  class LateClient extends EventEmitter {
    async query() {
      queries += 1;
      return { rows: [{ acquired: true }] };
    }
    release(discard) {
      releaseArgument = discard;
    }
  }
  const config = {
    read: () => ({
      enabled: true,
      network: 'devnet',
      advisoryNetworkKey: 1,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      jobScanIntervalMs: 60_000,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 20,
    }),
  };
  const worker = new NftWorker(
    config,
    {
      connect: () =>
        new Promise((resolve) => {
          resolveConnect = resolve;
        }),
    },
    {
      scan: async () => {
        scans += 1;
      },
    },
  );
  const boot = worker.onApplicationBootstrap();
  await flushMicrotasks();
  await worker.onModuleDestroy();
  resolveConnect(new LateClient());
  await boot;
  assert.equal(queries, 0);
  assert.equal(scans, 0);
  assert.equal(releaseArgument, true);
});

test('shutdown deadline aborts active storage and prevents its later gateway stage', async () => {
  class FakeClient extends EventEmitter {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock'))
        return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    release() {}
  }
  let uploadStarted = false;
  let gatewayStarts = 0;
  const config = {
    read: () => ({
      enabled: true,
      network: 'devnet',
      advisoryNetworkKey: 1,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      jobScanIntervalMs: 60_000,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 20,
    }),
  };
  const worker = new NftWorker(
    config,
    { connect: async () => new FakeClient() },
    {
      scan: async (scheduler) => {
        void scheduler
          .enqueueStorage(async ({ signal, assertMayStart }) => {
            uploadStarted = true;
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve, { once: true }),
            );
            assertMayStart();
            gatewayStarts += 1;
          })
          .catch(() => undefined);
      },
    },
  );
  await worker.onApplicationBootstrap();
  assert.equal(uploadStarted, true);
  const startedAt = Date.now();
  await worker.onModuleDestroy();
  assert.ok(Date.now() - startedAt < 100);
  await flushMicrotasks();
  assert.equal(gatewayStarts, 0);
});

test('lost session is released once and stale events cannot stop takeover generation', async () => {
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.releases = 0;
    }
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock'))
        return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock'))
        return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
    release() {
      this.releases += 1;
    }
  }
  const config = {
    read: () => ({
      enabled: true,
      network: 'devnet',
      advisoryNetworkKey: 1,
      rpcReadRps: 5,
      rpcSendIntervalMs: 1200,
      jobScanIntervalMs: 1,
      seasonScanIntervalMs: 60_000,
      rpcTimeoutMs: 10_000,
      uploadTimeoutMs: 120_000,
      gatewayTimeoutMs: 30_000,
      shutdownTimeoutMs: 15_000,
    }),
  };
  let starts = 0;
  const worker = new NftWorker(
    config,
    {
      connect: async () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    },
    {
      scan: async (scheduler) =>
        scheduler.enqueue({
          kind: 'USER_CHECK',
          run: async () => {
            starts += 1;
          },
        }),
    },
  );
  await worker.onApplicationBootstrap();
  clients[0].emit('error', new Error('connection lost'));
  clients[0].emit('end');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(clients[0].releases, 1);
  assert.ok(clients.length >= 2);
  await worker.scanNow();
  const afterTakeover = starts;
  clients[0].emit('end');
  await worker.scanNow();
  assert.ok(starts > afterTakeover);
  await worker.onModuleDestroy();
});

test('a later scan discovers user checks while a prior storage upload is pending', async () => {
  let finishUpload;
  const uploadPending = new Promise((resolve) => {
    finishUpload = resolve;
  });
  let releaseScan = 0;
  let transactionScan = 0;
  let checks = 0;
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    {
      claimDue: async () =>
        ++releaseScan === 1
          ? [
              {
                releaseId: 'release-1',
                seasonId: 'season-1',
                state: 'PREPARING',
                stage: 'FROZEN',
                retryCount: 0,
              },
            ]
          : [],
      rescheduleDue: async () => {},
    },
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [],
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async () => {},
    },
    {
      claimDue: async () =>
        ++transactionScan === 2
          ? [
              {
                id: 'transaction-1',
                state: 'SUBMITTED',
                signature: 'sig',
                serializedTransaction: Buffer.from('bytes'),
                lastValidBlockHeight: 1n,
              },
            ]
          : [],
      findDispatchable: async () => null,
    },
    { execute: async () => {}, prepareMedia: async () => uploadPending },
    { findUnreleased: async () => [] },
    {
      dispatch: async () => {},
      check: async () => {
        checks += 1;
      },
    },
    { next: async () => null },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    { run: async (operation) => operation({}) },
  );
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  await runtime.scan(scheduler);
  await flushMicrotasks();
  await runtime.scan(scheduler);
  await flushMicrotasks();
  assert.equal(checks, 1);
  finishUpload();
});

test('runtime caps admitted release work while the storage lane is pending', async () => {
  let finishUpload;
  const uploadPending = new Promise((resolve) => {
    finishUpload = resolve;
  });
  const limits = [];
  const rows = Array.from({ length: 20 }, (_, index) => ({
    releaseId: `release-${index}`,
    seasonId: `season-${index}`,
    state: 'PREPARING',
    stage: 'FROZEN',
    retryCount: 0,
  }));
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    {
      claimDue: async ({ limit }) => {
        limits.push(limit);
        return limits.length === 1 ? rows : [];
      },
      rescheduleDue: async () => {},
    },
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [],
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async () => {},
    },
    { claimDue: async () => [], findDispatchable: async () => null },
    { execute: async () => {}, prepareMedia: async () => uploadPending },
    { findUnreleased: async () => [] },
    { dispatch: async () => {}, check: async () => {} },
    { next: async () => null },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    { run: async (operation) => operation({}) },
  );
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  await runtime.scan(scheduler);
  await runtime.scan(scheduler);
  assert.deepEqual(limits, [20, 0]);
  finishUpload();
});

test('runtime bounds aggregate user admission across repeated backlog scans', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const attemptLimits = [];
  const transactionLimits = [];
  const receiptLimits = [];
  let scan = 0;
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    { claimDue: async () => [], rescheduleDue: async () => {} },
    {
      claimDueAttempts: async ({ limit }) => {
        attemptLimits.push(limit);
        return ++scan === 1
          ? Array.from({ length: limit }, (_, index) => ({
              attemptId: `attempt-${index}`,
              claimId: `claim-${index}`,
              retryCount: 0,
            }))
          : [];
      },
      claimDueReceipts: async ({ limit }) => {
        receiptLimits.push(limit);
        return receiptLimits.length === 1
          ? Array.from({ length: limit }, (_, index) => ({
              claimId: `receipt-${index}`,
              retryCount: 0,
            }))
          : [];
      },
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async () => {},
    },
    {
      claimDue: async ({ limit }) => {
        transactionLimits.push(limit);
        return transactionLimits.length === 1
          ? Array.from({ length: limit }, (_, index) => ({
              id: `transaction-${index}`,
              state: 'SUBMITTED',
              signature: `signature-${index}`,
              serializedTransaction: Buffer.from('bytes'),
              lastValidBlockHeight: 1n,
            }))
          : [];
      },
      findDispatchable: async () => null,
    },
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    { dispatch: async () => {}, check: async () => pending },
    {
      next: async () => ({ kind: 'USER_BUILD', run: async () => pending }),
    },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    { run: async (operation) => operation({}) },
  );
  const scheduler = new NftRpcScheduler(
    { readRps: 1000, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  await runtime.scan(scheduler);
  await runtime.scan(scheduler);
  assert.equal(attemptLimits[0] + transactionLimits[0] + receiptLimits[0], 100);
  assert.deepEqual(
    [attemptLimits[1], transactionLimits[1], receiptLimits[1]],
    [0, 0, 0],
  );
  finish();
});

test('candidate scans no longer prepare releases before the creator asks', async () => {
  let resolveReleases;
  const releaseLimits = [];
  const candidateLimits = [];
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    {
      claimDue: ({ limit }) => {
        releaseLimits.push(limit);
        return new Promise((resolve) => {
          resolveReleases = resolve;
        });
      },
      rescheduleDue: async () => {},
    },
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [],
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async () => {},
    },
    { claimDue: async () => [], findDispatchable: async () => null },
    { execute: async () => {}, prepareMedia: async () => {} },
    {
      findUnreleased: async (_network, limit) => {
        candidateLimits.push(limit);
        return [];
      },
    },
    { dispatch: async () => {}, check: async () => {} },
    { next: async () => null },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    { run: async (operation) => operation({}) },
  );
  const scheduler = new NftRpcScheduler({ readRps: 5, sendIntervalMs: 1200 });
  const releaseScan = runtime.scan(scheduler);
  await flushMicrotasks();
  await runtime.scanCandidates(scheduler);
  assert.deepEqual(releaseLimits, [20]);
  assert.deepEqual(candidateLimits, []);
  resolveReleases([]);
  await releaseScan;
});

test('typed provider retry metadata honors service-credit five minute delay', async () => {
  let scheduled;
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    {
      claimDue: async () => [
        {
          releaseId: 'release',
          seasonId: 'season',
          state: 'PREPARING',
          stage: 'METADATA',
          retryCount: 0,
        },
      ],
      rescheduleDue: async (value) => {
        scheduled = value;
      },
    },
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [],
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async () => {},
    },
    { claimDue: async () => [], findDispatchable: async () => null },
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    { dispatch: async () => {}, check: async () => {} },
    {
      next: async () => {
        throw new NftOperationRetryError('credits', {
          reason: 'STORAGE_CREDITS',
          retryAfterMs: 60_000,
        });
      },
    },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    { run: async (operation) => operation({}) },
  );
  await runtime.scan(new NftRpcScheduler({ readRps: 5, sendIntervalMs: 1200 }));
  for (let index = 0; index < 20 && !scheduled; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(scheduled.retryDelayMs >= 300_000);
});

test('typed permanent provider failure blocks a release instead of retrying forever', async () => {
  let blocked;
  let rescheduled = 0;
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    {
      claimDue: async () => [
        {
          releaseId: 'release',
          seasonId: 'season',
          state: 'PREPARING',
          stage: 'METADATA',
          version: 7n,
          retryCount: 0,
        },
      ],
      rescheduleDue: async () => {
        rescheduled += 1;
      },
      findChainSource: async () => ({ version: 7n }),
      block: async (value) => {
        blocked = value;
        return { updated: true };
      },
    },
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [],
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async () => {},
    },
    { claimDue: async () => [], findDispatchable: async () => null },
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    { dispatch: async () => {}, check: async () => {} },
    {
      next: async () => {
        throw new NftOperationPermanentError(
          'NFT_CHAIN_CONFIGURATION_INVALID',
          'configuration mismatch',
        );
      },
    },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    { run: async (operation) => operation({}) },
  );
  await runtime.scan(new NftRpcScheduler({ readRps: 5, sendIntervalMs: 1200 }));
  for (let index = 0; index < 20 && !blocked; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(blocked.expectedVersion, 7n);
  assert.equal(blocked.errorCode, 'NFT_CHAIN_CONFIGURATION_INVALID');
  assert.equal(rescheduled, 0);
});

test('identity version advance still persists a following wrong-owner failure as BLOCKED', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const releases = new SeasonNftRepository(pool, runner);
  const seeded = await seedNetworkQueueRows(pool, 'devnet');
  await pool.query(
    `UPDATE season_nft_releases
     SET state = 'PREPARING', stage = 'METADATA', asset_name = 'Season',
         metadata_uri = 'https://example.invalid/metadata', eligible_count = 1,
         merkle_root = $2, next_attempt_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [seeded.releaseId, Buffer.alloc(32, 4)],
  );
  const collectionAddress = bs58.encode(randomBytes(32));
  const machineAddress = bs58.encode(randomBytes(32));
  const guardAddress = bs58.encode(randomBytes(32));
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    releases,
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [],
    },
    { claimDue: async () => [], findDispatchable: async () => null },
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    { dispatch: async () => {}, check: async () => {} },
    {
      next: async (releaseId) => {
        const source = await releases.findChainSource(releaseId);
        const stored = await releases.recordPreparationIdentity({
          releaseId,
          expectedVersion: source.version,
          collectionAddress,
          candyMachineAddress: machineAddress,
          candyGuardAddress: guardAddress,
          preparationKeys: {
            [collectionAddress]: `devnet/${releaseId}/collection.json`,
            [machineAddress]: `devnet/${releaseId}/machine.json`,
          },
        });
        assert.equal(stored.updated, true);
        return {
          kind: 'RELEASE_PREPARE',
          rpcType: 'READ',
          run: async () => {
            throw new NftOperationPermanentError(
              'NFT_CHAIN_ACCOUNT_INVALID',
              'wrong program owner',
            );
          },
        };
      },
    },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    runner,
  );

  await runtime.scan(new NftRpcScheduler({ readRps: 5, sendIntervalMs: 1200 }));
  let blocked;
  for (let index = 0; index < 40 && !blocked; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    blocked = (
      await pool.query(
        `SELECT state, version, last_error_code, preparation_keys
         FROM season_nft_releases WHERE id = $1`,
        [seeded.releaseId],
      )
    ).rows[0];
    if (blocked.state !== 'BLOCKED') blocked = undefined;
  }

  assert.equal(blocked.state, 'BLOCKED');
  assert.equal(blocked.version, '2');
  assert.equal(blocked.last_error_code, 'NFT_CHAIN_ACCOUNT_INVALID');
  assert.deepEqual(blocked.preparation_keys, {
    [collectionAddress]: `devnet/${seeded.releaseId}/collection.json`,
    [machineAddress]: `devnet/${seeded.releaseId}/machine.json`,
  });
  await pool.query('DELETE FROM season_nft_claims WHERE id = $1', [
    seeded.claimId,
  ]);
});

test('stalled receipt lookup receives the RPC abort signal and is durably rescheduled', async () => {
  let scheduled;
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    { claimDue: async () => [], rescheduleDue: async () => {} },
    {
      claimDueAttempts: async () => [],
      claimDueReceipts: async () => [{ claimId: 'claim', retryCount: 0 }],
      rescheduleAttempt: async () => {},
      rescheduleReceipt: async (value) => {
        scheduled = value;
      },
    },
    { claimDue: async () => [], findDispatchable: async () => null },
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    { dispatch: async () => {}, check: async () => {} },
    { next: async () => null },
    { next: async () => null },
    {
      lookup: async (_claimId, signal) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    },
    { run: async (operation) => operation({}) },
  );
  await runtime.scan(
    new NftRpcScheduler({
      readRps: 5,
      sendIntervalMs: 1200,
      rpcTimeoutMs: 10,
    }),
  );
  for (let index = 0; index < 50 && !scheduled; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(scheduled.claimId, 'claim');
  assert.ok(scheduled.retryDelayMs >= 5_000);
});

async function seedNetworkQueueRows(pool, network) {
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const address = bs58.encode(randomBytes(32));
  const walletId = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
     VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [userId, address],
    )
  ).rows[0].id;
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 1,
             CURRENT_TIMESTAMP - interval '2 days', CURRENT_TIMESTAMP - interval '1 day')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Worker queue fixture', 2)`,
    [seasonId, userId],
  );
  const releaseId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_releases (id, season_id, network, state, stage)
     VALUES ($1, $2, $3, 'WAITING_SNAPSHOT', 'SNAPSHOT')`,
    [releaseId, seasonId, network],
  );
  const claimId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, receipt_state, receipt_next_check_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'CLAIMED', '[]'::jsonb,
             'RESOLVING', CURRENT_TIMESTAMP)`,
    [claimId, releaseId, network, userId, walletId, address],
  );
  return { releaseId, claimId };
}

test('claim and receipt due scans stay inside the configured network', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const devnet = await seedNetworkQueueRows(pool, 'devnet');
  const mainnet = await seedNetworkQueueRows(pool, 'mainnet-beta');
  const due = await claims.claimDueReceipts({
    network: 'devnet',
    limit: 100,
    claimDurationMs: 10_000,
  });
  assert.deepEqual(
    due.map(({ claimId }) => claimId),
    [devnet.claimId],
  );
  const untouched = await pool.query(
    'SELECT receipt_next_check_at <= CURRENT_TIMESTAMP AS due FROM season_nft_claims WHERE id = $1',
    [mainnet.claimId],
  );
  assert.equal(untouched.rows[0].due, true);
});

test('ambiguous SIGNED outcome durably reschedules without a state transition', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const repository = new NftTransactionRepository(pool, runner);
  const { releaseId } = await seedNetworkQueueRows(pool, 'devnet');
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, operation_key, kind, state, message_hash,
        serialized_transaction, signature, recent_blockhash, last_valid_block_height)
     VALUES ($1, 'devnet', $2, 'setup:collection:0', 'SETUP_COLLECTION',
             'SIGNED', $3, $4, 'persisted-signature', 'blockhash', 100)`,
    [
      transactionId,
      releaseId,
      'a'.repeat(64),
      Buffer.from('exact-signed-bytes'),
    ],
  );
  await repository.recordDispatchOutcome({
    transactionId,
    expectedState: 'SIGNED',
    state: 'SIGNED',
    errorCode: 'NFT_RPC_AMBIGUOUS',
    nextCheckDelayMs: 60_000,
  });
  const row = (
    await pool.query(
      `SELECT state, serialized_transaction, signature, last_error_code,
            next_check_at >= statement_timestamp() + interval '59 seconds'
              AS rescheduled
     FROM season_nft_transactions WHERE id = $1`,
      [transactionId],
    )
  ).rows[0];
  assert.equal(row.state, 'SIGNED');
  assert.deepEqual(
    row.serialized_transaction,
    Buffer.from('exact-signed-bytes'),
  );
  assert.equal(row.signature, 'persisted-signature');
  assert.equal(row.last_error_code, 'NFT_RPC_AMBIGUOUS');
  assert.equal(row.rescheduled, true);
});

test('runtime does not resend SIGNED bytes when inspection defers with Retry-After', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const releases = new SeasonNftRepository(pool, runner);
  const nftTransactions = new NftTransactionRepository(pool, runner);
  const seeded = await seedNetworkQueueRows(pool, 'devnet');
  await pool.query(
    `UPDATE season_nft_releases SET next_attempt_at = CURRENT_TIMESTAMP + interval '1 hour'
     WHERE id = $1`,
    [seeded.releaseId],
  );
  await pool.query(
    `UPDATE season_nft_claims SET receipt_next_check_at = CURRENT_TIMESTAMP + interval '1 hour'
     WHERE id = $1`,
    [seeded.claimId],
  );
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, operation_key, kind, state, message_hash,
        serialized_transaction, signature, recent_blockhash, last_valid_block_height)
     VALUES ($1, 'devnet', $2, 'setup:collection:0', 'SETUP_COLLECTION',
             'SIGNED', $3, $4, 'retry-after-signature', 'blockhash', 100)`,
    [
      transactionId,
      seeded.releaseId,
      'c'.repeat(64),
      Buffer.from('retry-after-bytes'),
    ],
  );
  let sends = 0;
  const dispatcher = new NftTransactionDispatcher(nftTransactions, {
    sendSignedTransaction: async () => {
      sends += 1;
      return 'retry-after-signature';
    },
    inspectTransactions: async () => {
      throw new NftOperationRetryError('rate limited', {
        reason: 'RATE_LIMITED',
        retryAfterMs: 60_000,
      });
    },
  });
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    releases,
    claims,
    nftTransactions,
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    dispatcher,
    { next: async () => null },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    runner,
  );
  const startedAt = Date.now();
  await runtime.scan(new NftRpcScheduler({ readRps: 5, sendIntervalMs: 1200 }));
  let persisted;
  for (let index = 0; index < 50; index += 1) {
    persisted = (
      await pool.query(
        `SELECT state, retry_count, last_error_code, next_check_at
         FROM season_nft_transactions WHERE id = $1`,
        [transactionId],
      )
    ).rows[0];
    if (persisted.last_error_code === 'NFT_RPC_RETRY') break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(sends, 0);
  assert.equal(persisted.state, 'SIGNED');
  assert.equal(persisted.retry_count, 1);
  assert.ok(persisted.next_check_at.getTime() >= startedAt + 60_000);
});

test('attempt retry count persists and drives escalating restart backoff', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const seeded = await seedNetworkQueueRows(pool, 'devnet');
  await pool.query(
    `UPDATE season_nft_claims
     SET state = 'UNCLAIMED', receipt_state = 'NONE', receipt_next_check_at = NULL
     WHERE id = $1`,
    [seeded.claimId],
  );
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, 'QUEUED', 'ALLOWLIST_PROOF')`,
    [attemptId, seeded.claimId],
  );
  for (let index = 0; index < 2; index += 1) {
    await claims.rescheduleAttempt({
      attemptId,
      claimId: seeded.claimId,
      retryDelayMs: 0,
      errorCode: 'NFT_BUILD_RETRY',
    });
  }
  const due = await claims.claimDueAttempts({
    network: 'devnet',
    limit: 100,
    claimDurationMs: 10_000,
  });
  assert.equal(due.find((row) => row.attemptId === attemptId).retryCount, 2);
});

test('all worker queues use the database clock for claims and retry delays', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const releases = new SeasonNftRepository(pool, runner);
  const nftTransactions = new NftTransactionRepository(pool, runner);
  const receiptSeed = await seedNetworkQueueRows(pool, 'devnet');
  const attemptSeed = await seedNetworkQueueRows(pool, 'devnet');
  await pool.query(
    `UPDATE season_nft_claims
     SET state = 'UNCLAIMED', receipt_state = 'NONE', receipt_next_check_at = NULL
     WHERE id = $1`,
    [attemptSeed.claimId],
  );
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, 'QUEUED', 'ALLOWLIST_PROOF')`,
    [attemptId, attemptSeed.claimId],
  );
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, operation_key, kind, state, message_hash,
        serialized_transaction, signature, recent_blockhash, last_valid_block_height)
     VALUES ($1, 'devnet', $2, 'setup:collection:0', 'SETUP_COLLECTION',
             'SIGNED', $3, $4, 'clock-signature', 'blockhash', 100)`,
    [
      transactionId,
      receiptSeed.releaseId,
      'd'.repeat(64),
      Buffer.from('clock-skew-bytes'),
    ],
  );
  await pool.query(
    `UPDATE season_nft_releases
     SET next_attempt_at = statement_timestamp() - interval '1 second'
     WHERE id IN ($1, $2)`,
    [receiptSeed.releaseId, attemptSeed.releaseId],
  );
  await pool.query(
    `UPDATE season_nft_claims
     SET receipt_next_check_at = statement_timestamp() - interval '1 second'
     WHERE id = $1`,
    [receiptSeed.claimId],
  );
  await pool.query(
    `UPDATE season_nft_claim_attempts
     SET next_attempt_at = statement_timestamp() - interval '1 second'
     WHERE id = $1`,
    [attemptId],
  );
  await pool.query(
    `UPDATE season_nft_transactions
     SET next_check_at = statement_timestamp() - interval '1 second'
     WHERE id = $1`,
    [transactionId],
  );

  const originalNow = Date.now;
  try {
    Date.now = () => 0;
    const [
      claimedReleases,
      claimedAttempts,
      claimedReceipts,
      claimedTransactions,
    ] = await Promise.all([
      releases.claimDue({
        network: 'devnet',
        limit: 10,
        claimDurationMs: 10_000,
      }),
      claims.claimDueAttempts({
        network: 'devnet',
        limit: 10,
        claimDurationMs: 10_000,
      }),
      claims.claimDueReceipts({
        network: 'devnet',
        limit: 10,
        claimDurationMs: 10_000,
      }),
      nftTransactions.claimDue({
        network: 'devnet',
        limit: 10,
        claimDurationMs: 10_000,
      }),
    ]);
    const releaseIds = claimedReleases.map(({ releaseId }) => releaseId);
    assert.equal(
      releaseIds.filter((id) => id === receiptSeed.releaseId).length,
      1,
    );
    assert.equal(
      releaseIds.filter((id) => id === attemptSeed.releaseId).length,
      1,
    );
    assert.equal(
      claimedAttempts.filter(({ attemptId: id }) => id === attemptId).length,
      1,
    );
    assert.equal(
      claimedReceipts.filter(({ claimId }) => claimId === receiptSeed.claimId)
        .length,
      1,
    );
    assert.equal(
      claimedTransactions.filter(({ id }) => id === transactionId).length,
      1,
    );

    Date.now = () => 4_102_444_800_000;
    await releases.rescheduleDue({
      releaseId: receiptSeed.releaseId,
      retryDelayMs: 20_000,
      errorCode: 'CLOCK_TEST',
    });
    await claims.rescheduleAttempt({
      attemptId,
      claimId: attemptSeed.claimId,
      retryDelayMs: 20_000,
      errorCode: 'CLOCK_TEST',
    });
    await claims.rescheduleReceipt({
      claimId: receiptSeed.claimId,
      retryDelayMs: 20_000,
    });
    await nftTransactions.recordDispatchOutcome({
      transactionId,
      expectedState: 'SIGNED',
      state: 'SIGNED',
      nextCheckDelayMs: 20_000,
    });
  } finally {
    Date.now = originalNow;
  }

  const deadlines = (
    await pool.query(
      `SELECT
         extract(epoch FROM (r.next_attempt_at - statement_timestamp())) * 1000
           AS release_ms,
         extract(epoch FROM (a.next_attempt_at - statement_timestamp())) * 1000
           AS attempt_ms,
         extract(epoch FROM (c.receipt_next_check_at - statement_timestamp())) * 1000
           AS receipt_ms,
         extract(epoch FROM (t.next_check_at - statement_timestamp())) * 1000
           AS transaction_ms
       FROM season_nft_releases r
       JOIN season_nft_claim_attempts a ON a.id = $2
       JOIN season_nft_claims c ON c.id = $3
       JOIN season_nft_transactions t ON t.id = $4
       WHERE r.id = $1`,
      [receiptSeed.releaseId, attemptId, receiptSeed.claimId, transactionId],
    )
  ).rows[0];
  for (const remaining of Object.values(deadlines).map(Number)) {
    assert.ok(remaining >= 18_000 && remaining <= 20_500, String(remaining));
  }
});

test('fresh runtime recovers due release, SIGNED transaction, and receipt-only claim from DB', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const releases = new SeasonNftRepository(pool, runner);
  const nftTransactions = new NftTransactionRepository(pool, runner);
  const seeded = await seedNetworkQueueRows(pool, 'devnet');
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, operation_key, kind, state, message_hash,
        serialized_transaction, signature, recent_blockhash, last_valid_block_height)
     VALUES ($1, 'devnet', $2, 'setup:collection:0', 'SETUP_COLLECTION',
             'SIGNED', $3, $4, 'recovery-signature', 'blockhash', 100)`,
    [
      transactionId,
      seeded.releaseId,
      'b'.repeat(64),
      Buffer.from('recovery-bytes'),
    ],
  );
  const prepared = [];
  let checked = 0;
  let sent = 0;
  const receiptLookups = [];
  const receiptSignals = [];
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    releases,
    claims,
    nftTransactions,
    {
      execute: async (seasonId) => {
        prepared.push(seasonId);
      },
      prepareMedia: async () => {},
    },
    { findUnreleased: async () => [] },
    {
      check: async (ids) => {
        checked += 1;
        return ids.map((transactionId) => ({
          transactionId,
          resendSigned: true,
        }));
      },
      dispatch: async () => {
        sent += 1;
      },
    },
    { next: async () => null },
    { next: async () => null },
    {
      lookup: async (claimId, signal) => {
        receiptLookups.push(claimId);
        receiptSignals.push(signal);
        return { status: 'PENDING' };
      },
    },
    runner,
  );
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  await runtime.scan(scheduler);
  for (let index = 0; index < 20 && sent === 0; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const seededSeason = await pool.query(
    'SELECT season_id FROM season_nft_releases WHERE id = $1',
    [seeded.releaseId],
  );
  assert.ok(prepared.includes(seededSeason.rows[0].season_id));
  assert.equal(checked, 1);
  assert.equal(sent, 1);
  assert.ok(receiptLookups.includes(seeded.claimId));
  assert.ok(receiptSignals.every((signal) => signal instanceof AbortSignal));
  const attemptCount = await pool.query(
    'SELECT count(*)::int AS count FROM season_nft_claim_attempts WHERE claim_id = $1',
    [seeded.claimId],
  );
  assert.equal(attemptCount.rows[0].count, 0);
});
