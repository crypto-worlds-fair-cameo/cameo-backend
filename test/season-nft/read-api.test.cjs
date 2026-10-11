const { randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { Global, Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const bs58 = require('bs58').default;
const { configureApp } = require('../../dist/app.factory');
const { LoggerModule } = require('../../dist/logging/logger.module');
const { SeasonsModule } = require('../../dist/modules/seasons/seasons.module');
const {
  SeasonNftsModule,
} = require('../../dist/modules/season-nfts/season-nfts.module');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const { insertWalletSession } = require('../canvas/wallet-session-fixture.cjs');

const origin = 'http://localhost:5173';
const rpcUrl = 'https://rpc.example.test';
const originalFetch = globalThis.fetch;
let rpcCalls = 0;
let server;

globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(rpcUrl)) {
    rpcCalls += 1;
    throw new Error('Read API attempted an external RPC request.');
  }
  return originalFetch(input, init);
};

async function startReadApiServer() {
  const database = await testDatabaseModule();

  class TestConfigModule {}
  Global()(TestConfigModule);
  Module({
    providers: [
      {
        provide: ConfigService,
        useValue: new ConfigService({
          app: {
            apiPrefix: 'api',
            nodeEnv: 'test',
            trustProxyHops: 0,
            version: 'test',
          },
          cors: {
            originList: [origin],
            credentials: true,
            methods: ['GET'],
            allowedHeaders: ['Content-Type'],
          },
          realtime: { maxConnections: 20 },
          canvasSnapshot: {
            enabled: false,
            publicBaseUrl: 'https://assets.example.test',
          },
          seasonNft: {
            enabled: false,
            network: 'devnet',
            rpcUrl,
            rpcReadRps: 5,
            rpcSendIntervalMs: 1200,
            priorityFeeMaxLamports: 0n,
          },
        }),
      },
    ],
    exports: [ConfigService],
  })(TestConfigModule);

  class TestAppModule {}
  Module({
    imports: [
      TestConfigModule,
      database.module,
      LoggerModule,
      SeasonsModule,
      SeasonNftsModule,
    ],
  })(TestAppModule);

  const app = configureApp(
    await NestFactory.create(TestAppModule, { logger: false }),
  );
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  const config = app.get(ConfigService);
  // Worker boot remains disabled; read projections can still exercise enabled-view precedence.
  config.set('seasonNft.enabled', true);
  return {
    app,
    config,
    pool: database.pool,
    url: await app.getUrl(),
  };
}

async function actor() {
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await server.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await insertWalletSession(server.pool, userId, token);
  const wallet = (
    await server.pool.query(
      'SELECT id, address FROM user_wallets WHERE user_id = $1',
      [userId],
    )
  ).rows[0];
  return {
    userId,
    token,
    walletAccountId: wallet.id,
    walletAddress: wallet.address,
  };
}

async function request(path, token) {
  return originalFetch(`${server.url}/api${path}`, {
    headers: token ? { Cookie: `cameo_session=${token}` } : {},
  });
}

async function json(path, token) {
  const response = await request(path, token);
  return { response, body: await response.json() };
}

async function season(owner, options = {}) {
  const seasonId = options.seasonId ?? randomUUID();
  const startsAt = options.startsAt ?? new Date(Date.now() - 2 * 86_400_000);
  const endsAt = options.endsAt ?? new Date(Date.now() - 86_400_000);
  await server.pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 10, $2, $3)`,
    [seasonId, startsAt, endsAt],
  );
  await server.pool.query(
    `INSERT INTO seasons
       (canvas_id, creator_id, title, description, capacity,
        cancelled_at, force_ended_at)
     VALUES ($1, $2, $3, 'Read API description', 100, $4, $5)`,
    [
      seasonId,
      owner.userId,
      options.title ?? `Season ${seasonId.slice(0, 8)}`,
      options.cancelled ? new Date() : null,
      options.forceEnded ? new Date() : null,
    ],
  );
  return seasonId;
}

async function participate(seasonId, member, joinedAt = new Date()) {
  await server.pool.query(
    `INSERT INTO season_participants
       (season_id, user_id, wallet_account_id, wallet_address, joined_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      seasonId,
      member.userId,
      member.walletAccountId,
      member.walletAddress,
      joinedAt,
    ],
  );
}

