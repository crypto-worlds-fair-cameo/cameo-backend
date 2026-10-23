const { createHash, randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { Global, Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const bs58 = require('bs58').default;
const core = require('@metaplex-foundation/mpl-core');
const candy = require('@metaplex-foundation/mpl-core-candy-machine');
const umiModule = require('@metaplex-foundation/umi');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { configureApp } = require('../../dist/app.factory');
const { LoggerModule } = require('../../dist/logging/logger.module');
const {
  SeasonNftsModule,
} = require('../../dist/modules/season-nfts/season-nfts.module');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const { insertWalletSession } = require('../canvas/wallet-session-fixture.cjs');

const origin = 'http://localhost:5173';
let server;

async function startServer() {
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
            methods: ['GET', 'POST'],
            allowedHeaders: ['Content-Type'],
          },
          realtime: { maxConnections: 20 },
          canvasSnapshot: { enabled: false },
          seasonNft: {
            enabled: false,
            network: 'devnet',
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
    imports: [TestConfigModule, database.module, LoggerModule, SeasonNftsModule],
  })(TestAppModule);
  const app = configureApp(
    await NestFactory.create(TestAppModule, { logger: false }),
  );
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  app.get(ConfigService).set('seasonNft.enabled', true);
  return { app, pool: database.pool, url: await app.getUrl() };
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

async function signingActor() {
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const umi = createUmi('http://127.0.0.1:8899');
  const signer = umiModule.generateSigner(umi);
  const walletAddress = String(signer.publicKey);
  await server.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  const walletAccountId = (
    await server.pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [userId, walletAddress],
    )
  ).rows[0].id;
  await server.pool.query(
    `INSERT INTO auth_sessions (user_id, wallet_account_id, token_hash)
     VALUES ($1, $2, $3)`,
    [userId, walletAccountId, createHash('sha256').update(token).digest('hex')],
  );
  return {
    userId,
    token,
    walletAccountId,
    walletAddress,
    signerSecretKey: signer.secretKey,
  };
}

async function alternateWalletSession(member) {
  const token = randomBytes(32).toString('base64url');
  const walletAddress = bs58.encode(randomBytes(32));
  const walletAccountId = (
    await server.pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [member.userId, walletAddress],
    )
  ).rows[0].id;
  await server.pool.query(
    `INSERT INTO auth_sessions (user_id, wallet_account_id, token_hash)
     VALUES ($1, $2, $3)`,
    [member.userId, walletAccountId, createHash('sha256').update(token).digest('hex')],
  );
  return { ...member, token, walletAccountId, walletAddress };
}

async function readyClaim(member) {
  const creator = await actor();
  const seasonId = randomUUID();
  const releaseId = randomUUID();
  const claimId = randomUUID();
  const snapshotId = randomUUID();
  await server.pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 10,
             CURRENT_TIMESTAMP - interval '2 days',
             CURRENT_TIMESTAMP - interval '1 day')`,
    [seasonId],
  );
  await server.pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Claim API season', 2)`,
    [seasonId, creator.userId],
  );
  await server.pool.query(
    `INSERT INTO season_participants
       (season_id, user_id, wallet_account_id, wallet_address)
     VALUES ($1, $2, $3, $4)`,
    [seasonId, member.userId, member.walletAccountId, member.walletAddress],
  );
  await server.pool.query(
    `INSERT INTO canvas_stroke_usages
       (canvas_id, user_id, client_stroke_id)
     VALUES ($1, $2, $3)`,
    [seasonId, member.userId, randomUUID()],
  );
  await server.pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 0, 'claim-api', 1000, 1000, 'READY', true,
             $3, $4, 1, 1, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `snapshots/seasons/${seasonId}/${snapshotId}/image.png`,
      `snapshots/seasons/${seasonId}/${snapshotId}/continuation.json`,
      'c'.repeat(64),
    ],
  );
  await server.pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, snapshot_id, through_sequence,
        eligible_count, frozen_title, season_ended_at, asset_name,
        image_byte_length, image_sha256, metadata_sha256, image_uri,
        metadata_uri, collection_address, candy_machine_address,
        candy_guard_address, merkle_root, locked_at, ready_at)
     VALUES ($1, $2, 'devnet', 'READY', 'LOCKED', $9, 0, 1,
             'Claim API season', CURRENT_TIMESTAMP, 'Cameo Claim API', 1,
             $3, $4, 'https://arweave.net/image',
             'https://arweave.net/metadata', $5, $6, $7, $8,
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      releaseId,
      seasonId,
      'a'.repeat(64),
      'b'.repeat(64),
      bs58.encode(randomBytes(32)),
      bs58.encode(randomBytes(32)),
      bs58.encode(randomBytes(32)),
      Buffer.alloc(32, 1),
      snapshotId,
    ],
  );
  await server.pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, receipt_state)
     VALUES ($1, $2, 'devnet', $3, $4, $5, 'UNCLAIMED', '[]'::jsonb, 'NONE')`,
    [
      claimId,
      releaseId,
      member.userId,
      member.walletAccountId,
      member.walletAddress,
    ],
  );
  return { seasonId, releaseId, claimId };
}

async function request(path, member, options = {}) {
  const response = await fetch(`${server.url}/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Cookie: `cameo_session=${member.token}`,
      ...(options.origin === false ? {} : { Origin: origin }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response, body: await response.json() };
}

