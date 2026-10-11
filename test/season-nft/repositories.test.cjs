const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const appConfig = require('../../dist/config/app.config').default;
const { NestFactory } = require('@nestjs/core');
const bs58 = require('bs58').default;
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const {
  getPgExecutor,
} = require('../../dist/database/transaction/pg-executor');
const {
  TransactionRunner,
} = require('../../dist/database/transaction/transaction-runner');
const {
  ClaimRepository,
} = require('../../dist/modules/season-nfts/resources/claim/claim.repository');
const {
  NftUploadRepository,
} = require('../../dist/modules/season-nfts/resources/nft-media/nft-upload.repository');
const {
  NftTransactionRepository,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction.repository');
const {
  SeasonNftRepository,
} = require('../../dist/modules/season-nfts/resources/season-nft/season-nft.repository');
const {
  SeasonNftsModule,
} = require('../../dist/modules/season-nfts/season-nfts.module');
const {
  CanvasSnapshotRepository,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/canvas-snapshot.repository');

let fixturePromise;

async function fixture() {
  fixturePromise ??= (async () => {
    const database = await testDatabaseModule();
    class RepositoryTestModule {}
    Module({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [appConfig] }),
        database.module,
        SeasonNftsModule,
      ],
    })(RepositoryTestModule);
    const app = await NestFactory.createApplicationContext(
      RepositoryTestModule,
      { logger: false, abortOnError: false },
    );
    return {
      app,
      pool: database.pool,
      transactions: app.get(TransactionRunner),
      claims: app.get(ClaimRepository),
      releases: app.get(SeasonNftRepository),
      nftTransactions: app.get(NftTransactionRepository),
      uploads: app.get(NftUploadRepository),
    };
  })();
  return fixturePromise;
}

test.after(async () => {
  const current = await fixturePromise;
  await current?.app.close();
});

async function insertUserWallet(pool) {
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const walletAddress = bs58.encode(randomBytes(32));
  const walletAccountId = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [userId, walletAddress],
    )
  ).rows[0].id;
  return { userId, walletAccountId, walletAddress };
}

async function insertSeason(pool, creatorId) {
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 1,
             CURRENT_TIMESTAMP - interval '2 days',
             CURRENT_TIMESTAMP - interval '1 day')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Repository test season', 2)`,
    [seasonId, creatorId],
  );
  return seasonId;
}

async function insertSnapshot(pool, seasonId) {
  const snapshotId = randomUUID();
  const directory = `snapshots/seasons/${seasonId}/${snapshotId}`;
  await pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 0, 'repository-test', 1000, 1000, 'READY', true,
             $3, $4, 1, 1, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `${directory}/image.png`,
      `${directory}/continuation.json`,
      'a'.repeat(64),
    ],
  );
  return snapshotId;
}

async function insertRelease(pool, seasonId, network = 'devnet') {
  const releaseId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage)
     VALUES ($1, $2, $3, 'WAITING_SNAPSHOT', 'SNAPSHOT')`,
    [releaseId, seasonId, network],
  );
  return releaseId;
}

async function insertClaim(pool, releaseId, actor, network = 'devnet') {
  const claimId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, receipt_state)
     VALUES ($1, $2, $3, $4, $5, $6, 'UNCLAIMED', '[]'::jsonb, 'NONE')`,
    [
      claimId,
      releaseId,
      network,
      actor.userId,
      actor.walletAccountId,
      actor.walletAddress,
    ],
  );
  return claimId;
}

async function insertFreezeEligibility(pool, seasonId, actor) {
  await pool.query(
    `INSERT INTO season_participants
       (season_id, user_id, wallet_account_id, wallet_address)
     VALUES ($1, $2, $3, $4)`,
    [seasonId, actor.userId, actor.walletAccountId, actor.walletAddress],
  );
  await pool.query(
    `INSERT INTO canvas_stroke_usages
       (canvas_id, user_id, client_stroke_id)
     VALUES ($1, $2, $3)`,
    [seasonId, actor.userId, randomUUID()],
  );
}

function freezeEligibility(actor) {
  return [
    {
      userId: actor.userId,
      participantUserId: actor.userId,
      walletAccountId: actor.walletAccountId,
      walletAddress: actor.walletAddress,
      verifiedWalletId: actor.walletAccountId,
      walletUserId: actor.userId,
      verifiedAddress: actor.walletAddress,
      chainNamespace: 'solana',
    },
  ];
}

