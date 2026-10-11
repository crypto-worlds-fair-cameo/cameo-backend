#!/usr/bin/env node
const { randomUUID } = require('node:crypto');
const {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

class ResetError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = 'ResetError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** 리셋 전후 보존할 계정·메인 캔버스와 삭제할 시즌·세션 수를 한 번에 읽는다. */
async function readCounts(executor) {
  const result = await executor.query(
    `SELECT
       (SELECT count(*)::integer FROM users) AS users,
       (SELECT count(*)::integer FROM user_wallets) AS wallets,
       (SELECT count(*)::integer FROM canvases WHERE type = 'main') AS "mainCanvases",
       (SELECT count(*)::integer FROM seasons) AS seasons,
       (SELECT count(*)::integer FROM auth_sessions) AS sessions`,
  );
  return result.rows[0];
}

/** 아직 NFT 테이블이 없는 최초 전환도 지원하고, 존재하면 release 한 건부터 리셋을 막는다. */
async function readReleaseCount(executor) {
  const table = await executor.query(
    "SELECT to_regclass('public.season_nft_releases') AS name",
  );
  if (!table.rows[0].name) return 0;
  const result = await executor.query(
    'SELECT count(*)::integer AS count FROM season_nft_releases',
  );
  return result.rows[0].count;
}

/** 현재 시즌과 시즌 스냅샷 파일 key를 삭제 전 manifest 입력으로 읽는다. */
async function readTargets(executor) {
  const seasons = await executor.query(
    `SELECT s.canvas_id AS id, c.type
     FROM seasons s
     LEFT JOIN canvases c ON c.id = s.canvas_id
     ORDER BY s.canvas_id`,
  );
  // 손상된 관계가 main 캔버스 데이터를 삭제 대상으로 바꾸지 못하게 실제 canvas type을 확인한다.
  if (seasons.rows.some(({ type }) => type !== 'season')) {
    throw new ResetError(
      'INVALID_SEASON_TARGET',
      'A season row is not backed by a season canvas; reset was refused.',
    );
  }
  const seasonIds = seasons.rows.map(({ id }) => id);
  if (seasonIds.length === 0) return { seasonIds, files: [] };
  const snapshots = await executor.query(
    `SELECT image_key AS "imageKey", continuation_key AS "continuationKey"
     FROM canvas_snapshots
     WHERE canvas_id = ANY($1::uuid[])
     ORDER BY canvas_id, id`,
    [seasonIds],
  );
  return { seasonIds, files: snapshots.rows };
}

/** 임시 파일을 fsync한 뒤 rename하여 manifest가 부분 JSON으로 보이지 않게 한다. */
async function writeManifest(manifestPath, manifest, exclusive) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const temporary = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) {
      // 같은 디렉터리의 hard link 생성은 기존 manifest를 덮지 않고 원자적으로 이름을 게시한다.
      try {
        await link(temporary, manifestPath);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new ResetError(
            'MANIFEST_EXISTS',
            'The reset manifest already exists. Use a new path or cleanup-manifest.',
          );
        }
        throw error;
      }
      await unlink(temporary);
    } else {
      await rename(temporary, manifestPath);
    }
    // destructive commit 전에 manifest 이름을 포함한 디렉터리 metadata까지 영속화한다.
    const directory = await open(path.dirname(manifestPath), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') throw cleanupError;
    }
    throw error;
  }
}

function isInside(root, candidate) {
  return candidate.startsWith(`${root}${path.sep}`);
}

const UUID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, 'i');
const SEASON_FILE_PATTERN = new RegExp(
  `^snapshots/seasons/(${UUID_PATTERN})/(${UUID_PATTERN})/(image\\.png|continuation\\.json)$`,
  'i',
);

function manifestSeasonSet(seasonIds) {
  const result = new Set(seasonIds);
  if (
    result.size !== seasonIds.length ||
    seasonIds.some(
      (seasonId) => typeof seasonId !== 'string' || !UUID_REGEX.test(seasonId),
    )
  ) {
    throw new ResetError('INVALID_MANIFEST', 'The reset manifest is invalid.');
  }
  return result;
}