async function useStrokes(seasonId, member, count) {
  for (let index = 0; index < count; index += 1) {
    await server.pool.query(
      `INSERT INTO canvas_stroke_usages
         (canvas_id, user_id, client_stroke_id)
       VALUES ($1, $2, $3)`,
      [seasonId, member.userId, randomUUID()],
    );
  }
}

async function finalSnapshot(seasonId) {
  const snapshotId = randomUUID();
  const key = `snapshots/seasons/${seasonId}/${snapshotId}`;
  await server.pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 2, 'read-api', 1000, 1000, 'READY', true,
             $3, $4, 10, 10, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `${key}/image.png`,
      `${key}/continuation.json`,
      'a'.repeat(64),
    ],
  );
  return { snapshotId, imageKey: `${key}/image.png` };
}

async function release(seasonId, options = {}) {
  const releaseId = randomUUID();
  const network = options.network ?? 'devnet';
  const state = options.state ?? 'PREPARING';
  const frozen = options.frozen ?? (state === 'EMPTY' || state === 'READY');
  const snapshot = frozen ? await finalSnapshot(seasonId) : null;
  const ready = state === 'READY';
  const empty = state === 'EMPTY';
  await server.pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, snapshot_id, through_sequence,
        eligible_count, frozen_title, frozen_description, season_ended_at,
        asset_name, image_byte_length, image_sha256, metadata_sha256,
        image_uri, metadata_uri, collection_address, candy_machine_address,
        candy_guard_address, merkle_root, locked_at, ready_at,
        last_error_code, last_error_message)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        CASE WHEN $6::uuid IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
        $23, $24)`,
    [
      releaseId,
      seasonId,
      network,
      state,
      frozen ? (ready ? 'LOCKED' : 'FROZEN') : 'SNAPSHOT',
      snapshot?.snapshotId ?? null,
      frozen ? '2' : null,
      frozen ? (empty ? 0 : 2) : null,
      frozen ? 'Frozen title' : null,
      frozen ? 'Frozen description' : null,
      ready ? 'Cameo Season NFT' : null,
      ready ? '10' : null,
      ready ? 'b'.repeat(64) : null,
      ready ? 'c'.repeat(64) : null,
      ready ? 'https://arweave.net/image' : null,
      ready ? 'https://arweave.net/metadata' : null,
      ready ? bs58.encode(randomBytes(32)) : null,
      ready ? bs58.encode(randomBytes(32)) : null,
      ready ? bs58.encode(randomBytes(32)) : null,
      frozen && !empty ? Buffer.alloc(32, 1) : null,
      ready ? new Date() : null,
      ready ? new Date() : null,
      options.lastErrorCode ?? null,
      options.lastErrorMessage ?? null,
    ],
  );
  return { releaseId, snapshot };
}

async function claim(releaseId, member, options = {}) {
  const claimId = randomUUID();
  const state = options.state ?? 'UNCLAIMED';
  const receiptState = options.receiptState ?? 'NONE';
  await server.pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, asset_address, mint_signature, claimed_at,
        receipt_state, receipt_next_check_at)
     VALUES ($1, $2, 'devnet', $3, $4, $5, $6, '[]'::jsonb, $7, $8, $9,
             $10, CASE WHEN $10 = 'RESOLVING' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
    [
      claimId,
      releaseId,
      member.userId,
      member.walletAccountId,
      member.walletAddress,
      state,
      options.assetAddress ?? null,
      options.signature ?? null,
      options.claimedAt ?? null,
      receiptState,
    ],
  );
  return claimId;
}

before(async () => {
  server = await startReadApiServer();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await server?.app.close();
});

test('GET season NFT authenticates and exposes exact user-scoped view precedence', async () => {
  const viewer = await actor();
  const other = await actor();

  const waiting = await season(viewer, {
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 86_400_000),
  });
  await participate(waiting, viewer);

  const cancelled = await season(viewer, { cancelled: true });
  await participate(cancelled, viewer);
  const forced = await season(viewer, { forceEnded: true });
  await participate(forced, viewer);

  const blocked = await season(viewer);
  await participate(blocked, viewer);
  await useStrokes(blocked, viewer, 1);
  await release(blocked, {
    state: 'BLOCKED',
    lastErrorCode: 'PROVIDER_PRIVATE_FAILURE',
    lastErrorMessage: '/secret/keys/release.json',
  });

  const empty = await season(viewer);
  await participate(empty, viewer);
  await release(empty, { state: 'EMPTY' });

  const ready = await season(viewer);
  await participate(ready, viewer);
  await useStrokes(ready, viewer, 1);
  await release(ready, { state: 'READY' });

  const claimedDisabled = await season(viewer);
  await participate(claimedDisabled, viewer);
  await useStrokes(claimedDisabled, viewer, 1);
  const disabledRelease = await release(claimedDisabled, { state: 'READY' });
  await claim(disabledRelease.releaseId, viewer, {
    state: 'CLAIMED',
    receiptState: 'RESOLVING',
    claimedAt: new Date('2026-10-10T01:02:03.000Z'),
  });
  await claim(disabledRelease.releaseId, other).catch(() => undefined);

  const cases = [
    [cancelled, 'UNAVAILABLE', 'CANCELLED'],
    [forced, 'UNAVAILABLE', 'FORCE_ENDED'],
    [waiting, 'WAITING_FOR_END', null],
    [blocked, 'PREPARING', null],
    [empty, 'EMPTY', null],
    [ready, 'READY', null],
  ];
  for (const [seasonId, availability, reason] of cases) {
    const { response, body } = await json(
      `/seasons/${seasonId}/nft`,
      viewer.token,
    );
    assert.equal(response.status, 200);
    assert.equal(body.data.availability, availability);
    assert.equal(body.data.reason, reason);
    assert.deepEqual(Object.keys(body.data), [
      'seasonId',
      'network',
      'availability',
      'reason',
      'name',
      'imageUrl',
      'metadataUri',
      'eligibleCount',
      'claim',
    ]);
    assert.equal(JSON.stringify(body).includes('/secret/keys'), false);
    assert.equal(JSON.stringify(body).includes('lastError'), false);
  }

  const waitingView = (await json(`/seasons/${waiting}/nft`, viewer.token)).body
    .data;
  assert.equal(waitingView.eligibleCount, null);
  assert.deepEqual(waitingView.claim, {
    eligibility: 'NO_VALID_STROKE',
    state: 'UNCLAIMED',
    walletAddress: viewer.walletAddress,
    activeAttemptId: null,
    assetAddress: null,
    signature: null,
    receiptState: 'NONE',
    claimedAt: null,
  });

  server.config.set('seasonNft.enabled', false);
  const cancelledWhileDisabled = (
    await json(`/seasons/${cancelled}/nft`, viewer.token)
  ).body.data;
  assert.equal(cancelledWhileDisabled.availability, 'UNAVAILABLE');
  assert.equal(cancelledWhileDisabled.reason, 'CANCELLED');
  const disabledView = (
    await json(`/seasons/${claimedDisabled}/nft`, viewer.token)
  ).body.data;
  assert.equal(disabledView.availability, 'UNAVAILABLE');
  assert.equal(disabledView.reason, 'FEATURE_DISABLED');
  assert.equal(disabledView.imageUrl, 'https://arweave.net/image');
  assert.equal(disabledView.metadataUri, 'https://arweave.net/metadata');
  assert.equal(disabledView.claim.state, 'CLAIMED');
  assert.equal(disabledView.claim.receiptState, 'RESOLVING');
  assert.equal(disabledView.claim.assetAddress, null);
  assert.equal(disabledView.claim.signature, null);
  server.config.set('seasonNft.enabled', true);
});

test('GET season NFT never exposes another participant claim', async () => {
  const first = await actor();
  const second = await actor();
  const seasonId = await season(first);
  await participate(seasonId, first);
  await participate(seasonId, second);
  await useStrokes(seasonId, first, 1);
  await useStrokes(seasonId, second, 1);
  const prepared = await release(seasonId, { state: 'READY' });
  await claim(prepared.releaseId, second, {
    state: 'CLAIMED',
    receiptState: 'VERIFIED',
    assetAddress: bs58.encode(randomBytes(32)),
    signature: bs58.encode(randomBytes(64)),
    claimedAt: new Date('2026-10-10T02:03:04.000Z'),
  });

  const firstView = (await json(`/seasons/${seasonId}/nft`, first.token)).body
    .data;
  const secondView = (await json(`/seasons/${seasonId}/nft`, second.token)).body
    .data;
  assert.equal(firstView.claim.state, 'UNCLAIMED');
  assert.equal(firstView.claim.walletAddress, first.walletAddress);
  assert.equal(firstView.claim.assetAddress, null);
  assert.equal(secondView.claim.state, 'CLAIMED');
  assert.equal(secondView.claim.walletAddress, second.walletAddress);
  assert.notEqual(secondView.claim.assetAddress, null);
});

test('read routes require auth, preserve static participated route, and reject missing network', async () => {
  const viewer = await actor();
  const missingSeason = randomUUID();

  const nftUnauthenticated = await json(
    `/seasons/${missingSeason}/nft`,
    undefined,
  );
  assert.equal(nftUnauthenticated.response.status, 401);
  assert.equal(nftUnauthenticated.body.code, 'AUTH_SESSION_INVALID');

  const participatedUnauthenticated = await json(
    '/seasons/participated',
    undefined,
  );
  assert.equal(participatedUnauthenticated.response.status, 401);
  assert.equal(participatedUnauthenticated.body.code, 'AUTH_SESSION_INVALID');

  const missing = await json(`/seasons/${missingSeason}/nft`, viewer.token);
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.code, 'SEASON_NOT_FOUND');

  server.config.set('seasonNft.network', null);
  const nftUnavailable = await json(
    `/seasons/${missingSeason}/nft`,
    viewer.token,
  );
  assert.equal(nftUnavailable.response.status, 503);
  assert.equal(nftUnavailable.body.code, 'NFT_SERVICE_UNAVAILABLE');
  const unavailable = await json('/seasons/participated', viewer.token);
  assert.equal(unavailable.response.status, 503);
  assert.equal(unavailable.body.code, 'NFT_SERVICE_UNAVAILABLE');
  assert.equal(
    unavailable.body.message,
    'NFT claims are temporarily unavailable.',
  );
  assert.equal(JSON.stringify(unavailable.body).includes('network'), false);
  server.config.set('seasonNft.network', 'devnet');
});

test('GET participated returns actual rows, deterministic pages, and current-network NFT summaries', async () => {
  const viewer = await actor();
  const outsider = await actor();
  const joinedAt = new Date('2026-10-10T00:00:00.000Z');
  const ids = [
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000005',
  ];
  const definitions = [
    {
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 2 * 86_400_000),
      expected: 'scheduled',
    },
    {
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      expected: 'active',
    },
    { expected: 'ended' },
    { forceEnded: true, expected: 'ended' },
    { cancelled: true, expected: 'cancelled' },
  ];

  for (let index = 0; index < ids.length; index += 1) {
    const seasonId = await season(viewer, {
      ...definitions[index],
      seasonId: ids[index],
      title: `Lifecycle ${definitions[index].expected}`,
    });
    await participate(seasonId, viewer, joinedAt);
  }
  await useStrokes(ids[2], viewer, 2);
  const prepared = await release(ids[2], { state: 'READY' });
  const claimId = await claim(prepared.releaseId, viewer);
  await server.pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $3, 'FAILED', 'MINT'),
            ($2, $3, 'EXPIRED', 'MINT')`,
    [randomUUID(), randomUUID(), claimId],
  );
  await release(ids[2], { state: 'BLOCKED', network: 'mainnet-beta' });

  const outsidersSeason = await season(outsider);
  await participate(outsidersSeason, outsider, new Date(Date.now() + 60_000));

  const firstPage = await json(
    '/seasons/participated?limit=2&offset=1',
    viewer.token,
  );
  assert.equal(firstPage.response.status, 200);
  assert.equal(firstPage.body.data.total, 5);
  assert.equal(firstPage.body.data.limit, 2);
  assert.equal(firstPage.body.data.offset, 1);
  assert.deepEqual(
    firstPage.body.data.items.map((item) => item.seasonId),
    [ids[3], ids[2]],
  );
  assert.equal(firstPage.body.data.items[1].ownStrokeCount, 2);
  assert.equal(firstPage.body.data.items[1].nft.network, 'devnet');
  assert.equal(firstPage.body.data.items[1].nft.availability, 'READY');
  assert.equal(
    firstPage.body.data.items[1].finalImageUrl,
    `https://assets.example.test/${prepared.snapshot.imageKey}`,
  );
  assert.deepEqual(Object.keys(firstPage.body.data.items[1]), [
    'seasonId',
    'title',
    'lifecycleStatus',
    'startsAt',
    'endsAt',
    'joinedAt',
    'ownStrokeCount',
    'finalImageUrl',
    'nft',
  ]);

  const all = await json('/seasons/participated?limit=50', viewer.token);
  assert.equal(all.response.status, 200);
  assert.deepEqual(
    all.body.data.items.map((item) => item.seasonId),
    [...ids].reverse(),
  );
  assert.deepEqual(
    Object.fromEntries(
      all.body.data.items.map((item) => [item.seasonId, item.lifecycleStatus]),
    ),
    Object.fromEntries(
      ids.map((id, index) => [id, definitions[index].expected]),
    ),
  );
  assert.equal(
    all.body.data.items.some((item) => item.seasonId === outsidersSeason),
    false,
  );

  const pastEnd = await json(
    '/seasons/participated?limit=20&offset=999',
    viewer.token,
  );
  assert.equal(pastEnd.body.data.total, 5);
  assert.deepEqual(pastEnd.body.data.items, []);
});