async function chunkedRequest(path, member, body) {
  const target = new URL(`${server.url}/api${path}`);
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      target,
      {
        method: 'POST',
        headers: {
          Cookie: `cameo_session=${member.token}`,
          Origin: origin,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => {
          resolve({
            response: { status: incoming.statusCode, headers: incoming.headers },
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.write(body.slice(0, 4096));
    outgoing.end(body.slice(4096));
  });
}

async function preparedMint(member, ids) {
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const payer = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.createKeypairFromSecretKey(member.signerSecretKey),
  );
  const asset = umiModule.generateSigner(umi);
  const root = candy.getMerkleRoot([payer.publicKey]);
  umi.use(umiModule.signerIdentity(payer));
  const signed = await candy
    .mintV1(umi, {
      candyMachine: umiModule.publicKey(ids.machine),
      candyGuard: umiModule.publicKey(ids.guard),
      payer,
      minter: payer,
      owner: payer.publicKey,
      asset,
      collection: umiModule.publicKey(ids.collection),
      mintArgs: { allowList: { merkleRoot: root }, mintLimit: { id: 0 } },
    })
    .setVersion('legacy')
    .setBlockhash('11111111111111111111111111111111')
    .buildAndSign(umi);
  const prepared = {
    ...signed,
    signatures: signed.signatures.map((signature, index) =>
      index === 0 ? new Uint8Array(64) : signature,
    ),
  };
  return {
    payerAddress: String(payer.publicKey),
    preparedBytes: Buffer.from(umi.transactions.serialize(prepared)),
    signedBytes: Buffer.from(umi.transactions.serialize(signed)),
    messageHash: createHash('sha256').update(signed.serializedMessage).digest('hex'),
    assetAddress: String(asset.publicKey),
  };
}

async function preparedProof(member, ids) {
  const umi = createUmi('http://127.0.0.1:8899').use(candy.mplCandyMachine());
  const payer = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.createKeypairFromSecretKey(member.signerSecretKey),
  );
  umi.use(umiModule.signerIdentity(payer));
  const root = candy.getMerkleRoot([payer.publicKey]);
  const signed = await candy
    .route(umi, {
      candyMachine: umiModule.publicKey(ids.machine),
      candyGuard: umiModule.publicKey(ids.guard),
      payer,
      guard: 'allowList',
      routeArgs: {
        path: 'proof',
        merkleRoot: root,
        merkleProof: [],
        minter: payer.publicKey,
      },
    })
    .setVersion('legacy')
    .setBlockhash('11111111111111111111111111111111')
    .buildAndSign(umi);
  const prepared = {
    ...signed,
    signatures: signed.signatures.map(() => new Uint8Array(64)),
  };
  return {
    preparedBytes: Buffer.from(umi.transactions.serialize(prepared)),
    signedBytes: Buffer.from(umi.transactions.serialize(signed)),
    messageHash: createHash('sha256').update(signed.serializedMessage).digest('hex'),
  };
}

before(async () => {
  server = await startServer();
});

after(async () => {
  await server?.app.close();
});

test('twenty concurrent create requests return one durable attempt', async () => {
  const member = await actor();
  const { seasonId, claimId } = await readyClaim(member);
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      request(`/seasons/${seasonId}/nft/claim-attempts`, member, {
        method: 'POST',
      }),
    ),
  );
  assert.equal(results.filter(({ response }) => response.status === 202).length, 1);
  assert.equal(results.filter(({ response }) => response.status === 200).length, 19);
  const attemptIds = new Set(results.map(({ body }) => body.data.attemptId));
  assert.equal(attemptIds.size, 1);
  const rows = await server.pool.query(
    'SELECT id, state, step FROM season_nft_claim_attempts WHERE claim_id = $1',
    [claimId],
  );
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].state, 'QUEUED');
  assert.equal(rows.rows[0].step, 'ALLOWLIST_PROOF');
});