/** 모든 파일 key가 같은 snapshot 쌍이며 manifest의 실제 시즌에 속하는지 삭제 전에 확인한다. */
function assertManifestFiles(files, seasonIds) {
  for (const file of files) {
    if (
      !file ||
      typeof file.imageKey !== 'string' ||
      typeof file.continuationKey !== 'string' ||
      path.posix.dirname(file.imageKey) !==
        path.posix.dirname(file.continuationKey) ||
      !file.imageKey.endsWith('/image.png') ||
      !file.continuationKey.endsWith('/continuation.json')
    ) {
      throw new ResetError(
        'INVALID_MANIFEST',
        'The reset manifest is invalid.',
      );
    }
    const image = SEASON_FILE_PATTERN.exec(file.imageKey);
    const continuation = SEASON_FILE_PATTERN.exec(file.continuationKey);
    if (!image || !continuation || image[1] !== continuation[1]) {
      throw new ResetError(
        'INVALID_FILE_KEY',
        'A snapshot manifest key is invalid.',
      );
    }
    if (!seasonIds.has(image[1])) {
      throw new ResetError(
        'FILE_SEASON_MISMATCH',
        'A snapshot manifest key does not belong to a manifest season.',
      );
    }
  }
}

/** 저장된 key의 모든 경로 요소를 확인하고 symlink가 없는 실제 시즌 파일만 반환한다. */
async function resolveManifestFile(root, key, seasonIds) {
  const match = typeof key === 'string' ? SEASON_FILE_PATTERN.exec(key) : null;
  if (!match) {
    throw new ResetError(
      'INVALID_FILE_KEY',
      'A snapshot manifest key is invalid.',
    );
  }
  if (!seasonIds.has(match[1])) {
    throw new ResetError(
      'FILE_SEASON_MISMATCH',
      'A snapshot manifest key does not belong to a manifest season.',
    );
  }
  const candidate = path.resolve(root, key);
  if (!isInside(root, candidate)) {
    throw new ResetError(
      'FILE_OUTSIDE_ROOT',
      'A snapshot file resolves outside the snapshot root.',
    );
  }
  let current = root;
  for (const segment of key.split('/')) {
    current = path.join(current, segment);
    let status;
    try {
      status = await lstat(current);
    } catch (error) {
      // 이미 없는 경로는 이전 cleanup이 완료한 것으로 취급한다.
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new ResetError(
        'FILE_SYMLINK_REFUSED',
        'A snapshot manifest path contains a symlink; file cleanup was refused.',
      );
    }
  }
  const resolved = await realpath(candidate);
  if (!isInside(root, resolved) || resolved !== candidate) {
    throw new ResetError(
      'FILE_OUTSIDE_ROOT',
      'A snapshot file resolves outside the snapshot root.',
    );
  }
  return resolved;
}

function validateManifest(value) {
  const requiredCountNames = [
    'users',
    'wallets',
    'mainCanvases',
    'seasons',
    'sessions',
  ];
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.seasonIds) ||
    !Array.isArray(value.files) ||
    !value.countsBefore ||
    requiredCountNames.some(
      (name) =>
        !Number.isSafeInteger(value.countsBefore[name]) ||
        value.countsBefore[name] < 0,
    ) ||
    value.countsBefore.seasons !== value.seasonIds.length ||
    typeof value.databaseDeletionCommitted !== 'boolean'
  ) {
    throw new ResetError('INVALID_MANIFEST', 'The reset manifest is invalid.');
  }
  return value;
}

/** 삭제 후 DB가 manifest의 보존 수를 유지하고 시즌·세션을 모두 제거했는지 확인한다. */
function hasResetPostconditions(counts, countsBefore) {
  return (
    counts.users === countsBefore.users &&
    counts.wallets === countsBefore.wallets &&
    counts.mainCanvases === countsBefore.mainCanvases &&
    counts.seasons === 0 &&
    counts.sessions === 0
  );
}

/** DB에서 대상 시즌이 사라졌음을 확인한 뒤 manifest에 적힌 파일만 삭제한다. */
async function cleanupManifest({ pool, manifestPath, snapshotRoot }) {
  if (!path.isAbsolute(manifestPath) || !path.isAbsolute(snapshotRoot)) {
    throw new ResetError(
      'ABSOLUTE_PATH_REQUIRED',
      'Manifest and snapshot root paths must be absolute.',
      2,
    );
  }
  const manifest = validateManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')),
  );
  const seasonIds = manifestSeasonSet(manifest.seasonIds);
  assertManifestFiles(manifest.files, seasonIds);
  const remaining = await pool.query(
    `SELECT canvas_id FROM seasons WHERE canvas_id = ANY($1::uuid[]) LIMIT 1`,
    [manifest.seasonIds],
  );
  if (remaining.rows.length > 0) {
    throw new ResetError(
      'SEASONS_STILL_EXIST',
      'Manifest seasons still exist in the database; file cleanup was refused.',
    );
  }
  if (!manifest.databaseDeletionCommitted) {
    // commit 표시가 없으면 전체 삭제 후 조건을 DB에서 증명한 뒤에만 파일 정리를 재개한다.
    const countsAfter = await readCounts(pool);
    if (!hasResetPostconditions(countsAfter, manifest.countsBefore)) {
      throw new ResetError(
        'POST_DELETE_COUNTS_INVALID',
        'Protected data counts changed or reset targets remain; cleanup was refused.',
      );
    }
  }
  const root = await realpath(snapshotRoot);
  const resolvedFiles = [];
  for (const file of manifest.files) {
    resolvedFiles.push(
      await resolveManifestFile(root, file.imageKey, seasonIds),
      await resolveManifestFile(root, file.continuationKey, seasonIds),
    );
  }
  // 모든 key와 경로를 먼저 검증해 뒤쪽의 악성 key가 앞쪽 파일 일부를 지우지 못하게 한다.
  let removedFiles = 0;
  for (const file of resolvedFiles) {
    if (!file) continue;
    try {
      await unlink(file);
      removedFiles += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!manifest.databaseDeletionCommitted) {
    await writeManifest(
      manifestPath,
      { ...manifest, databaseDeletionCommitted: true },
      false,
    );
  }
  return { status: 'CLEANED', removedFiles, manifestPath };
}