test('participated pagination validates numeric strings and follows unknown-field policy', async () => {
  const viewer = await actor();
  const invalidQueries = [
    'limit=',
    'limit=0',
    'limit=51',
    'limit=1.5',
    'limit=NaN',
    'offset=-1',
    'offset=1.5',
    'offset=',
  ];
  for (const query of invalidQueries) {
    const result = await request(
      `/seasons/participated?${query}`,
      viewer.token,
    );
    assert.equal(result.status, 400, query);
  }

  const allowedUnknown = await json(
    '/seasons/participated?unknown=ignored',
    viewer.token,
  );
  assert.equal(allowedUnknown.response.status, 200);
  assert.deepEqual(allowedUnknown.body.data, {
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
  });
});

test('Swagger documents both read contracts and their configuration failure', async () => {
  const document = await (
    await originalFetch(`${server.url}/docs-json`)
  ).json();
  assert.ok(document.paths['/api/seasons/{seasonId}/nft'].get);
  assert.ok(document.paths['/api/seasons/participated'].get);
  assert.ok(
    document.paths['/api/seasons/participated'].get.responses['503'].content[
      'application/json'
    ].examples.NFT_SERVICE_UNAVAILABLE,
  );
  assert.ok(
    document.paths['/api/seasons/{seasonId}/nft'].get.responses['503'].content[
      'application/json'
    ].examples.NFT_SERVICE_UNAVAILABLE,
  );
  const seasonView = document.components.schemas.SeasonNftResponse;
  assert.deepEqual(seasonView.properties.availability.enum, [
    'WAITING_FOR_END',
    'PREPARING',
    'READY',
    'EMPTY',
    'UNAVAILABLE',
  ]);
});

test('read APIs never call the configured RPC endpoint', () => {
  assert.equal(rpcCalls, 0);
});