async function insertAttempt(
  pool,
  claimId,
  state = 'QUEUED',
  step = 'ALLOWLIST_PROOF',
) {
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, $3, $4)`,
    [attemptId, claimId, state, step],
  );
  return attemptId;
}

async function seedClaim() {
  const { pool } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  const releaseId = await insertRelease(pool, seasonId);
  const claimId = await insertClaim(pool, releaseId, actor);
  return { actor, seasonId, releaseId, claimId };
}

function createBarrier(size) {
  let count = 0;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  return async () => {
    count += 1;
    if (count === size) release();
    await ready;
  };
}

test('disabled SeasonNftsModule boot registers repositories without network I/O', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error('Network I/O is disabled in repository tests.');
  };
  try {
    const current = await fixture();
    assert.ok(current.releases);
    assert.ok(current.claims);
    assert.ok(current.nftTransactions);
    assert.ok(current.uploads);
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('two real connections return one active attempt for the same claim', async () => {
  const { pool, transactions, claims } = await fixture();
  const { claimId } = await seedClaim();
  const barrier = createBarrier(2);
  const backendPids = [];
  const create = () =>
    transactions.run(async (transaction) => {
      const pid = await getPgExecutor(pool, transaction).query(
        'SELECT pg_backend_pid() AS pid',
      );
      backendPids.push(pid.rows[0].pid);
      await barrier();
      return claims.getOrCreateAttempt({ claimId }, transaction);
    });
  const results = await Promise.all([create(), create()]);
  assert.equal(new Set(backendPids).size, 2);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(results[0].attemptId, results[1].attemptId);
  assert.equal(results[0].claimState, 'PROCESSING');
  assert.equal(results[0].attemptState, 'QUEUED');
  const rows = await pool.query(
    `SELECT state FROM season_nft_claim_attempts WHERE claim_id = $1`,
    [claimId],
  );
  assert.deepEqual(rows.rows, [{ state: 'QUEUED' }]);
});

test('findOwnClaim requires the authenticated user and exact participant wallet', async () => {
  const { transactions, claims } = await fixture();
  const seeded = await seedClaim();
  const owned = await transactions.run((transaction) =>
    claims.findOwnClaim(
      { releaseId: seeded.releaseId, ...seeded.actor },
      transaction,
    ),
  );
  const wrongWallet = await transactions.run((transaction) =>
    claims.findOwnClaim(
      {
        releaseId: seeded.releaseId,
        ...seeded.actor,
        walletAddress: bs58.encode(randomBytes(32)),
      },
      transaction,
    ),
  );
  assert.equal(owned.id, seeded.claimId);
  assert.equal(owned.state, 'UNCLAIMED');
  assert.equal(wrongWallet, null);
});

test('CLAIMED is monotonic and receipt evidence completes without a new attempt', async () => {
  const { pool, transactions, claims } = await fixture();
  const { claimId } = await seedClaim();
  const attempt = await transactions.run((transaction) =>
    claims.getOrCreateAttempt({ claimId }, transaction),
  );
  const resolving = await transactions.run((transaction) =>
    claims.completeClaim(
      { claimId, attemptId: attempt.attemptId, receiptState: 'RESOLVING' },
      transaction,
    ),
  );
  assert.deepEqual(resolving, { updated: true });
  const repeated = await transactions.run((transaction) =>
    claims.getOrCreateAttempt({ claimId }, transaction),
  );
  assert.deepEqual(repeated, {
    created: false,
    claimState: 'CLAIMED',
    attemptId: null,
    attemptState: null,
  });
  const assetAddress = bs58.encode(randomBytes(32));
  const verified = await transactions.run((transaction) =>
    claims.completeClaim(
      {
        claimId,
        attemptId: attempt.attemptId,
        receiptState: 'VERIFIED',
        assetAddress,
        mintSignature: bs58.encode(randomBytes(64)),
        claimedAt: new Date(),
      },
      transaction,
    ),
  );
  assert.deepEqual(verified, { updated: true });
  const row = (
    await pool.query(
      `SELECT state, receipt_state, receipt_next_check_at, asset_address
       FROM season_nft_claims WHERE id = $1`,
      [claimId],
    )
  ).rows[0];
  assert.equal(row.state, 'CLAIMED');
  assert.equal(row.receipt_state, 'VERIFIED');
  assert.equal(row.receipt_next_check_at, null);
  assert.equal(row.asset_address, assetAddress);
});

test('receipt recovery reaches CLAIMED and VERIFIED with no attempt rows', async () => {
  const { pool, transactions, claims } = await fixture();
  const { claimId } = await seedClaim();
  assert.deepEqual(
    await transactions.run((transaction) =>
      claims.completeClaim({ claimId, receiptState: 'RESOLVING' }, transaction),
    ),
    { updated: true },
  );
  const assetAddress = bs58.encode(randomBytes(32));
  assert.deepEqual(
    await transactions.run((transaction) =>
      claims.completeClaim(
        {
          claimId,
          receiptState: 'VERIFIED',
          assetAddress,
          mintSignature: bs58.encode(randomBytes(64)),
          claimedAt: new Date(),
        },
        transaction,
      ),
    ),
    { updated: true },
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT state, receipt_state,
                (SELECT count(*)::integer FROM season_nft_claim_attempts
                 WHERE claim_id = $1) AS attempts
         FROM season_nft_claims WHERE id = $1`,
        [claimId],
      )
    ).rows[0],
    { state: 'CLAIMED', receipt_state: 'VERIFIED', attempts: 0 },
  );
});