/** 기본 dry-run은 수만 조회하고, apply는 manifest 저장 후 시즌 데이터와 구세션을 원자적으로 삭제한다. */
async function resetDevelopmentSeasons({
  pool,
  apply = false,
  expectedSeasonCount,
  manifestPath,
  snapshotRoot,
}) {
  const countsBefore = await readCounts(pool);
  const releaseCount = await readReleaseCount(pool);
  if (releaseCount > 0) {
    throw new ResetError(
      'NFT_RELEASES_EXIST',
      'NFT releases already exist; development season reset was refused.',
    );
  }
  const targets = await readTargets(pool);
  const targetSeasonIds = manifestSeasonSet(targets.seasonIds);
  assertManifestFiles(targets.files, targetSeasonIds);
  if (!apply) {
    return {
      status: 'DRY_RUN',
      countsBefore,
      seasonIds: targets.seasonIds,
      files: targets.files,
    };
  }
  if (
    !Number.isSafeInteger(expectedSeasonCount) ||
    expectedSeasonCount < 0 ||
    expectedSeasonCount !== countsBefore.seasons
  ) {
    throw new ResetError(
      'SEASON_COUNT_MISMATCH',
      `Expected ${expectedSeasonCount} seasons but found ${countsBefore.seasons}.`,
    );
  }
  if (
    typeof manifestPath !== 'string' ||
    typeof snapshotRoot !== 'string' ||
    !path.isAbsolute(manifestPath) ||
    !path.isAbsolute(snapshotRoot)
  ) {
    throw new ResetError(
      'ABSOLUTE_PATH_REQUIRED',
      'Apply requires absolute manifest and snapshot root paths.',
      2,
    );
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    seasonIds: targets.seasonIds,
    files: targets.files,
    countsBefore,
    databaseDeletionCommitted: false,
  };
  await writeManifest(manifestPath, manifest, true);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 서비스 중지 선행 조건과 별개로 시즌·세션·스냅샷 쓰기를 잠가 삭제 대상을 고정한다.
    await client.query(
      `LOCK TABLE seasons, auth_sessions, canvas_snapshots
       IN SHARE ROW EXCLUSIVE MODE`,
    );
    if ((await readReleaseCount(client)) > 0) {
      throw new ResetError(
        'NFT_RELEASES_EXIST',
        'NFT releases appeared before deletion; development season reset was refused.',
      );
    }
    const lockedTargets = await readTargets(client);
    if (
      lockedTargets.seasonIds.length !== expectedSeasonCount ||
      JSON.stringify(lockedTargets.seasonIds) !==
        JSON.stringify(targets.seasonIds) ||
      JSON.stringify(lockedTargets.files) !== JSON.stringify(targets.files)
    ) {
      throw new ResetError(
        'SEASON_COUNT_MISMATCH',
        'Season targets changed before deletion; development season reset was refused.',
      );
    }
    const seasonIds = targets.seasonIds;
    if (seasonIds.length > 0) {
      await client.query(
        'DELETE FROM canvas_stroke_chunks WHERE canvas_id = ANY($1::uuid[])',
        [seasonIds],
      );
      await client.query(
        'DELETE FROM canvas_snapshots WHERE canvas_id = ANY($1::uuid[])',
        [seasonIds],
      );
      await client.query(
        'DELETE FROM season_participants WHERE season_id = ANY($1::uuid[])',
        [seasonIds],
      );
      await client.query(
        'DELETE FROM canvas_stroke_usages WHERE canvas_id = ANY($1::uuid[])',
        [seasonIds],
      );
      await client.query(
        'DELETE FROM seasons WHERE canvas_id = ANY($1::uuid[])',
        [seasonIds],
      );
      await client.query(
        "DELETE FROM canvases WHERE type = 'season' AND id = ANY($1::uuid[])",
        [seasonIds],
      );
    }
    await client.query('DELETE FROM auth_sessions');
    const countsAfter = await readCounts(client);
    if (!hasResetPostconditions(countsAfter, countsBefore)) {
      throw new ResetError(
        'POST_DELETE_COUNTS_INVALID',
        'Protected data counts changed or reset targets remain; transaction was rolled back.',
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await writeManifest(
    manifestPath,
    { ...manifest, databaseDeletionCommitted: true },
    false,
  );
  const cleanup = await cleanupManifest({ pool, manifestPath, snapshotRoot });
  return {
    status: 'APPLIED',
    countsBefore,
    seasonIds: targets.seasonIds,
    removedFiles: cleanup.removedFiles,
    manifestPath,
  };
}

function parseArguments(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--expected-season-count') {
      const value = argv[++index];
      if (!/^(0|[1-9][0-9]*)$/.test(value ?? ''))
        throw new ResetError(
          'INVALID_ARGUMENTS',
          '--expected-season-count requires a non-negative integer.',
          2,
        );
      options.expectedSeasonCount = Number(value);
    } else if (argument === '--manifest') options.manifestPath = argv[++index];
    else if (argument === '--cleanup-manifest')
      options.cleanupManifestPath = argv[++index];
    else if (argument === '--help') options.help = true;
    else
      throw new ResetError(
        'INVALID_ARGUMENTS',
        `Unknown argument: ${argument}`,
        2,
      );
  }
  if (options.cleanupManifestPath && options.apply)
    throw new ResetError(
      'INVALID_ARGUMENTS',
      '--cleanup-manifest cannot be combined with --apply.',
      2,
    );
  if (
    options.apply &&
    (options.expectedSeasonCount === undefined || !options.manifestPath)
  ) {
    throw new ResetError(
      'INVALID_ARGUMENTS',
      '--apply requires --expected-season-count N and --manifest PATH.',
      2,
    );
  }
  return options;
}