test('claim write routes enforce Origin, authentication, and actor ownership', async () => {
  const owner = await actor();
  const stranger = await actor();
  const { seasonId } = await readyClaim(owner);
  const created = await request(
    `/seasons/${seasonId}/nft/claim-attempts`,
    owner,
    { method: 'POST' },
  );
  const attemptId = created.body.data.attemptId;

  const noOrigin = await request(
    `/seasons/${seasonId}/nft/claim-attempts`,
    owner,
    { method: 'POST', origin: false },
  );
  assert.equal(noOrigin.response.status, 403);
  const foreign = await request(
    `/seasons/${seasonId}/nft/claim-attempts/${attemptId}`,
    stranger,
  );
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.body.code, 'NFT_CLAIM_ATTEMPT_NOT_FOUND');
  assert.equal('transaction' in foreign.body, false);
  const own = await request(
    `/seasons/${seasonId}/nft/claim-attempts/${attemptId}`,
    owner,
  );
  assert.equal(own.response.status, 200);
  assert.equal(own.body.data.attemptId, attemptId);
  assert.equal(own.body.data.walletAddress, owner.walletAddress);
  assert.equal(own.body.data.transaction, null);
  await server.pool.query(
    `UPDATE season_nft_claim_attempts
     SET last_error_code = 'NFT_TRANSACTION_EXPIRED' WHERE id = $1`,
    [attemptId],
  );
  const queuedWithOldError = await request(
    `/seasons/${seasonId}/nft/claim-attempts/${attemptId}`,
    owner,
  );
  assert.equal(queuedWithOldError.body.data.state, 'QUEUED');
  assert.equal(queuedWithOldError.body.data.retryable, false);
  assert.equal(queuedWithOldError.body.data.errorCode, null);
  await server.pool.query(
    `UPDATE season_nft_claim_attempts SET state = 'FAILED', last_error_code = 'Error'
     WHERE id = $1`,
    [attemptId],
  );
  const failedUnknown = await request(
    `/seasons/${seasonId}/nft/claim-attempts/${attemptId}`,
    owner,
  );
  assert.equal(failedUnknown.body.data.errorCode, 'NFT_CHAIN_CONFIGURATION_INVALID');
  assert.equal(failedUnknown.body.data.retryable, false);
});

test('create rejects a different active wallet for the same participant', async () => {
  const participant = await actor();
  const { seasonId } = await readyClaim(participant);
  const alternate = await alternateWalletSession(participant);
  const result = await request(
    `/seasons/${seasonId}/nft/claim-attempts`,
    alternate,
    { method: 'POST' },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'NFT_WALLET_MISMATCH');
});

test('create preserves participant wallet ownership before release freeze', async () => {
  const participant = await actor();
  const seasonId = randomUUID();
  await server.pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 10,
             CURRENT_TIMESTAMP - interval '1 hour',
             CURRENT_TIMESTAMP + interval '1 hour')`,
    [seasonId],
  );
  await server.pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Pre-freeze wallet', 2)`,
    [seasonId, participant.userId],
  );
  await server.pool.query(
    `INSERT INTO season_participants
       (season_id, user_id, wallet_account_id, wallet_address)
     VALUES ($1, $2, $3, $4)`,
    [
      seasonId,
      participant.userId,
      participant.walletAccountId,
      participant.walletAddress,
    ],
  );
  const alternate = await alternateWalletSession(participant);
  const result = await request(
    `/seasons/${seasonId}/nft/claim-attempts`,
    alternate,
    { method: 'POST' },
  );
  assert.equal(result.response.status, 403);
  assert.equal(result.body.code, 'NFT_WALLET_MISMATCH');
});