test('attempt failure uses expected-state CAS and only reopens non-CLAIMED claims', async () => {
  const { pool, transactions, claims } = await fixture();
  const { claimId } = await seedClaim();
  const attempt = await transactions.run((transaction) =>
    claims.getOrCreateAttempt({ claimId }, transaction),
  );
  const first = await transactions.run((transaction) =>
    claims.failAttempt(
      {
        claimId,
        attemptId: attempt.attemptId,
        expectedState: 'QUEUED',
        state: 'FAILED',
        errorCode: 'NFT_TEST_FAILURE',
      },
      transaction,
    ),
  );
  const stale = await transactions.run((transaction) =>
    claims.failAttempt(
      {
        claimId,
        attemptId: attempt.attemptId,
        expectedState: 'QUEUED',
        state: 'FAILED',
        errorCode: 'NFT_STALE_FAILURE',
      },
      transaction,
    ),
  );
  assert.deepEqual(first, { updated: true });
  assert.deepEqual(stale, { updated: false });
  assert.equal(
    (
      await pool.query('SELECT state FROM season_nft_claims WHERE id = $1', [
        claimId,
      ])
    ).rows[0].state,
    'UNCLAIMED',
  );
});

test('a historical terminal attempt cannot reopen a claim with a newer active attempt', async () => {
  const { pool, transactions, claims } = await fixture();
  const { claimId } = await seedClaim();
  const historical = await insertAttempt(pool, claimId, 'FAILED');
  const active = await transactions.run((transaction) =>
    claims.getOrCreateAttempt({ claimId }, transaction),
  );
  const stale = await transactions.run((transaction) =>
    claims.failAttempt(
      {
        claimId,
        attemptId: historical,
        expectedState: 'FAILED',
        state: 'FAILED',
        errorCode: 'NFT_HISTORICAL_FAILURE',
      },
      transaction,
    ),
  );
  assert.deepEqual(stale, { updated: false });
  assert.deepEqual(
    (
      await pool.query(
        `SELECT c.state AS claim_state, a.state AS attempt_state
         FROM season_nft_claims c
         JOIN season_nft_claim_attempts a ON a.claim_id = c.id
         WHERE c.id = $1 AND a.id = $2`,
        [claimId, active.attemptId],
      )
    ).rows[0],
    { claim_state: 'PROCESSING', attempt_state: 'QUEUED' },
  );
});

test('release freeze is atomic and stale expectedVersion cannot overwrite frozen values', async () => {
  const { pool, transactions, releases } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  await insertFreezeEligibility(pool, seasonId, actor);
  const snapshotId = await insertSnapshot(pool, seasonId);
  const seasonEndedAt = (
    await pool.query('SELECT ends_at FROM canvases WHERE id = $1', [seasonId])
  ).rows[0].ends_at;
  const candidate = await transactions.run((transaction) =>
    releases.insertCandidate({ seasonId, network: 'devnet' }, transaction),
  );
  const claimId = randomUUID();
  const frozen = await transactions.run((transaction) =>
    releases.freeze(
      {
        releaseId: candidate.releaseId,
        expectedVersion: 0n,
        snapshotId,
        throughSequence: 0n,
        imageByteLength: 1n,
        imageSha256: 'a'.repeat(64),
        frozenTitle: 'Repository test season',
        frozenDescription: null,
        seasonEndedAt,
        eligibilityRows: freezeEligibility(actor),
        merkleRoot: randomBytes(32),
        claims: [
          {
            id: claimId,
            userId: actor.userId,
            walletAccountId: actor.walletAccountId,
            walletAddress: actor.walletAddress,
            merkleProof: [],
          },
        ],
      },
      transaction,
    ),
  );
  const stale = await transactions.run((transaction) =>
    releases.freeze(
      {
        releaseId: candidate.releaseId,
        expectedVersion: 0n,
        snapshotId,
        throughSequence: 0n,
        frozenTitle: 'Repository test season',
        frozenDescription: null,
        seasonEndedAt,
        merkleRoot: randomBytes(32),
        claims: [],
      },
      transaction,
    ),
  );
  assert.deepEqual(frozen, { updated: true });
  assert.deepEqual(stale, { updated: false });
  const release = (
    await pool.query(
      `SELECT state, stage, frozen_title, eligible_count, version
       FROM season_nft_releases WHERE id = $1`,
      [candidate.releaseId],
    )
  ).rows[0];
  assert.deepEqual(release, {
    state: 'PREPARING',
    stage: 'FROZEN',
    frozen_title: 'Repository test season',
    eligible_count: 1,
    version: '1',
  });
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer AS count FROM season_nft_claims WHERE release_id = $1',
        [candidate.releaseId],
      )
    ).rows[0].count,
    1,
  );
});

