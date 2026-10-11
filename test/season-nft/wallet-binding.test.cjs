require('reflect-metadata');
const assert = require('node:assert/strict');
const {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} = require('node:fs/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { test } = require('node:test');
const { Global, Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { createSignInMessage } = require('@solana/wallet-standard-util');
const { ed25519 } = require('@noble/curves/ed25519');
const bs58 = require('bs58').default;
const { BusinessError } = require('../../dist/business-error');
const { AuthModule } = require('../../dist/modules/auth/auth.module');
const {
  CreateChallengeUseCase,
} = require('../../dist/modules/auth/features/create-challenge/create-challenge.use-case');
const {
  LoginUseCase,
} = require('../../dist/modules/auth/features/login/login.use-case');
const {
  MeUseCase,
} = require('../../dist/modules/auth/features/me/me.use-case');
const {
  CreateSeasonUseCase,
} = require('../../dist/modules/seasons/features/create-season/create-season.use-case');
const {
  JoinSeasonUseCase,
} = require('../../dist/modules/seasons/features/join-season/join-season.use-case');
const { SeasonsModule } = require('../../dist/modules/seasons/seasons.module');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');

const origin = 'http://localhost:5173';
let fixturePromise;

/** AuthModule과 SeasonsModule을 실제 repository 및 격리 PostgreSQL에 연결한다. */
async function fixture() {
  fixturePromise ??= (async () => {
    const database = await testDatabaseModule();
    class TestConfigModule {}
    Global()(TestConfigModule);
    Module({
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService({
            app: { nodeEnv: 'test' },
            cors: { originList: [origin] },
            realtime: { maxConnections: 20 },
            canvasSnapshot: { enabled: false, intervalMs: 3_600_000 },
          }),
        },
      ],
      exports: [ConfigService],
    })(TestConfigModule);
    class WalletBindingTestModule {}
    Module({
      imports: [TestConfigModule, database.module, AuthModule, SeasonsModule],
    })(WalletBindingTestModule);
    const app = await NestFactory.createApplicationContext(
      WalletBindingTestModule,
      { logger: false },
    );
    return { app, pool: database.pool };
  })();
  return fixturePromise;
}

test.after(async () => {
  const current = await fixturePromise;
  await current?.app.close();
});

/** 실제 Ed25519 키로 서버 발급 SIWS 메시지를 서명해 로그인한다. */
async function signIn(privateKey) {
  const { app } = await fixture();
  const address = bs58.encode(ed25519.getPublicKey(privateKey));
  const challenge = await app
    .get(CreateChallengeUseCase)
    .execute(origin, undefined);
  const signedMessage = createSignInMessage({
    ...challenge.signInInput,
    address,
  });
  const result = await app.get(LoginUseCase).execute({
    challengeId: challenge.challengeId,
    address,
    signedMessage,
    signature: ed25519.sign(signedMessage, privateKey),
    origin,
    browserBinding: challenge.browserBinding,
    previousToken: undefined,
  });
  assert.equal(result.outcome, 'authenticated');
  return { ...result, address };
}

/** 테스트 사용자의 두 번째 지갑을 연결해 wallets 정렬과 activeWallet을 분리한다. */
async function linkWallet(userId, privateKey) {
  const { pool } = await fixture();
  const address = bs58.encode(ed25519.getPublicKey(privateKey));
  const wallet = await pool.query(
    `INSERT INTO user_wallets
       (user_id, chain_namespace, address, address_key, created_at)
     VALUES ($1, 'solana', $2, $2, clock_timestamp() + interval '1 second')
     RETURNING id`,
    [userId, address],
  );
  return { id: wallet.rows[0].id, address };
}

