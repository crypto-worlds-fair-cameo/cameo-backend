const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const bs58 = require('bs58').default;
const {
  getMerkleProof,
  getMerkleRoot,
} = require('@metaplex-foundation/mpl-core-candy-machine');
const { publicKey } = require('@metaplex-foundation/umi');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const {
  TransactionRunner,
} = require('../../dist/database/transaction/transaction-runner');
const {
  FinalCanvasSnapshotInvalidError,
  FinalCanvasSnapshotReader,
} = require('../../dist/modules/canvas/resources/canvas-snapshot/final-canvas-snapshot-reader');
const {
  PrepareSeasonNftUseCase,
} = require('../../dist/modules/season-nfts/features/prepare-season-nft/prepare-season-nft.use-case');
const {
  SeasonNftCandidatesQuery,
} = require('../../dist/modules/season-nfts/features/prepare-season-nft/season-nft-candidates.query');
const {
  SEASON_NFT_MERKLE_PASS,
  SeasonNftMerkleArtifacts,
  calculateSeasonNftMerklePass,
} = require('../../dist/modules/season-nfts/features/prepare-season-nft/season-nft-merkle-artifacts');
const {
  SeasonNftRepository,
} = require('../../dist/modules/season-nfts/resources/season-nft/season-nft.repository');

class FinalSnapshotFixture {
  constructor() {
    this.records = new Map();
    this.calls = [];
  }

  async read(seasonId) {
    this.calls.push(seasonId);
    const value = this.records.get(seasonId);
    if (value instanceof Error) throw value;
    return value ?? null;
  }
}

let fixturePromise;

async function fixture() {
  fixturePromise ??= (async () => {
    const database = await testDatabaseModule();
    const reader = new FinalSnapshotFixture();
    const config = new ConfigService({
      seasonNft: { enabled: true, network: 'devnet' },
    });
    class FreezeTestModule {}
    Module({
      imports: [database.module],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: FinalCanvasSnapshotReader, useValue: reader },
        SeasonNftRepository,
        SeasonNftCandidatesQuery,
        {
          provide: SEASON_NFT_MERKLE_PASS,
          useValue: calculateSeasonNftMerklePass,
        },
        SeasonNftMerkleArtifacts,
        PrepareSeasonNftUseCase,
      ],
    })(FreezeTestModule);
    const app = await NestFactory.createApplicationContext(FreezeTestModule, {
      logger: false,
    });
    return {
      app,
      pool: database.pool,
      reader,
      query: app.get(SeasonNftCandidatesQuery),
      releases: app.get(SeasonNftRepository),
      transactions: app.get(TransactionRunner),
      prepare: app.get(PrepareSeasonNftUseCase),
      merkle: app.get(SeasonNftMerkleArtifacts),
      config,
    };
  })();
  return fixturePromise;
}

test.after(async () => {
  const current = await fixturePromise;
  await current?.app.close();
});

async function insertUserWallet(pool, address = bs58.encode(randomBytes(32))) {
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const walletAccountId = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [userId, address],
    )
  ).rows[0].id;
  return { userId, walletAccountId, walletAddress: address };
}

async function insertSeason(
  pool,
  creator,
  { ended = true, cancelled = false, forced = false } = {},
) {
  const seasonId = randomUUID();
  const starts = ended
    ? "CURRENT_TIMESTAMP - interval '2 days'"
    : "CURRENT_TIMESTAMP + interval '1 day'";
  const ends = ended
    ? "CURRENT_TIMESTAMP - interval '1 day'"
    : "CURRENT_TIMESTAMP + interval '2 days'";
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 2, ${starts}, ${ends})`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons
       (canvas_id, creator_id, title, description, capacity,
        cancelled_at, force_ended_at)
     VALUES ($1, $2, 'Frozen season', 'Frozen description', 100,
             CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
             CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END)`,
    [seasonId, creator.userId, cancelled, forced],
  );
  return seasonId;
}

async function insertParticipant(pool, seasonId, actor) {
  await pool.query(
    `INSERT INTO season_participants
       (season_id, user_id, wallet_account_id, wallet_address)
     VALUES ($1, $2, $3, $4)`,
    [seasonId, actor.userId, actor.walletAccountId, actor.walletAddress],
  );
}