test('release freeze blocks a source that is no longer ended at commit time', async () => {
  const { pool, transactions, releases } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  await insertFreezeEligibility(pool, seasonId, actor);
  const snapshotId = await insertSnapshot(pool, seasonId);
  const candidate = await transactions.run((transaction) =>
    releases.insertCandidate({ seasonId, network: 'devnet' }, transaction),
  );
  const futureEnd = (
    await pool.query(
      `UPDATE canvases SET ends_at = CURRENT_TIMESTAMP + interval '1 day'
       WHERE id = $1 RETURNING ends_at`,
      [seasonId],
    )
  ).rows[0].ends_at;

  const blocked = await transactions.run((transaction) =>
    releases.freeze(
      {
        releaseId: candidate.releaseId,
        expectedVersion: candidate.version,
        snapshotId,
        throughSequence: 0n,
        imageByteLength: 1n,
        imageSha256: 'a'.repeat(64),
        frozenTitle: 'Repository test season',
        frozenDescription: null,
        seasonEndedAt: futureEnd,
        eligibilityRows: freezeEligibility(actor),
        merkleRoot: randomBytes(32),
        claims: [
          {
            userId: actor.userId,
            walletAccountId: actor.walletAccountId,
            walletAddress: actor.walletAddress,
            merkleProof: [],
          },
        ],
      },
      transaction,
    ),
  );
  const release = (
    await pool.query(
      `SELECT state, stage, snapshot_id, last_error_code
       FROM season_nft_releases WHERE id = $1`,
      [candidate.releaseId],
    )
  ).rows[0];

  assert.deepEqual(blocked, { updated: true, reason: 'BLOCKED' });
  assert.deepEqual(release, {
    state: 'BLOCKED',
    stage: 'SNAPSHOT',
    snapshot_id: null,
    last_error_code: 'NFT_SOURCE_INELIGIBLE',
  });
});