test('migration refuses legacy sessions instead of guessing a wallet', async () => {
  const { pool } = await fixture();
  const client = await pool.connect();
  const migration = await readFile(
    resolve(
      __dirname,
      '../../db/migrations/2026-10-09-01-season-participation-wallets.sql',
    ),
    'utf8',
  );
  try {
    await client.query('BEGIN');
    await client.query(
      'ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_user_wallet_fk, DROP COLUMN wallet_account_id',
    );
    const user = await client.query(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    await client.query(
      `INSERT INTO auth_sessions (user_id, token_hash)
       VALUES ($1, $2)`,
      [user.rows[0].id, 'a'.repeat(64)],
    );
    await assert.rejects(client.query(migration), (error) => {
      assert.match(error.message, /no verified wallet binding/);
      return true;
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('migration refuses legacy participants instead of guessing a wallet', async () => {
  const { pool } = await fixture();
  const client = await pool.connect();
  const migration = await readFile(
    resolve(
      __dirname,
      '../../db/migrations/2026-10-09-01-season-participation-wallets.sql',
    ),
    'utf8',
  );
  try {
    await client.query('BEGIN');
    await client.query(
      `ALTER TABLE season_participants
       DROP COLUMN wallet_account_id, DROP COLUMN wallet_address`,
    );
    const user = await client.query(
      'INSERT INTO users DEFAULT VALUES RETURNING id',
    );
    const canvasId = randomUUID();
    await client.query(
      `INSERT INTO canvases
         (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
       VALUES ($1, 'season', 1000, 1000, 1, NOW(), NOW() + interval '1 day')`,
      [canvasId],
    );
    await client.query(
      `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
       VALUES ($1, $2, 'Legacy participant', 2)`,
      [canvasId, user.rows[0].id],
    );
    await client.query(
      'INSERT INTO season_participants (season_id, user_id) VALUES ($1, $2)',
      [canvasId, user.rows[0].id],
    );
    await assert.rejects(client.query(migration), (error) => {
      assert.match(error.message, /no verified wallet binding/);
      return true;
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('composite wallet foreign keys reject another user wallet', async () => {
  const { pool } = await fixture();
  const users = await pool.query(
    `INSERT INTO users DEFAULT VALUES RETURNING id`,
  );
  const other = await pool.query(
    `INSERT INTO users DEFAULT VALUES RETURNING id`,
  );
  const address = bs58.encode(randomBytes(32));
  const wallet = await pool.query(
    `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
     VALUES ($1, 'solana', $2, $2) RETURNING id`,
    [other.rows[0].id, address],
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO auth_sessions (user_id, wallet_account_id, token_hash)
       VALUES ($1, $2, $3)`,
      [users.rows[0].id, wallet.rows[0].id, 'b'.repeat(64)],
    ),
    (error) => error.code === '23503',
  );
});

test('participant wallet tuple rejects an address from another wallet', async () => {
  const { pool } = await fixture();
  const user = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0];
  const walletAddress = bs58.encode(randomBytes(32));
  const otherAddress = bs58.encode(randomBytes(32));
  const wallet = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [user.id, walletAddress],
    )
  ).rows[0];
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 1, NOW(), NOW() + interval '1 day')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Wallet tuple guard', 2)`,
    [seasonId, user.id],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO season_participants
         (season_id, user_id, wallet_account_id, wallet_address)
       VALUES ($1, $2, $3, $4)`,
      [seasonId, user.id, wallet.id, otherAddress],
    ),
    (error) => error.code === '23503',
  );
});

test('duplicate season wallet address returns SQLSTATE 23505', async () => {
  const { pool } = await fixture();
  const firstUser = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0];
  const secondUser = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0];
  const firstAddress = bs58.encode(randomBytes(32));
  const secondAddress = bs58.encode(randomBytes(32));
  const firstWallet = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [firstUser.id, firstAddress],
    )
  ).rows[0];
  const secondWallet = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [secondUser.id, secondAddress],
    )
  ).rows[0];
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 1000, 1000, 1, NOW(), NOW() + interval '1 day')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Duplicate wallet guard', 2)`,
    [seasonId, firstUser.id],
  );
  await pool.query(
    `INSERT INTO season_participants
       (season_id, user_id, wallet_account_id, wallet_address)
     VALUES ($1, $2, $3, $4)`,
    [seasonId, firstUser.id, firstWallet.id, firstAddress],
  );

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FK trigger를 잠시 끄고 동일 시즌·주소 unique constraint만 직접 검증한다.
    await client.query('ALTER TABLE season_participants DISABLE TRIGGER ALL');
    await assert.rejects(
      client.query(
        `INSERT INTO season_participants
           (season_id, user_id, wallet_account_id, wallet_address)
         VALUES ($1, $2, $3, $4)`,
        [seasonId, secondUser.id, secondWallet.id, firstAddress],
      ),
      (error) => error.code === '23505',
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('login and me expose the signed wallet even when it is not first', async () => {
  const first = await signIn(ed25519.utils.randomSecretKey());
  const secondKey = ed25519.utils.randomSecretKey();
  const second = await linkWallet(first.user.id, secondKey);
  const secondLogin = await signIn(secondKey);

  assert.equal(secondLogin.user.wallets[0].address, first.address);
  assert.deepEqual(secondLogin.activeWallet, {
    id: second.id,
    chainNamespace: 'solana',
    address: second.address,
  });
  const me = await (
    await fixture()
  ).app
    .get(MeUseCase)
    .execute(secondLogin.token);
  assert.equal(me.outcome, 'authenticated');
  assert.deepEqual(me.activeWallet, secondLogin.activeWallet);
});

test('season creation and join persist each authenticated wallet', async () => {
  const creator = await signIn(ed25519.utils.randomSecretKey());
  const member = await signIn(ed25519.utils.randomSecretKey());
  const { app, pool } = await fixture();
  const season = await app
    .get(CreateSeasonUseCase)
    .execute(origin, creator.token, {
      title: 'Wallet binding season',
      capacity: 3,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  await app.get(JoinSeasonUseCase).execute(origin, member.token, season.id);

  const rows = await pool.query(
    `SELECT user_id, wallet_account_id, wallet_address
     FROM season_participants WHERE season_id = $1 ORDER BY joined_at`,
    [season.id],
  );
  assert.deepEqual(
    rows.rows.map((row) => [row.user_id, row.wallet_address]),
    [
      [creator.user.id, creator.address],
      [member.user.id, member.address],
    ],
  );
  assert.ok(rows.rows.every((row) => row.wallet_account_id));
});

test('rejoin with another authenticated wallet is rejected without changing participation', async () => {
  const original = await signIn(ed25519.utils.randomSecretKey());
  const alternateKey = ed25519.utils.randomSecretKey();
  await linkWallet(original.user.id, alternateKey);
  const alternate = await signIn(alternateKey);
  const { app, pool } = await fixture();
  const season = await app
    .get(CreateSeasonUseCase)
    .execute(origin, original.token, {
      title: 'Immutable participant wallet',
      capacity: 2,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });

  const repeated = await app
    .get(JoinSeasonUseCase)
    .execute(origin, original.token, season.id);
  assert.equal(repeated.participantCount, 1);

  await assert.rejects(
    app.get(JoinSeasonUseCase).execute(origin, alternate.token, season.id),
    (error) => {
      assert.ok(error instanceof BusinessError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'SEASON_PARTICIPATION_WALLET_MISMATCH');
      assert.equal(
        error.message,
        'Use the wallet that originally joined this season.',
      );
      return true;
    },
  );
  const saved = await pool.query(
    `SELECT wallet_address, count(*) OVER ()::integer AS participant_count
     FROM season_participants
     WHERE season_id = $1 AND user_id = $2`,
    [season.id, original.user.id],
  );
  assert.equal(saved.rows[0].wallet_address, original.address);
  assert.equal(saved.rows[0].participant_count, 1);
});

test('a session whose wallet relation disappears is invalid', async () => {
  const login = await signIn(ed25519.utils.randomSecretKey());
  const { app, pool } = await fixture();
  const otherUser = await pool.query(
    'INSERT INTO users DEFAULT VALUES RETURNING id',
  );
  const otherAddress = bs58.encode(randomBytes(32));
  const otherWallet = await pool.query(
    `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
     VALUES ($1, 'solana', $2, $2) RETURNING id`,
    [otherUser.rows[0].id, otherAddress],
  );
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE auth_sessions DISABLE TRIGGER ALL');
    await client.query(
      `UPDATE auth_sessions SET wallet_account_id = $2
       WHERE wallet_account_id = $1`,
      [login.activeWallet.id, otherWallet.rows[0].id],
    );
  } finally {
    await client.query('ALTER TABLE auth_sessions ENABLE TRIGGER ALL');
    client.release();
  }
  const me = await app.get(MeUseCase).execute(login.token);
  assert.deepEqual(me, { outcome: 'invalid' });
});

test('reset dry-run preserves data and apply removes only development season state', async () => {
  const {
    resetDevelopmentSeasons,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-root-'));
  const manifestPath = join(root, 'reset-manifest.json');
  const season = (
    await pool.query(
      'SELECT canvas_id AS id FROM seasons ORDER BY canvas_id LIMIT 1',
    )
  ).rows[0];
  assert.ok(season);
  const snapshotId = randomUUID();
  const directoryKey = `snapshots/seasons/${season.id}/${snapshotId}`;
  const directory = join(root, directoryKey);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'image.png'), 'image');
  await writeFile(join(directory, 'continuation.json'), '{}');
  await pool.query(
    `INSERT INTO canvas_snapshots
      (id, canvas_id, through_sequence, renderer_version, width, height,
       status, image_key, continuation_key, image_bytes, continuation_bytes,
       image_sha256, continuation_sha256, continuation_schema_version,
       captured_at)
     VALUES ($1, $2, 0, 'reset-test', 1, 1, 'READY', $3, $4, 5, 2,
             $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      season.id,
      `${directoryKey}/image.png`,
      `${directoryKey}/continuation.json`,
      '0'.repeat(64),
    ],
  );
  const before = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM users) AS users,
       (SELECT count(*)::integer FROM user_wallets) AS wallets,
       (SELECT count(*)::integer FROM canvases WHERE type = 'main') AS "mainCanvases",
       (SELECT count(*)::integer FROM seasons) AS seasons,
       (SELECT count(*)::integer FROM auth_sessions) AS sessions`,
  );

  const dryRun = await resetDevelopmentSeasons({ pool, apply: false });
  assert.equal(dryRun.status, 'DRY_RUN');
  assert.deepEqual(dryRun.countsBefore, before.rows[0]);
  assert.deepEqual(
    (
      await pool.query(
        'SELECT count(*)::integer AS seasons, (SELECT count(*)::integer FROM auth_sessions) AS sessions FROM seasons',
      )
    ).rows[0],
    { seasons: before.rows[0].seasons, sessions: before.rows[0].sessions },
  );

  const applied = await resetDevelopmentSeasons({
    pool,
    apply: true,
    expectedSeasonCount: before.rows[0].seasons,
    manifestPath,
    snapshotRoot: root,
  });
  assert.equal(applied.status, 'APPLIED');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.databaseDeletionCommitted, true);
  assert.deepEqual(manifest.countsBefore, before.rows[0]);
  assert.equal(manifest.files.length, 1);
  await assert.rejects(access(join(directory, 'image.png')), /ENOENT/);
  await assert.rejects(access(join(directory, 'continuation.json')), /ENOENT/);
  const after = (
    await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM users) AS users,
         (SELECT count(*)::integer FROM user_wallets) AS wallets,
         (SELECT count(*)::integer FROM canvases WHERE type = 'main') AS "mainCanvases",
         (SELECT count(*)::integer FROM seasons) AS seasons,
         (SELECT count(*)::integer FROM auth_sessions) AS sessions`,
    )
  ).rows[0];
  assert.deepEqual(after, {
    users: before.rows[0].users,
    wallets: before.rows[0].wallets,
    mainCanvases: before.rows[0].mainCanvases,
    seasons: 0,
    sessions: 0,
  });

  // 기존 manifest 경로는 새 세션을 지우기 전에 거절하며 파일도 덮어쓰지 않는다.
  await signIn(ed25519.utils.randomSecretKey());
  const existingManifest = await readFile(manifestPath, 'utf8');
  await assert.rejects(
    resetDevelopmentSeasons({
      pool,
      apply: true,
      expectedSeasonCount: 0,
      manifestPath,
      snapshotRoot: root,
    }),
    /manifest already exists/,
  );
  assert.equal(
    (await pool.query('SELECT count(*)::integer AS count FROM auth_sessions'))
      .rows[0].count,
    1,
  );
  assert.equal(await readFile(manifestPath, 'utf8'), existingManifest);
});

test('manifest cleanup does not promote an uncommitted zero-season reset', async () => {
  const {
    cleanupManifest,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-uncommitted-'));
  const manifestPath = join(root, 'manifest.json');
  const counts = (
    await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM users) AS users,
         (SELECT count(*)::integer FROM user_wallets) AS wallets,
         (SELECT count(*)::integer FROM canvases WHERE type = 'main') AS "mainCanvases",
         0 AS seasons,
         (SELECT count(*)::integer FROM auth_sessions) AS sessions`,
    )
  ).rows[0];
  assert.ok(counts.sessions > 0);
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seasonIds: [],
      files: [],
      countsBefore: counts,
      databaseDeletionCommitted: false,
    }),
  );

  await assert.rejects(
    cleanupManifest({ pool, manifestPath, snapshotRoot: root }),
    /Protected data counts changed or reset targets remain/,
  );
  assert.equal(
    JSON.parse(await readFile(manifestPath, 'utf8')).databaseDeletionCommitted,
    false,
  );
});

test('manifest cleanup rejects a missing countsBefore field', async () => {
  const {
    cleanupManifest,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-invalid-counts-'));
  const manifestPath = join(root, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seasonIds: [],
      files: [],
      countsBefore: {
        users: 0,
        wallets: 0,
        seasons: 0,
        sessions: 0,
      },
      databaseDeletionCommitted: false,
    }),
  );

  await assert.rejects(
    cleanupManifest({ pool, manifestPath, snapshotRoot: root }),
    /reset manifest is invalid/,
  );
});

test('reset refuses apply when the expected season count differs', async () => {
  const {
    resetDevelopmentSeasons,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-count-mismatch-'));
  const count = (
    await pool.query('SELECT count(*)::integer AS count FROM seasons')
  ).rows[0].count;

  await assert.rejects(
    resetDevelopmentSeasons({
      pool,
      apply: true,
      expectedSeasonCount: count + 1,
      manifestPath: join(root, 'manifest.json'),
      snapshotRoot: root,
    }),
    (error) => error.code === 'SEASON_COUNT_MISMATCH',
  );
  await assert.rejects(access(join(root, 'manifest.json')), /ENOENT/);
});

test('reset refuses when an NFT release exists', async () => {
  const {
    resetDevelopmentSeasons,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
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
     VALUES ($1, $2, 'Release reset guard', 2)`,
    [seasonId, userId],
  );
  try {
    await pool.query(
      `INSERT INTO season_nft_releases
         (id, season_id, network, state, stage)
       VALUES ($1, $2, 'devnet', 'WAITING_SNAPSHOT', 'SNAPSHOT')`,
      [randomUUID(), seasonId],
    );
    await assert.rejects(
      resetDevelopmentSeasons({ pool, apply: false }),
      (error) => error.code === 'NFT_RELEASES_EXIST',
    );
  } finally {
    await pool.query('DELETE FROM season_nft_releases WHERE season_id = $1', [
      seasonId,
    ]);
    await pool.query('DELETE FROM seasons WHERE canvas_id = $1', [seasonId]);
    await pool.query('DELETE FROM canvases WHERE id = $1', [seasonId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

test('manifest cleanup rejects a symlink that leaves the snapshot root', async () => {
  const {
    cleanupManifest,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-symlink-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'cameo-reset-outside-'));
  const seasonId = randomUUID();
  const snapshotId = randomUUID();
  const seasonDirectory = join(root, 'snapshots', 'seasons', seasonId);
  await mkdir(seasonDirectory, { recursive: true });
  await writeFile(join(outside, 'image.png'), 'keep');
  await writeFile(join(outside, 'continuation.json'), 'keep');
  await symlink(outside, join(seasonDirectory, snapshotId));
  const manifestPath = join(root, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seasonIds: [seasonId],
      files: [
        {
          imageKey: `snapshots/seasons/${seasonId}/${snapshotId}/image.png`,
          continuationKey: `snapshots/seasons/${seasonId}/${snapshotId}/continuation.json`,
        },
      ],
      countsBefore: {
        users: 0,
        wallets: 0,
        mainCanvases: 0,
        seasons: 1,
        sessions: 0,
      },
      databaseDeletionCommitted: true,
    }),
  );

  await assert.rejects(
    cleanupManifest({ pool, manifestPath, snapshotRoot: root }),
    /symlink|outside the snapshot root/,
  );
  assert.equal(await readFile(join(outside, 'image.png'), 'utf8'), 'keep');
});

test('manifest cleanup rejects a symlink to main snapshot data inside the root', async () => {
  const {
    cleanupManifest,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-main-alias-'));
  const seasonId = randomUUID();
  const mainId = randomUUID();
  const snapshotId = randomUUID();
  const mainDirectory = join(root, 'snapshots', 'main', mainId, snapshotId);
  await mkdir(mainDirectory, { recursive: true });
  await writeFile(join(mainDirectory, 'image.png'), 'main-image');
  await writeFile(join(mainDirectory, 'continuation.json'), 'main-state');
  const seasonDirectory = join(root, 'snapshots', 'seasons', seasonId);
  await mkdir(seasonDirectory, { recursive: true });
  await symlink(mainDirectory, join(seasonDirectory, snapshotId));
  const manifestPath = join(root, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seasonIds: [seasonId],
      files: [
        {
          imageKey: `snapshots/seasons/${seasonId}/${snapshotId}/image.png`,
          continuationKey: `snapshots/seasons/${seasonId}/${snapshotId}/continuation.json`,
        },
      ],
      countsBefore: {
        users: 0,
        wallets: 0,
        mainCanvases: 1,
        seasons: 1,
        sessions: 0,
      },
      databaseDeletionCommitted: true,
    }),
  );

  await assert.rejects(
    cleanupManifest({ pool, manifestPath, snapshotRoot: root }),
    /symlink|outside the snapshot root/,
  );
  assert.equal(
    await readFile(join(mainDirectory, 'image.png'), 'utf8'),
    'main-image',
  );
});

test('manifest cleanup rejects file keys owned by a season absent from the manifest', async () => {
  const {
    cleanupManifest,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'cameo-reset-owner-'));
  const manifestSeasonId = randomUUID();
  const fileSeasonId = randomUUID();
  const snapshotId = randomUUID();
  const directory = join(
    root,
    'snapshots',
    'seasons',
    fileSeasonId,
    snapshotId,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'image.png'), 'keep');
  await writeFile(join(directory, 'continuation.json'), 'keep');
  const manifestPath = join(root, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      seasonIds: [manifestSeasonId],
      files: [
        {
          imageKey: `snapshots/seasons/${fileSeasonId}/${snapshotId}/image.png`,
          continuationKey: `snapshots/seasons/${fileSeasonId}/${snapshotId}/continuation.json`,
        },
      ],
      countsBefore: {
        users: 0,
        wallets: 0,
        mainCanvases: 1,
        seasons: 1,
        sessions: 0,
      },
      databaseDeletionCommitted: true,
    }),
  );

  await assert.rejects(
    cleanupManifest({ pool, manifestPath, snapshotRoot: root }),
    /does not belong to a manifest season/,
  );
  assert.equal(await readFile(join(directory, 'image.png'), 'utf8'), 'keep');
});

test('reset rejects a corrupt season row attached to the main canvas', async () => {
  const {
    resetDevelopmentSeasons,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const { pool } = await fixture();
  const main = (await pool.query("SELECT id FROM canvases WHERE type = 'main'"))
    .rows[0].id;
  const creator = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const snapshotId = randomUUID();
  const key = `snapshots/main/${main}/${snapshotId}`;
  await pool.query(
    `INSERT INTO canvas_snapshots
      (id, canvas_id, through_sequence, renderer_version, width, height,
       status, image_key, continuation_key, image_bytes, continuation_bytes,
       image_sha256, continuation_sha256, continuation_schema_version,
       captured_at)
     VALUES ($1, $2, 0, 'main-preservation-test', 1, 1, 'READY', $3, $4,
             1, 1, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      main,
      `${key}/image.png`,
      `${key}/continuation.json`,
      '1'.repeat(64),
    ],
  );
  const client = await pool.connect();
  try {
    await client.query(
      'ALTER TABLE seasons DROP CONSTRAINT seasons_canvas_type_check',
    );
    await client.query('ALTER TABLE seasons DISABLE TRIGGER ALL');
    await client.query(
      `INSERT INTO seasons
         (canvas_id, canvas_type, creator_id, title, capacity)
       VALUES ($1, 'season', $2, 'Corrupt main target', 2)`,
      [main, creator],
    );
    await client.query('ALTER TABLE seasons ENABLE TRIGGER ALL');

    await assert.rejects(
      resetDevelopmentSeasons({ pool, apply: false }),
      /not backed by a season canvas/,
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::integer AS count FROM canvas_snapshots WHERE id = $1',
          [snapshotId],
        )
      ).rows[0].count,
      1,
    );
  } finally {
    await client.query('ALTER TABLE seasons DISABLE TRIGGER ALL');
    await client.query('DELETE FROM seasons WHERE canvas_id = $1', [main]);
    await client.query('ALTER TABLE seasons ENABLE TRIGGER ALL');
    await client.query(
      "ALTER TABLE seasons ADD CONSTRAINT seasons_canvas_type_check CHECK (canvas_type = 'season')",
    );
    client.release();
  }
});

test('reset rejects a stored snapshot key owned by another season before deletion', async () => {
  const {
    resetDevelopmentSeasons,
  } = require('../../scripts/season-nft/reset-development-seasons.cjs');
  const login = await signIn(ed25519.utils.randomSecretKey());
  const { app, pool } = await fixture();
  const season = await app
    .get(CreateSeasonUseCase)
    .execute(origin, login.token, {
      title: 'Snapshot ownership guard',
      capacity: 2,
      endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
  const otherSeasonId = randomUUID();
  const snapshotId = randomUUID();
  const key = `snapshots/seasons/${otherSeasonId}/${snapshotId}`;
  await pool.query(
    `INSERT INTO canvas_snapshots
      (id, canvas_id, through_sequence, renderer_version, width, height,
       status, image_key, continuation_key, image_bytes, continuation_bytes,
       image_sha256, continuation_sha256, continuation_schema_version,
       captured_at)
     VALUES ($1, $2, 0, 'wrong-owner-test', 1, 1, 'READY', $3, $4,
             1, 1, $5, $5, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      season.id,
      `${key}/image.png`,
      `${key}/continuation.json`,
      '2'.repeat(64),
    ],
  );

  await assert.rejects(
    resetDevelopmentSeasons({ pool, apply: false }),
    /does not belong to a manifest season/,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::integer AS count FROM seasons WHERE canvas_id = $1',
        [season.id],
      )
    ).rows[0].count,
    1,
  );
});