async function insertUsage(pool, seasonId, userId, completed = false) {
  await pool.query(
    `INSERT INTO canvas_stroke_usages
       (canvas_id, user_id, client_stroke_id, completed_at)
     VALUES ($1, $2, $3, CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE NULL END)`,
    [seasonId, userId, randomUUID(), completed],
  );
}

async function insertSnapshot(pool, seasonId, throughSequence = 0n) {
  const snapshotId = randomUUID();
  const directory = `snapshots/seasons/${seasonId}/${snapshotId}`;
  await pool.query(
    `UPDATE canvases SET last_chunk_sequence = $2 WHERE id = $1`,
    [seasonId, throughSequence.toString()],
  );
  const endedAt = (
    await pool.query('SELECT ends_at FROM canvases WHERE id = $1', [seasonId])
  ).rows[0].ends_at;
  await pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, $3, 'freeze-test', 1000, 1000, 'READY', true,
             $4, $5, 24, 2, $6, $7, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      throughSequence.toString(),
      `${directory}/image.png`,
      `${directory}/continuation.json`,
      'a'.repeat(64),
      'b'.repeat(64),
    ],
  );
  return {
    canvasId: seasonId,
    snapshotId,
    throughSequence,
    pngBytes: Uint8Array.from({ length: 24 }, (_, index) => index),
    imageSha256: 'a'.repeat(64),
    byteLength: 24n,
    endedAt,
  };
}

