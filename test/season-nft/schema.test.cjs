const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const bs58 = require('bs58').default;
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');

async function insertUserWallet(pool) {
  const user = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0];
  const address = bs58.encode(randomBytes(32));
  const wallet = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [user.id, address],
    )
  ).rows[0];
  return {
    userId: user.id,
    walletAccountId: wallet.id,
    walletAddress: address,
  };
}

async function insertSeasonSnapshot(pool, creatorId) {
  const seasonId = randomUUID();
  const snapshotId = randomUUID();
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
     VALUES ($1, $2, 'NFT persistence season', 2)`,
    [seasonId, creatorId],
  );
  const directory = `snapshots/seasons/${seasonId}/${snapshotId}`;
  await pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 0, 'nft-schema-test', 1000, 1000, 'READY', true,
             $3, $4, 1, 1, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `${directory}/image.png`,
      `${directory}/continuation.json`,
      'a'.repeat(64),
    ],
  );
  return { seasonId, snapshotId };
}

async function insertRelease(pool, input) {
  const id = input.id ?? randomUUID();
  await pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, snapshot_id, through_sequence,
        eligible_count, frozen_title, season_ended_at, asset_name,
        image_byte_length, image_sha256, metadata_sha256, image_uri,
        metadata_uri, collection_address, candy_machine_address,
        candy_guard_address, merkle_root, locked_at, ready_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
             CURRENT_TIMESTAMP - interval '1 day', $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      id,
      input.seasonId,
      input.network ?? 'devnet',
      input.state ?? 'PREPARING',
      input.stage ?? 'FROZEN',
      input.snapshotId ?? null,
      input.snapshotId ? 0 : null,
      Object.hasOwn(input, 'eligibleCount')
        ? input.eligibleCount
        : input.snapshotId
          ? 1
          : null,
      input.snapshotId ? 'Frozen title' : null,
      input.ready ? 'Cameo season' : null,
      input.ready ? 1 : null,
      input.ready ? 'b'.repeat(64) : null,
      input.ready ? 'c'.repeat(64) : null,
      input.ready ? 'https://arweave.net/image' : null,
      input.ready ? 'https://arweave.net/metadata' : null,
      input.ready ? bs58.encode(randomBytes(32)) : null,
      input.ready ? bs58.encode(randomBytes(32)) : null,
      input.ready ? bs58.encode(randomBytes(32)) : null,
      input.ready ? randomBytes(32) : null,
      input.ready ? new Date() : null,
      input.ready ? new Date() : null,
    ],
  );
  return id;
}

async function insertClaim(pool, input) {
  const id = input.id ?? randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, receipt_state)
     VALUES ($1, $2, $3, $4, $5, $6, 'UNCLAIMED', '[]'::jsonb, 'NONE')`,
    [
      id,
      input.releaseId,
      input.network ?? 'devnet',
      input.userId,
      input.walletAccountId,
      input.walletAddress,
    ],
  );
  return id;
}

test('NFT migration creates five RLS tables and receipt due index', async () => {
  const { pool } = await testDatabaseModule();
  const tables = await pool.query(
    `SELECT relname, relrowsecurity
     FROM pg_class
     WHERE relnamespace = 'public'::regnamespace
       AND relname = ANY($1::text[])
     ORDER BY relname`,
    [
      [
        'season_nft_claim_attempts',
        'season_nft_claims',
        'season_nft_releases',
        'season_nft_transactions',
        'season_nft_uploads',
      ],
    ],
  );
  assert.equal(tables.rows.length, 5);
  assert.ok(tables.rows.every((row) => row.relrowsecurity));
  const index = await pool.query(
    `SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = 'season_nft_claim_receipt_due_idx'`,
  );
  assert.equal(index.rows.length, 1);
  assert.match(index.rows[0].indexdef, /receipt_next_check_at, id/);
  assert.match(index.rows[0].indexdef, /state = 'CLAIMED'/);
  assert.match(index.rows[0].indexdef, /receipt_state = 'RESOLVING'/);
  assert.doesNotMatch(index.rows[0].indexdef, /CURRENT_TIMESTAMP/);
});