test('final snapshot publication and release freeze share season-first lock order', async () => {
  const { pool, transactions, releases } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  await insertFreezeEligibility(pool, seasonId, actor);
  const season = (
    await pool.query(
      `SELECT width, height, stroke_limit_per_user, starts_at, ends_at
       FROM canvases WHERE id = $1`,
      [seasonId],
    )
  ).rows[0];
  const candidate = await transactions.run((transaction) =>
    releases.insertCandidate({ seasonId, network: 'devnet' }, transaction),
  );
  const snapshotId = randomUUID();
  const directory = `snapshots/seasons/${seasonId}/${snapshotId}`;
  const publishInput = {
    id: snapshotId,
    target: {
      id: seasonId,
      key: `season:${seasonId.toLowerCase()}`,
      kind: 'season',
      width: season.width,
      height: season.height,
      strokeLimitPerUser: season.stroke_limit_per_user,
      startsAt: season.starts_at,
      endsAt: season.ends_at,
    },
    throughSequence: '0',
    rendererVersion: 'lock-order-test',
    isFinal: true,
    imageKey: `${directory}/image.png`,
    continuationKey: `${directory}/continuation.json`,
    imageBytes: 1,
    continuationBytes: 1,
    imageSha256: 'a'.repeat(64),
    continuationSha256: 'b'.repeat(64),
    continuationSchemaVersion: 1,
    capturedAt: new Date(),
  };

  let releasePublisher;
  const publisherPaused = new Promise((resolve) => {
    releasePublisher = resolve;
  });
  let firstPublisherLock;
  let resumePublisher;
  const publisherMayContinue = new Promise((resolve) => {
    resumePublisher = resolve;
  });
  const backendPids = [];
  const publisherTransactions = {
    run: (work, options) =>
      transactions.run(async (transaction) => {
        const executor = getPgExecutor(pool, transaction);
        backendPids.push(
          (await executor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        );
        const originalQuery = executor.query;
        executor.query = async function (...args) {
          const result = await originalQuery.apply(this, args);
          const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
          const seasonLock =
            sql.includes('FROM seasons') && sql.includes('FOR UPDATE');
          const canvasLock =
            sql.includes('FROM canvases') && sql.includes('FOR UPDATE');
          if (!firstPublisherLock && (seasonLock || canvasLock)) {
            firstPublisherLock = seasonLock ? 'season' : 'canvas';
            releasePublisher();
            await publisherMayContinue;
          }
          return result;
        };
        try {
          return await work(transaction);
        } finally {
          executor.query = originalQuery;
        }
      }, options),
  };
  const snapshots = new CanvasSnapshotRepository(pool, publisherTransactions);
  const published = snapshots.publish(publishInput);
  await publisherPaused;

  let reportFreezeSeasonLockIssued;
  const freezeSeasonLockIssued = new Promise((resolve) => {
    reportFreezeSeasonLockIssued = resolve;
  });
  let reportFreezeSeasonLockAcquired;
  const freezeSeasonLockAcquired = new Promise((resolve) => {
    reportFreezeSeasonLockAcquired = resolve;
  });
  let resumeFreeze;
  const freezeMayContinue = new Promise((resolve) => {
    resumeFreeze = resolve;
  });
  const frozen = transactions.run(async (transaction) => {
    const executor = getPgExecutor(pool, transaction);
    backendPids.push(
      (await executor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
    );
    const originalQuery = executor.query;
    executor.query = async function (...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
      if (sql.includes('FROM seasons') && sql.includes('FOR UPDATE')) {
        const pending = originalQuery.apply(this, args);
        reportFreezeSeasonLockIssued();
        const result = await pending;
        reportFreezeSeasonLockAcquired();
        await freezeMayContinue;
        return result;
      }
      return originalQuery.apply(this, args);
    };
    try {
      return await releases.freeze(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 0n,
          snapshotId,
          throughSequence: 0n,
          imageByteLength: 1n,
          imageSha256: 'a'.repeat(64),
          frozenTitle: 'Repository test season',
          frozenDescription: null,
          seasonEndedAt: season.ends_at,
          eligibilityRows: freezeEligibility(actor),
          merkleRoot: randomBytes(32),
          claims: [
            {
              userId: actor.userId,
              walletAccountId: actor.walletAccountId,
              walletAddress: actor.walletAddress,
              merkleProof: [],
            },
          ],
        },
        transaction,
      );
    } finally {
      executor.query = originalQuery;
    }
  });
  await freezeSeasonLockIssued;
  resumePublisher();
  await freezeSeasonLockAcquired;
  resumeFreeze();

  const [snapshot, freezeResult] = await Promise.all([published, frozen]);
  assert.equal(firstPublisherLock, 'season');
  assert.equal(new Set(backendPids).size, 2);
  assert.equal(snapshot.id, snapshotId);
  assert.deepEqual(freezeResult, { updated: true });
});

test('force-ended seasons publish final snapshots but remain ineligible for NFT releases', async () => {
  const { pool, transactions, releases } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  await pool.query(
    `UPDATE canvases
     SET ends_at = CURRENT_TIMESTAMP + interval '1 day'
     WHERE id = $1`,
    [seasonId],
  );
  await pool.query(
    `UPDATE seasons SET force_ended_at = CURRENT_TIMESTAMP WHERE canvas_id = $1`,
    [seasonId],
  );
  const season = (
    await pool.query(
      `SELECT width, height, stroke_limit_per_user, starts_at, ends_at
       FROM canvases WHERE id = $1`,
      [seasonId],
    )
  ).rows[0];
  const snapshotId = randomUUID();
  const directory = `snapshots/seasons/${seasonId}/${snapshotId}`;
  const snapshots = new CanvasSnapshotRepository(pool, transactions);
  const published = await snapshots.publish({
    id: snapshotId,
    target: {
      id: seasonId,
      key: `season:${seasonId.toLowerCase()}`,
      kind: 'season',
      width: season.width,
      height: season.height,
      strokeLimitPerUser: season.stroke_limit_per_user,
      startsAt: season.starts_at,
      endsAt: season.ends_at,
    },
    throughSequence: '0',
    rendererVersion: 'force-end-test',
    isFinal: true,
    imageKey: `${directory}/image.png`,
    continuationKey: `${directory}/continuation.json`,
    imageBytes: 1,
    continuationBytes: 1,
    imageSha256: 'c'.repeat(64),
    continuationSha256: 'd'.repeat(64),
    continuationSchemaVersion: 1,
    capturedAt: new Date(),
  });
  assert.equal(published.id, snapshotId);
  await assert.rejects(
    transactions.run((transaction) =>
      releases.insertCandidate({ seasonId, network: 'devnet' }, transaction),
    ),
    /not eligible for a release/,
  );
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::integer AS count
         FROM season_nft_releases WHERE season_id = $1`,
        [seasonId],
      )
    ).rows[0].count,
    0,
  );
});

test('release stage CAS fixes media and chain values once before READY', async () => {
  const { pool, transactions, releases } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  await insertFreezeEligibility(pool, seasonId, actor);
  const snapshotId = await insertSnapshot(pool, seasonId);
  const seasonEndedAt = (
    await pool.query('SELECT ends_at FROM canvases WHERE id = $1', [seasonId])
  ).rows[0].ends_at;
  const candidate = await transactions.run((transaction) =>
    releases.insertCandidate({ seasonId, network: 'devnet' }, transaction),
  );
  await transactions.run((transaction) =>
    releases.freeze(
      {
        releaseId: candidate.releaseId,
        expectedVersion: 0n,
        snapshotId,
        throughSequence: 0n,
        imageByteLength: 1n,
        imageSha256: 'a'.repeat(64),
        frozenTitle: 'Repository test season',
        frozenDescription: null,
        seasonEndedAt,
        eligibilityRows: freezeEligibility(actor),
        merkleRoot: randomBytes(32),
        claims: [
          {
            userId: actor.userId,
            walletAccountId: actor.walletAccountId,
            walletAddress: actor.walletAddress,
            merkleProof: [],
          },
        ],
      },
      transaction,
    ),
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.advanceStage(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 1n,
          expectedStage: 'FROZEN',
          nextStage: 'IMAGE',
          imageByteLength: 1n,
          imageSha256: 'a'.repeat(64),
          imageUri: 'https://arweave.net/image',
        },
        transaction,
      ),
    ),
    { updated: true },
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.advanceStage(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 1n,
          expectedStage: 'IMAGE',
          nextStage: 'METADATA',
          assetName: 'Cameo season',
          metadataSha256: '2'.repeat(64),
          metadataUri: 'https://arweave.net/metadata',
        },
        transaction,
      ),
    ),
    { updated: false },
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.advanceStage(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 1n,
          expectedStage: 'IMAGE',
          nextStage: 'METADATA',
        },
        transaction,
      ),
    ),
    { updated: false },
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.advanceStage(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 1n,
          expectedStage: 'IMAGE',
          nextStage: 'METADATA',
          assetName: 'Cameo season',
          metadataSha256: '2'.repeat(64),
          metadataUri: 'https://arweave.net/metadata',
          preparationKeys: { stale: '/absolute/path.json' },
        },
        transaction,
      ),
    ),
    { updated: false },
  );
  const collectionAddress = bs58.encode(randomBytes(32));
  await transactions.run((transaction) =>
    releases.advanceStage(
      {
        releaseId: candidate.releaseId,
        expectedVersion: 2n,
        expectedStage: 'IMAGE',
        nextStage: 'METADATA',
        assetName: 'Cameo season',
        metadataSha256: '2'.repeat(64),
        metadataUri: 'https://arweave.net/metadata',
      },
      transaction,
    ),
  );
  await transactions.run((transaction) =>
    releases.advanceStage(
      {
        releaseId: candidate.releaseId,
        expectedVersion: 3n,
        expectedStage: 'METADATA',
        nextStage: 'COLLECTION',
        collectionAddress,
        preparationKeys: {
          [collectionAddress]: 'devnet/release/collection.json',
        },
      },
      transaction,
    ),
  );
  await transactions.run((transaction) =>
    releases.advanceStage(
      {
        releaseId: candidate.releaseId,
        expectedVersion: 4n,
        expectedStage: 'COLLECTION',
        nextStage: 'MACHINE',
        candyMachineAddress: bs58.encode(randomBytes(32)),
        candyGuardAddress: bs58.encode(randomBytes(32)),
      },
      transaction,
    ),
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.advanceStage(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 5n,
          expectedStage: 'MACHINE',
          nextStage: 'LOCKED',
          lockedAt: new Date(),
          readyAt: new Date(),
        },
        transaction,
      ),
    ),
    { updated: true },
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT state, stage, asset_name, version
         FROM season_nft_releases WHERE id = $1`,
        [candidate.releaseId],
      )
    ).rows[0],
    {
      state: 'READY',
      stage: 'LOCKED',
      asset_name: 'Cameo season',
      version: '6',
    },
  );
});