async function sourceRow(pool, releaseId) {
  return (
    await pool.query(
      `SELECT state, stage, snapshot_id, through_sequence, eligible_count,
              frozen_title, frozen_description, image_byte_length,
              image_sha256, merkle_root, version, last_error_code
       FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    )
  ).rows[0];
}

test('candidate query includes only normally ended season canvases', async () => {
  const current = await fixture();
  const creator = await insertUserWallet(current.pool);
  const normal = await insertSeason(current.pool, creator);
  await insertSeason(current.pool, creator, { forced: true });
  await insertSeason(current.pool, creator, { cancelled: true });
  await insertSeason(current.pool, creator, { ended: false });

  const candidates = await current.query.findNormallyEnded();

  assert.ok(candidates.includes(normal));
  assert.equal(candidates.length, 1);
});

test('missing final snapshot keeps WAITING_SNAPSHOT and defers the next read by 60 seconds', async () => {
  const current = await fixture();
  const creator = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, creator);
  const before = new Date();

  const result = await current.prepare.execute(seasonId);
  const release = (
    await current.pool.query(
      `SELECT state, stage, next_attempt_at
       FROM season_nft_releases WHERE id = $1`,
      [result.releaseId],
    )
  ).rows[0];

  assert.equal(result.status, 'WAITING_SNAPSHOT');
  assert.equal(release.state, 'WAITING_SNAPSHOT');
  assert.equal(release.stage, 'SNAPSHOT');
  assert.ok(release.next_attempt_at.getTime() >= before.getTime() + 59_000);
});

test('invalid final snapshot blocks with the internal snapshot error code', async () => {
  const current = await fixture();
  const creator = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, creator);
  current.reader.records.set(
    seasonId,
    new FinalCanvasSnapshotInvalidError('Final snapshot hash is invalid.'),
  );

  const result = await current.prepare.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'BLOCKED');
  assert.equal(release.state, 'BLOCKED');
  assert.equal(release.last_error_code, 'NFT_FINAL_SNAPSHOT_INVALID');
});

test('one unfinished usage freezes one SDK Merkle claim and preserves snapshot image identity', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId, false);
  const snapshot = await insertSnapshot(current.pool, seasonId, 3n);
  current.reader.records.set(seasonId, snapshot);

  const result = await current.prepare.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);
  const claims = await current.pool.query(
    `SELECT user_id, wallet_account_id, wallet_address, merkle_proof
     FROM season_nft_claims WHERE release_id = $1`,
    [result.releaseId],
  );
  const expectedRoot = Buffer.from(
    getMerkleRoot([publicKey(actor.walletAddress)]),
  );

  assert.equal(result.status, 'FROZEN');
  assert.equal(release.state, 'PREPARING');
  assert.equal(release.stage, 'FROZEN');
  assert.equal(release.snapshot_id, snapshot.snapshotId);
  assert.equal(release.through_sequence, '3');
  assert.equal(release.eligible_count, 1);
  assert.equal(release.image_byte_length, '24');
  assert.equal(release.image_sha256, snapshot.imageSha256);
  assert.deepEqual(release.merkle_root, expectedRoot);
  assert.deepEqual(claims.rows, [
    {
      user_id: actor.userId,
      wallet_account_id: actor.walletAccountId,
      wallet_address: actor.walletAddress,
      merkle_proof: [],
    },
  ]);
});

test('reverse input order freezes canonical two-member SDK roots and proofs', async () => {
  const current = await fixture();
  const first = await insertUserWallet(
    current.pool,
    bs58.encode(Buffer.alloc(32, 1)),
  );
  const second = await insertUserWallet(
    current.pool,
    bs58.encode(Buffer.alloc(32, 2)),
  );
  const canonical = [first, second].sort((left, right) =>
    left.walletAddress < right.walletAddress ? -1 : 1,
  );
  const seasonId = await insertSeason(current.pool, first);
  for (const actor of [...canonical].reverse()) {
    await insertParticipant(current.pool, seasonId, actor);
    await insertUsage(current.pool, seasonId, actor.userId);
  }
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);

  const result = await current.prepare.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);
  const claims = await current.pool.query(
    `SELECT wallet_address, merkle_proof
     FROM season_nft_claims WHERE release_id = $1
     ORDER BY wallet_address COLLATE "C" ASC`,
    [result.releaseId],
  );
  const keys = canonical.map((actor) => publicKey(actor.walletAddress));

  assert.equal(result.status, 'FROZEN');
  assert.deepEqual(release.merkle_root, Buffer.from(getMerkleRoot(keys)));
  assert.deepEqual(
    claims.rows,
    canonical.map((actor, index) => ({
      wallet_address: actor.walletAddress,
      merkle_proof: getMerkleProof(keys, keys[index]).map((node) => [
        ...node,
      ]),
    })),
  );
});

test('mismatching second Merkle proof calculation aborts before immutable freeze', async () => {
  const current = await fixture();
  const actors = [
    await insertUserWallet(current.pool),
    await insertUserWallet(current.pool),
  ];
  const seasonId = await insertSeason(current.pool, actors[0]);
  for (const actor of actors) {
    await insertParticipant(current.pool, seasonId, actor);
    await insertUsage(current.pool, seasonId, actor.userId);
  }
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);
  let calculations = 0;
  const inconsistentMerkle = new SeasonNftMerkleArtifacts((keys) => {
    calculations += 1;
    const artifacts = calculateSeasonNftMerklePass(keys);
    if (calculations === 1) return artifacts;
    const merkleProofs = artifacts.merkleProofs.map((proof) =>
      proof.map((node) => [...node]),
    );
    merkleProofs[0][0][0] ^= 1;
    return { ...artifacts, merkleProofs };
  });
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    current.releases,
    current.query,
    current.reader,
    inconsistentMerkle,
  );

  await assert.rejects(
    useCase.execute(seasonId),
    /Season NFT Merkle artifacts are not deterministic/,
  );
  const release = (
    await current.pool.query(
      `SELECT id, state, stage, merkle_root, eligible_count
       FROM season_nft_releases WHERE season_id = $1`,
      [seasonId],
    )
  ).rows[0];
  const claims = await current.pool.query(
    'SELECT id FROM season_nft_claims WHERE release_id = $1',
    [release.id],
  );

  assert.equal(calculations, 2);
  assert.deepEqual(
    {
      state: release.state,
      stage: release.stage,
      merkle_root: release.merkle_root,
      eligible_count: release.eligible_count,
    },
    {
      state: 'WAITING_SNAPSHOT',
      stage: 'SNAPSHOT',
      merkle_root: null,
      eligible_count: null,
    },
  );
  assert.equal(claims.rowCount, 0);
});

test('zero usage freezes EMPTY with snapshot image identity and no claims', async () => {
  const current = await fixture();
  const creator = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, creator);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);

  const result = await current.prepare.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);
  const claims = await current.pool.query(
    'SELECT id FROM season_nft_claims WHERE release_id = $1',
    [result.releaseId],
  );

  assert.equal(result.status, 'EMPTY');
  assert.equal(release.state, 'EMPTY');
  assert.equal(release.stage, 'FROZEN');
  assert.equal(release.eligible_count, 0);
  assert.equal(release.image_byte_length, '24');
  assert.equal(release.image_sha256, snapshot.imageSha256);
  assert.equal(release.merkle_root, null);
  assert.equal(claims.rowCount, 0);
});

test('usage without an exact participant wallet blocks instead of filtering the user', async () => {
  const current = await fixture();
  const creator = await insertUserWallet(current.pool);
  const contributor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, creator);
  await insertUsage(current.pool, seasonId, contributor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);

  const result = await current.prepare.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'BLOCKED');
  assert.equal(release.state, 'BLOCKED');
  assert.equal(release.last_error_code, 'NFT_ELIGIBILITY_CORRUPT');
  assert.equal(release.eligible_count, null);
});

test('same-count wallet source change after outside read aborts freeze without partial claims', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const replacement = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);

  const racingQuery = {
    findNormallyEnded: (...args) => current.query.findNormallyEnded(...args),
    readFreezeSource: async (...args) => {
      const source = await current.query.readFreezeSource(...args);
      await current.pool.query(
        `UPDATE season_participants
         SET user_id = $3, wallet_account_id = $4, wallet_address = $5
         WHERE season_id = $1 AND user_id = $2`,
        [
          seasonId,
          actor.userId,
          replacement.userId,
          replacement.walletAccountId,
          replacement.walletAddress,
        ],
      );
      await current.pool.query(
        `UPDATE canvas_stroke_usages SET user_id = $3
         WHERE canvas_id = $1 AND user_id = $2`,
        [seasonId, actor.userId, replacement.userId],
      );
      return source;
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    current.releases,
    racingQuery,
    current.reader,
    current.merkle,
  );

  const result = await useCase.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);
  const claims = await current.pool.query(
    'SELECT id FROM season_nft_claims WHERE release_id = $1',
    [result.releaseId],
  );

  assert.equal(result.status, 'RETRY');
  assert.equal(release.state, 'WAITING_SNAPSHOT');
  assert.equal(release.stage, 'SNAPSHOT');
  assert.equal(release.snapshot_id, null);
  assert.equal(claims.rowCount, 0);
});

test('season title change after outside read returns RETRY without freezing stale metadata', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);
  const racingQuery = {
    findNormallyEnded: (...args) => current.query.findNormallyEnded(...args),
    readFreezeSource: async (...args) => {
      const source = await current.query.readFreezeSource(...args);
      await current.pool.query(
        `UPDATE seasons SET title = 'Changed during prepare' WHERE canvas_id = $1`,
        [seasonId],
      );
      return source;
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    current.releases,
    racingQuery,
    current.reader,
    current.merkle,
  );

  const result = await useCase.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'RETRY');
  assert.equal(release.state, 'WAITING_SNAPSHOT');
  assert.equal(release.frozen_title, null);
});

test('snapshot head change after outside read returns RETRY without freezing stale image metadata', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);
  const racingQuery = {
    findNormallyEnded: (...args) => current.query.findNormallyEnded(...args),
    readFreezeSource: async (...args) => {
      const source = await current.query.readFreezeSource(...args);
      await current.pool.query(
        `UPDATE canvases SET last_chunk_sequence = last_chunk_sequence + 1
         WHERE id = $1`,
        [seasonId],
      );
      return source;
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    current.releases,
    racingQuery,
    current.reader,
    current.merkle,
  );

  const result = await useCase.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'RETRY');
  assert.equal(release.state, 'WAITING_SNAPSHOT');
  assert.equal(release.snapshot_id, null);
  assert.equal(release.image_sha256, null);
});

test('season forced during preparation is persistently blocked as ineligible', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);
  const racingQuery = {
    findNormallyEnded: (...args) => current.query.findNormallyEnded(...args),
    readFreezeSource: async (...args) => {
      const source = await current.query.readFreezeSource(...args);
      await current.pool.query(
        `UPDATE seasons SET force_ended_at = CURRENT_TIMESTAMP
         WHERE canvas_id = $1`,
        [seasonId],
      );
      return source;
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    current.releases,
    racingQuery,
    current.reader,
    current.merkle,
  );

  const result = await useCase.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'BLOCKED');
  assert.equal(release.state, 'BLOCKED');
  assert.equal(release.last_error_code, 'NFT_SOURCE_INELIGIBLE');
});

test('freeze CAS loser reports RETRY instead of its uncommitted computed result', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);
  let releaseId;
  const racingReleases = {
    insertCandidate: async (...args) => {
      const result = await current.releases.insertCandidate(...args);
      releaseId = result.releaseId;
      return result;
    },
    freeze: async (...args) => {
      await current.pool.query(
        `UPDATE season_nft_releases SET version = version + 1 WHERE id = $1`,
        [releaseId],
      );
      return current.releases.freeze(...args);
    },
    block: (...args) => current.releases.block(...args),
  };
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    racingReleases,
    current.query,
    current.reader,
    current.merkle,
  );

  const result = await useCase.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'RETRY');
  assert.equal(release.state, 'WAITING_SNAPSHOT');
  assert.equal(release.snapshot_id, null);
});

test('block CAS loser reports RETRY instead of claiming the release is blocked', async () => {
  const current = await fixture();
  const creator = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, creator);
  current.reader.records.set(
    seasonId,
    new FinalCanvasSnapshotInvalidError('Final snapshot hash is invalid.'),
  );
  let releaseId;
  const racingReleases = {
    insertCandidate: async (...args) => {
      const result = await current.releases.insertCandidate(...args);
      releaseId = result.releaseId;
      return result;
    },
    freeze: (...args) => current.releases.freeze(...args),
    block: async (...args) => {
      await current.pool.query(
        `UPDATE season_nft_releases SET version = version + 1 WHERE id = $1`,
        [releaseId],
      );
      return current.releases.block(...args);
    },
  };
  const useCase = new PrepareSeasonNftUseCase(
    current.config,
    current.transactions,
    racingReleases,
    current.query,
    current.reader,
    current.merkle,
  );

  const result = await useCase.execute(seasonId);
  const release = await sourceRow(current.pool, result.releaseId);

  assert.equal(result.status, 'RETRY');
  assert.equal(release.state, 'WAITING_SNAPSHOT');
  assert.equal(release.last_error_code, null);
});

test('frozen retry returns stored result without rereading changed source or replacing claims', async () => {
  const current = await fixture();
  const actor = await insertUserWallet(current.pool);
  const seasonId = await insertSeason(current.pool, actor);
  await insertParticipant(current.pool, seasonId, actor);
  await insertUsage(current.pool, seasonId, actor.userId);
  const snapshot = await insertSnapshot(current.pool, seasonId);
  current.reader.records.set(seasonId, snapshot);
  const first = await current.prepare.execute(seasonId);
  const before = await sourceRow(current.pool, first.releaseId);
  const beforeClaims = await current.pool.query(
    `SELECT user_id, wallet_address, merkle_proof
     FROM season_nft_claims WHERE release_id = $1 ORDER BY user_id`,
    [first.releaseId],
  );
  await current.pool.query(
    `UPDATE seasons SET title = 'Changed after freeze' WHERE canvas_id = $1`,
    [seasonId],
  );
  current.reader.records.set(
    seasonId,
    new Error('Frozen retry must not read snapshot files.'),
  );

  const second = await current.prepare.execute(seasonId);
  const after = await sourceRow(current.pool, first.releaseId);
  const afterClaims = await current.pool.query(
    `SELECT user_id, wallet_address, merkle_proof
     FROM season_nft_claims WHERE release_id = $1 ORDER BY user_id`,
    [first.releaseId],
  );

  assert.equal(second.status, 'FROZEN');
  assert.equal(second.releaseId, first.releaseId);
  assert.equal(after.frozen_title, 'Frozen season');
  assert.deepEqual(after, before);
  assert.deepEqual(afterClaims.rows, beforeClaims.rows);
});