test('release constraints reject duplicate network, cross-season snapshot, and incomplete READY', async () => {
  const { pool } = await testDatabaseModule();
  const owner = await insertUserWallet(pool);
  const first = await insertSeasonSnapshot(pool, owner.userId);
  const second = await insertSeasonSnapshot(pool, owner.userId);
  await insertRelease(pool, { seasonId: first.seasonId });
  await assert.rejects(
    insertRelease(pool, { seasonId: first.seasonId }),
    (error) => error.code === '23505',
  );
  await assert.rejects(
    insertRelease(pool, {
      seasonId: second.seasonId,
      snapshotId: first.snapshotId,
    }),
    (error) => error.code === '23503',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_releases
         (id, season_id, network, state, stage)
       VALUES ($1, $2, 'mainnet-beta', 'READY', 'LOCKED')`,
      [randomUUID(), first.seasonId],
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    insertRelease(pool, {
      seasonId: first.seasonId,
      network: 'mainnet-beta',
      state: 'READY',
      stage: 'LOCKED',
      snapshotId: first.snapshotId,
      eligibleCount: null,
      ready: true,
    }),
    (error) => error.code === '23514',
  );
});

test('EMPTY releases require zero eligible users and no published or chain addresses', async () => {
  const { pool } = await testDatabaseModule();
  const owner = await insertUserWallet(pool);
  const season = await insertSeasonSnapshot(pool, owner.userId);
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_releases
         (id, season_id, network, state, stage, snapshot_id,
          through_sequence, eligible_count, frozen_title, season_ended_at)
       VALUES ($1, $2, 'mainnet-beta', 'EMPTY', 'FROZEN', $3, 0, NULL,
               'Empty season', CURRENT_TIMESTAMP)`,
      [randomUUID(), season.seasonId, season.snapshotId],
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_releases
         (id, season_id, network, state, stage, snapshot_id,
          through_sequence, eligible_count, frozen_title, season_ended_at,
          image_uri)
       VALUES ($1, $2, 'devnet', 'EMPTY', 'FROZEN', $3, 0, 1,
               'Empty season', CURRENT_TIMESTAMP, 'https://example.invalid')`,
      [randomUUID(), season.seasonId, season.snapshotId],
    ),
    (error) => error.code === '23514',
  );
  await pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, snapshot_id,
        through_sequence, eligible_count, frozen_title, season_ended_at)
     VALUES ($1, $2, 'devnet', 'EMPTY', 'FROZEN', $3, 0, 0,
             'Empty season', CURRENT_TIMESTAMP)`,
    [randomUUID(), season.seasonId, season.snapshotId],
  );
});

test('claim foreign keys and unique constraints preserve release, user, and wallet identity', async () => {
  const { pool } = await testDatabaseModule();
  const first = await insertUserWallet(pool);
  const second = await insertUserWallet(pool);
  const season = await insertSeasonSnapshot(pool, first.userId);
  const releaseId = await insertRelease(pool, {
    seasonId: season.seasonId,
    snapshotId: season.snapshotId,
  });
  await insertClaim(pool, { releaseId, ...first });
  await assert.rejects(
    insertClaim(pool, { releaseId, ...first }),
    (error) => error.code === '23505',
  );
  await assert.rejects(
    insertClaim(pool, {
      releaseId,
      ...second,
      walletAddress: first.walletAddress,
    }),
    (error) => error.code === '23503' || error.code === '23505',
  );
  await assert.rejects(
    insertClaim(pool, { releaseId, network: 'mainnet-beta', ...second }),
    (error) => error.code === '23503',
  );
  const mainnetReleaseId = await insertRelease(pool, {
    seasonId: season.seasonId,
    snapshotId: season.snapshotId,
    network: 'mainnet-beta',
  });
  await assert.rejects(
    insertClaim(pool, {
      releaseId: mainnetReleaseId,
      network: 'mainnet-beta',
      userId: first.userId,
      walletAccountId: second.walletAccountId,
      walletAddress: second.walletAddress,
    }),
    (error) => error.code === '23503',
  );
});