test('BLOCKED retry preserves frozen fields and only reschedules a blocked release', async () => {
  const { pool, transactions, releases } = await fixture();
  const actor = await insertUserWallet(pool);
  const seasonId = await insertSeason(pool, actor.userId);
  const candidate = await transactions.run((transaction) =>
    releases.insertCandidate({ seasonId, network: 'devnet' }, transaction),
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.block(
        {
          releaseId: candidate.releaseId,
          expectedVersion: 0n,
          errorCode: 'NFT_SOURCE_INELIGIBLE',
          errorMessage: 'Source is not eligible.',
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
        transaction,
      ),
    ),
    { updated: true },
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      releases.retryBlocked(
        { releaseId: candidate.releaseId, network: 'devnet' },
        transaction,
      ),
    ),
    { updated: true },
  );
  assert.deepEqual(
    (
      await pool.query(
        `SELECT state, stage, snapshot_id, last_error_code
         FROM season_nft_releases WHERE id = $1`,
        [candidate.releaseId],
      )
    ).rows[0],
    {
      state: 'WAITING_SNAPSHOT',
      stage: 'SNAPSHOT',
      snapshot_id: null,
      last_error_code: null,
    },
  );
});

test('prepared transaction validates attempt ownership and signed bytes are idempotent', async () => {
  const { transactions, nftTransactions } = await fixture();
  const first = await seedClaim();
  const second = await seedClaim();
  const firstAttempt = await transactions.run((transaction) =>
    (async () => {
      const { claims } = await fixture();
      return claims.getOrCreateAttempt({ claimId: first.claimId }, transaction);
    })(),
  );
  const secondAttempt = await transactions.run((transaction) =>
    (async () => {
      const { claims } = await fixture();
      return claims.getOrCreateAttempt(
        { claimId: second.claimId },
        transaction,
      );
    })(),
  );
  const input = {
    network: 'devnet',
    releaseId: first.releaseId,
    attemptId: firstAttempt.attemptId,
    operationKey: `claim:${firstAttempt.attemptId}:ALLOWLIST_PROOF`,
    kind: 'USER_PROOF',
    messageHash: 'b'.repeat(64),
    serializedTransaction: Buffer.from('partial-transaction'),
    recentBlockhash: 'blockhash',
    lastValidBlockHeight: 100n,
    estimatedCostLamports: 5000n,
    estimatedAt: new Date(),
    costBreakdown: { networkFee: '5000' },
  };
  await assert.rejects(
    transactions.run((transaction) =>
      nftTransactions.insertPrepared(
        {
          ...input,
          attemptId: secondAttempt.attemptId,
          operationKey: `claim:${secondAttempt.attemptId}:ALLOWLIST_PROOF`,
        },
        transaction,
      ),
    ),
    /does not belong to the release/,
  );
  const prepared = await transactions.run((transaction) =>
    nftTransactions.insertPrepared(input, transaction),
  );
  assert.equal(prepared.created, true);
  const signedBytes = Buffer.from('fully-signed-transaction');
  const signature = bs58.encode(randomBytes(64));
  const accepted = await transactions.run((transaction) =>
    nftTransactions.acceptSigned(
      {
        transactionId: prepared.transactionId,
        expectedMessageHash: input.messageHash,
        signedBytes,
        signature,
      },
      transaction,
    ),
  );
  const repeated = await transactions.run((transaction) =>
    nftTransactions.acceptSigned(
      {
        transactionId: prepared.transactionId,
        expectedMessageHash: input.messageHash,
        signedBytes,
        signature,
      },
      transaction,
    ),
  );
  assert.deepEqual(accepted, {
    accepted: true,
    currentTransactionState: 'SIGNED',
    signature,
  });
  assert.deepEqual(repeated, {
    accepted: false,
    currentTransactionState: 'SIGNED',
    signature,
  });
  await assert.rejects(
    transactions.run((transaction) =>
      nftTransactions.acceptSigned(
        {
          transactionId: prepared.transactionId,
          expectedMessageHash: 'c'.repeat(64),
          signedBytes,
          signature,
        },
        transaction,
      ),
    ),
    /message hash does not match/,
  );
});