test('submit commits exact signed bytes before admission and replays historical transaction', async () => {
  const owner = await signingActor();
  const stranger = await actor();
  const ids = await readyClaim(owner);
  const created = await request(
    `/seasons/${ids.seasonId}/nft/claim-attempts`,
    owner,
    { method: 'POST' },
  );
  const attemptId = created.body.data.attemptId;
  const release = (
    await server.pool.query(
      `SELECT collection_address, candy_machine_address, candy_guard_address
       FROM season_nft_releases WHERE id = $1`,
      [ids.releaseId],
    )
  ).rows[0];
  const mintFixture = await preparedMint(owner, {
    collection: release.collection_address,
    machine: release.candy_machine_address,
    guard: release.candy_guard_address,
  });
  const fixture = await preparedProof(owner, {
    machine: release.candy_machine_address,
    guard: release.candy_guard_address,
  });
  assert.equal(mintFixture.payerAddress, owner.walletAddress);
  const transactionId = randomUUID();
  await server.pool.query(
    `UPDATE season_nft_claim_attempts
     SET state = 'AWAITING_SIGNATURE', step = 'ALLOWLIST_PROOF' WHERE id = $1`,
    [attemptId],
  );
  await server.pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, attempt_id, operation_key, kind, state,
        message_hash, serialized_transaction, recent_blockhash,
        last_valid_block_height, asset_address, estimated_cost_lamports,
        estimated_at, cost_breakdown)
     VALUES ($2, 'devnet', $3, $1, $6,
             'USER_PROOF', 'PREPARED', $4, $5,
             '11111111111111111111111111111111', 12345, NULL, 5000,
             CURRENT_TIMESTAMP, '{"transactionFeeLamports":"5000","priorityFeeLamports":"0","accountRentLamports":"0","protocolFeeLamports":"0"}'::jsonb)`,
    [attemptId, transactionId, ids.releaseId, fixture.messageHash, fixture.preparedBytes, `claim:${attemptId}:ALLOWLIST_PROOF`],
  );
  const body = {
    transactionId,
    signedTransactionBase64: fixture.signedBytes.toString('base64'),
  };
  const fresh = await request(
    `/seasons/${ids.seasonId}/nft/claim-attempts/${attemptId}`,
    owner,
  );
  assert.equal(fresh.body.data.transaction.transactionId, transactionId);
  await server.pool.query(
    `UPDATE season_nft_transactions
     SET estimated_at = CURRENT_TIMESTAMP - interval '61 seconds' WHERE id = $1`,
    [transactionId],
  );
  const stale = await request(
    `/seasons/${ids.seasonId}/nft/claim-attempts/${attemptId}`,
    owner,
  );
  assert.equal(stale.body.data.state, 'CONFIRMING');
  assert.equal(stale.body.data.transaction, null);
  await server.pool.query(
    `UPDATE season_nft_transactions SET estimated_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [transactionId],
  );
  const oversized = await chunkedRequest(
    `/seasons/${ids.seasonId}/nft/claim-attempts/${attemptId}/transactions`,
    owner,
    `${' '.repeat(8193)}${JSON.stringify(body)}`,
  );
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.body.code, 'PayloadTooLargeException');
  assert.ok(oversized.response.headers['access-control-allow-origin']);
  assert.equal(
    oversized.response.headers['x-content-type-options'],
    'nosniff',
  );
  const beforeValidSubmit = (
    await server.pool.query(
      'SELECT state FROM season_nft_transactions WHERE id = $1',
      [transactionId],
    )
  ).rows[0];
  assert.equal(beforeValidSubmit.state, 'PREPARED');
  const foreign = await request(
    `/seasons/${ids.seasonId}/nft/claim-attempts/${attemptId}/transactions`,
    stranger,
    { method: 'POST', body },
  );
  assert.equal(foreign.response.status, 404);

  const accepted = await request(
    `/seasons/${ids.seasonId}/nft/claim-attempts/${attemptId}/transactions`,
    owner,
    { method: 'POST', body },
  );
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.body.data.state, 'SUBMITTING');
  const persisted = (
    await server.pool.query(
      `SELECT state, serialized_transaction, signature
       FROM season_nft_transactions WHERE id = $1`,
      [transactionId],
    )
  ).rows[0];
  assert.equal(persisted.state, 'SIGNED');
  assert.deepEqual(persisted.serialized_transaction, fixture.signedBytes);
  assert.equal(persisted.signature, accepted.body.data.signature);

  await server.pool.query(
    `UPDATE season_nft_claim_attempts SET state = 'AWAITING_SIGNATURE', step = 'MINT'
     WHERE id = $1`,
    [attemptId],
  );
  await server.pool.query(
    `UPDATE season_nft_transactions SET state = 'FINALIZED' WHERE id = $1`,
    [transactionId],
  );
  await server.pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, attempt_id, operation_key, kind, state,
        message_hash, serialized_transaction, recent_blockhash,
        last_valid_block_height, asset_address, estimated_cost_lamports,
        estimated_at, cost_breakdown)
     VALUES ($1, 'devnet', $2, $3, $4, 'USER_MINT', 'PREPARED', $5, $6,
             '11111111111111111111111111111111', 12345, $7, 5000,
             CURRENT_TIMESTAMP, '{}'::jsonb)`,
    [
      randomUUID(),
      ids.releaseId,
      attemptId,
      `claim:${attemptId}:MINT`,
      mintFixture.messageHash,
      mintFixture.preparedBytes,
      mintFixture.assetAddress,
    ],
  );
  const replay = await request(
    `/seasons/${ids.seasonId}/nft/claim-attempts/${attemptId}/transactions`,
    owner,
    { method: 'POST', body },
  );
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.data.state, 'AWAITING_SIGNATURE');
  assert.equal(replay.body.data.signature, accepted.body.data.signature);
});