test('one active attempt and one live or completed operation survive raw concurrent writes', async () => {
  const { pool } = await testDatabaseModule();
  const owner = await insertUserWallet(pool);
  const season = await insertSeasonSnapshot(pool, owner.userId);
  const releaseId = await insertRelease(pool, {
    seasonId: season.seasonId,
    snapshotId: season.snapshotId,
  });
  const claimId = await insertClaim(pool, { releaseId, ...owner });
  const firstAttempt = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, 'QUEUED', 'ALLOWLIST_PROOF')`,
    [firstAttempt, claimId],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
       VALUES ($1, $2, 'CONFIRMING', 'ALLOWLIST_PROOF')`,
      [randomUUID(), claimId],
    ),
    (error) => error.code === '23505',
  );
  await pool.query(
    `UPDATE season_nft_claim_attempts SET state = 'FAILED' WHERE id = $1`,
    [firstAttempt],
  );
  const secondAttempt = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, 'QUEUED', 'ALLOWLIST_PROOF')`,
    [secondAttempt, claimId],
  );
  const transactionId = randomUUID();
  const transactionValues = [
    transactionId,
    releaseId,
    secondAttempt,
    `claim:${secondAttempt}:ALLOWLIST_PROOF`,
    'd'.repeat(64),
    Buffer.from('transaction'),
    'blockhash',
  ];
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, attempt_id, operation_key, kind, state,
        message_hash, serialized_transaction, recent_blockhash,
        last_valid_block_height, estimated_cost_lamports, estimated_at)
     VALUES ($1, 'devnet', $2, $3, $4, 'USER_PROOF', 'FINALIZED',
             $5, $6, $7, 10, 1, CURRENT_TIMESTAMP)`,
    transactionValues,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_transactions
         (id, network, release_id, attempt_id, operation_key, kind, state,
          message_hash, serialized_transaction, recent_blockhash,
          last_valid_block_height, estimated_cost_lamports, estimated_at)
       VALUES ($1, 'devnet', $2, $3, $4, 'USER_PROOF', 'PREPARED',
               $5, $6, $7, 10, 1, CURRENT_TIMESTAMP)`,
      [randomUUID(), ...transactionValues.slice(1)],
    ),
    (error) => error.code === '23505',
  );
});

test('transaction quotes, reconciliation evidence, and upload verification are mandatory', async () => {
  const { pool } = await testDatabaseModule();
  const owner = await insertUserWallet(pool);
  const season = await insertSeasonSnapshot(pool, owner.userId);
  const releaseId = await insertRelease(pool, {
    seasonId: season.seasonId,
    snapshotId: season.snapshotId,
  });
  const claimId = await insertClaim(pool, { releaseId, ...owner });
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, 'QUEUED', 'MINT')`,
    [attemptId, claimId],
  );
  const transactionBase = [
    randomUUID(),
    releaseId,
    attemptId,
    `claim:${attemptId}:MINT`,
    'e'.repeat(64),
    Buffer.from('mint'),
  ];
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_transactions
         (id, network, release_id, attempt_id, operation_key, kind, state,
          message_hash, serialized_transaction, recent_blockhash,
          last_valid_block_height)
       VALUES ($1, 'devnet', $2, $3, $4, 'USER_MINT', 'PREPARED',
               $5, $6, 'blockhash', 10)`,
      transactionBase,
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_transactions
         (id, network, release_id, attempt_id, operation_key, kind, state,
          message_hash, serialized_transaction, recent_blockhash,
          last_valid_block_height, estimated_cost_lamports, estimated_at)
       VALUES ($1, 'devnet', $2, $3, $4, 'USER_MINT', 'RECONCILED',
               $5, $6, 'blockhash', 10, 1, CURRENT_TIMESTAMP)`,
      transactionBase,
    ),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO season_nft_uploads
         (id, release_id, kind, sha256, byte_length, data_item_id,
          signed_item_path, state, uri)
       VALUES ($1, $2, 'IMAGE', $3, 1, 'item', 'items/item.bin',
               'VERIFIED', 'https://arweave.net/item')`,
      [randomUUID(), releaseId, 'f'.repeat(64)],
    ),
    (error) => error.code === '23514',
  );
});