test('concurrent FINALIZED evidence and PREPARED insert retain one operation row', async () => {
  const { pool, transactions, claims, nftTransactions } = await fixture();
  const seeded = await seedClaim();
  const attempt = await transactions.run((transaction) =>
    claims.getOrCreateAttempt({ claimId: seeded.claimId }, transaction),
  );
  const operationKey = `claim:${attempt.attemptId}:MINT`;
  const input = {
    network: 'devnet',
    releaseId: seeded.releaseId,
    attemptId: attempt.attemptId,
    operationKey,
    kind: 'USER_MINT',
    messageHash: 'd'.repeat(64),
    serializedTransaction: Buffer.from('mint-transaction'),
    recentBlockhash: 'mint-blockhash',
    lastValidBlockHeight: 200n,
    estimatedCostLamports: 7000n,
    estimatedAt: new Date(),
  };
  const prepared = await transactions.run((transaction) =>
    nftTransactions.insertPrepared(input, transaction),
  );
  const signature = bs58.encode(randomBytes(64));
  await transactions.run((transaction) =>
    nftTransactions.acceptSigned(
      {
        transactionId: prepared.transactionId,
        expectedMessageHash: input.messageHash,
        signedBytes: Buffer.from('signed-mint-transaction'),
        signature,
      },
      transaction,
    ),
  );
  const barrier = createBarrier(2);
  const backendPids = [];
  const finalize = transactions.run(async (transaction) => {
    backendPids.push(
      (
        await getPgExecutor(pool, transaction).query(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid,
    );
    await barrier();
    return nftTransactions.recordEvidence(
      {
        transactionId: prepared.transactionId,
        expectedState: 'SIGNED',
        state: 'FINALIZED',
      },
      transaction,
    );
  });
  const duplicate = transactions.run(async (transaction) => {
    backendPids.push(
      (
        await getPgExecutor(pool, transaction).query(
          'SELECT pg_backend_pid() AS pid',
        )
      ).rows[0].pid,
    );
    await barrier();
    return nftTransactions.insertPrepared(input, transaction);
  });
  const [finalized, existing] = await Promise.all([finalize, duplicate]);
  assert.equal(new Set(backendPids).size, 2);
  assert.deepEqual(finalized, { updated: true });
  assert.equal(existing.created, false);
  assert.equal(existing.transactionId, prepared.transactionId);
  assert.deepEqual(
    await transactions.run((transaction) =>
      nftTransactions.recordEvidence(
        {
          transactionId: prepared.transactionId,
          expectedState: 'FINALIZED',
          state: 'FAILED',
          errorCode: 'NFT_LATE_FAILURE',
        },
        transaction,
      ),
    ),
    { updated: false },
  );
  const protectedOperation = await transactions.run((transaction) =>
    nftTransactions.insertPrepared(input, transaction),
  );
  assert.equal(protectedOperation.created, false);
  assert.equal(protectedOperation.transactionId, prepared.transactionId);
  assert.equal(protectedOperation.state, 'FINALIZED');
  assert.equal(
    (
      await pool.query(
        `SELECT count(*)::integer AS count
         FROM season_nft_transactions
         WHERE release_id = $1 AND operation_key = $2`,
        [seeded.releaseId, operationKey],
      )
    ).rows[0].count,
    1,
  );
});

test('replaceExpired keeps the operation key and appends a new transaction row', async () => {
  const { pool, transactions, claims, nftTransactions } = await fixture();
  const seeded = await seedClaim();
  const attempt = await transactions.run((transaction) =>
    claims.getOrCreateAttempt({ claimId: seeded.claimId }, transaction),
  );
  const input = {
    network: 'devnet',
    releaseId: seeded.releaseId,
    attemptId: attempt.attemptId,
    operationKey: `claim:${attempt.attemptId}:ALLOWLIST_PROOF`,
    kind: 'USER_PROOF',
    messageHash: '9'.repeat(64),
    serializedTransaction: Buffer.from('expired-transaction'),
    recentBlockhash: 'expired-blockhash',
    lastValidBlockHeight: 10n,
    estimatedCostLamports: 5000n,
    estimatedAt: new Date(),
  };
  const expired = await transactions.run((transaction) =>
    nftTransactions.insertPrepared(input, transaction),
  );
  await transactions.run((transaction) =>
    nftTransactions.recordEvidence(
      {
        transactionId: expired.transactionId,
        expectedState: 'PREPARED',
        state: 'EXPIRED',
      },
      transaction,
    ),
  );
  const replacement = await transactions.run((transaction) =>
    nftTransactions.replaceExpired(
      {
        transactionId: expired.transactionId,
        replacement: {
          ...input,
          serializedTransaction: Buffer.from('replacement-transaction'),
          recentBlockhash: 'replacement-blockhash',
          lastValidBlockHeight: 20n,
        },
      },
      transaction,
    ),
  );
  assert.equal(replacement.created, true);
  assert.notEqual(replacement.transactionId, expired.transactionId);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT state FROM season_nft_transactions
         WHERE release_id = $1 AND operation_key = $2 ORDER BY created_at, id`,
        [seeded.releaseId, input.operationKey],
      )
    ).rows.map((row) => row.state),
    ['EXPIRED', 'PREPARED'],
  );
});

test('FAILED upload rearms the same data item and verification is idempotent', async () => {
  const { pool, transactions, uploads } = await fixture();
  const seeded = await seedClaim();
  const input = {
    releaseId: seeded.releaseId,
    kind: 'IMAGE',
    sha256: 'e'.repeat(64),
    byteLength: 12n,
    dataItemId: `item-${randomUUID()}`,
    signedItemPath: `items/${randomUUID()}.bin`,
  };
  const prepared = await transactions.run((transaction) =>
    uploads.prepareItem(input, transaction),
  );
  const repeated = await transactions.run((transaction) =>
    uploads.prepareItem(input, transaction),
  );
  assert.equal(prepared.created, true);
  assert.deepEqual(repeated, { ...prepared, created: false });
  await pool.query(
    `UPDATE season_nft_uploads SET state = 'FAILED' WHERE id = $1`,
    [prepared.uploadId],
  );
  await assert.rejects(
    transactions.run((transaction) =>
      uploads.prepareItem(
        { ...input, dataItemId: `other-${randomUUID()}` },
        transaction,
      ),
    ),
    /does not match the prepared item/,
  );
  assert.equal(
    (
      await pool.query(`SELECT state FROM season_nft_uploads WHERE id = $1`, [
        prepared.uploadId,
      ])
    ).rows[0].state,
    'FAILED',
  );
  const rearmed = await transactions.run((transaction) =>
    uploads.prepareItem(input, transaction),
  );
  assert.deepEqual(rearmed, {
    ...prepared,
    created: false,
    state: 'PREPARED',
  });
  const receipt = { id: input.dataItemId, status: 200 };
  assert.deepEqual(
    await transactions.run((transaction) =>
      uploads.recordReceipt(
        { uploadId: prepared.uploadId, dataItemId: input.dataItemId, receipt },
        transaction,
      ),
    ),
    { updated: true, state: 'UPLOADED' },
  );
  const uri = `https://arweave.net/${input.dataItemId}`;
  assert.deepEqual(
    await transactions.run((transaction) =>
      uploads.markVerified(
        { uploadId: prepared.uploadId, dataItemId: input.dataItemId, uri },
        transaction,
      ),
    ),
    { updated: true, state: 'VERIFIED' },
  );
  assert.deepEqual(
    await transactions.run((transaction) =>
      uploads.markVerified(
        { uploadId: prepared.uploadId, dataItemId: input.dataItemId, uri },
        transaction,
      ),
    ),
    { updated: false, state: 'VERIFIED' },
  );
});