function databasePoolFromEnvironment() {
  const ssl = ['true', '1', 'yes', 'y'].includes(
    (process.env.DB_SSL ?? 'false').trim().toLowerCase(),
  );
  return new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'dev',
    password: process.env.DB_PASSWORD ?? 'devpass',
    database: process.env.DB_NAME ?? 'devdb',
    max: 1,
    ssl: ssl ? { ca: process.env.DB_SSL_CA?.replace(/\\n/g, '\n') } : false,
    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS ?? 2000,
    ),
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 10000),
    idle_in_transaction_session_timeout: Number(
      process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 10000,
    ),
  });
}

async function main() {
  let pool;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        'Usage: reset-development-seasons.cjs [--apply --expected-season-count N --manifest ABSOLUTE_PATH | --cleanup-manifest ABSOLUTE_PATH]\n',
      );
      return;
    }
    const snapshotRoot = process.env.CANVAS_SNAPSHOT_STORAGE_ROOT;
    if ((options.apply || options.cleanupManifestPath) && !snapshotRoot) {
      throw new ResetError(
        'SNAPSHOT_ROOT_REQUIRED',
        'CANVAS_SNAPSHOT_STORAGE_ROOT is required for apply or cleanup.',
        2,
      );
    }
    pool = databasePoolFromEnvironment();
    const result = options.cleanupManifestPath
      ? await cleanupManifest({
          pool,
          manifestPath: options.cleanupManifestPath,
          snapshotRoot,
        })
      : await resetDevelopmentSeasons({
          pool,
          apply: options.apply,
          expectedSeasonCount: options.expectedSeasonCount,
          manifestPath: options.manifestPath,
          snapshotRoot,
        });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const known = error instanceof ResetError;
    process.stdout.write(
      `${JSON.stringify({
        status: 'FAILED',
        checks: [
          {
            id: 'DEVELOPMENT_SEASON_RESET',
            status: 'FAIL',
            code: known ? error.code : 'RESET_FAILED',
            message: known ? error.message : 'Development season reset failed.',
          },
        ],
      })}\n`,
    );
    if (!known) process.stderr.write('Development season reset failed.\n');
    process.exitCode = known ? error.exitCode : 1;
  } finally {
    await pool?.end();
  }
}

if (require.main === module) void main();

module.exports = {
  ResetError,
  cleanupManifest,
  resetDevelopmentSeasons,
};
