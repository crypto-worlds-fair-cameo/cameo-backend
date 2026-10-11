#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { constants } = require('node:fs');
const { lstat, open, realpath } = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RPC_RETRY_CAUSES = new Set([
  'NFT_CHAIN_RETRY',
  'NFT_RPC_RETRY',
  'NFT_RPC_AMBIGUOUS',
  'NFT_RPC_INSPECTION_MISSING',
]);

function usage() {
  return [
    'Usage: node scripts/season-nft/retry-release.cjs --release-id <uuid> --network <devnet|mainnet-beta> [--json]',
    '',
    'Reschedules one eligible BLOCKED release while preserving its frozen fields.',
  ].join('\n');
}

function parseArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--release-id') {
      options.releaseId = argv[++index];
    } else if (argument === '--network') {
      options.network = argv[++index];
    } else {
      throw new Error('Invalid retry arguments.');
    }
  }
  if (
    !options.help &&
    (!UUID_PATTERN.test(options.releaseId ?? '') ||
      !['devnet', 'mainnet-beta'].includes(options.network))
  ) {
    throw new Error('Release ID and network are required.');
  }
  return options;
}

function databasePoolFromEnvironment(environment) {
  const ssl = ['true', '1', 'yes', 'y'].includes(
    (environment.DB_SSL ?? 'false').trim().toLowerCase(),
  );
  return new Pool({
    host: environment.DB_HOST ?? 'localhost',
    port: Number(environment.DB_PORT ?? 5432),
    user: environment.DB_USER ?? 'dev',
    password: environment.DB_PASSWORD ?? 'devpass',
    database: environment.DB_NAME ?? 'devdb',
    max: 1,
    ssl: ssl ? { ca: environment.DB_SSL_CA?.replace(/\\n/g, '\n') } : false,
    connectionTimeoutMillis: Number(
      environment.DB_CONNECTION_TIMEOUT_MS ?? 2000,
    ),
    statement_timeout: Number(environment.DB_STATEMENT_TIMEOUT_MS ?? 10000),
    idle_in_transaction_session_timeout: Number(
      environment.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 10000,
    ),
  });
}

function result(status, code, message) {
  return {
    status: status === 'PASS' ? 'PASS' : 'FAIL',
    checks: [{ id: 'RETRY_RELEASE', status, code, message }],
  };
}

function printResult(value, json) {
  process.stdout.write(`${JSON.stringify(value, null, json ? 0 : 2)}\n`);
}

async function assertExistingDist() {
  const artifact = path.join(
    PROJECT_ROOT,
    'dist/modules/season-nfts/resources/season-nft/season-nft.repository.js',
  );
  const status = await lstat(artifact).catch(() => null);
  if (!status?.isFile()) throw new Error('Existing season NFT dist is required.');
}

function requiredAbsoluteRoot(environment, name) {
  const root = environment[name];
  if (!root || !path.isAbsolute(root))
    throw new Error(`${name} must be an absolute path.`);
  return root;
}

/** DB 상대 경로를 현재 private mount 안의 symlink 없는 regular file로만 해석한다. */
async function readMountedFile(root, relativePath, requiredMode) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new Error('The persisted file path is unsafe.');
  }
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink())
    throw new Error('The configured storage root is unsafe.');
  const rootRealPath = await realpath(root);
  const candidate = path.join(rootRealPath, relativePath);
  const relative = path.relative(rootRealPath, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('The persisted file escapes its storage root.');

  let current = rootRealPath;
  for (const component of relativePath.split('/').slice(0, -1)) {
    current = path.join(current, component);
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new Error('The persisted file path contains an unsafe component.');
  }
  let handle;
  try {
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = await handle.stat();
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      (requiredMode !== undefined && (status.mode & 0o777) !== requiredMode)
    ) {
      throw new Error('The persisted file is not a valid private regular file.');
    }
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

async function assertSignedItemsRestored(client, releaseId, environment) {
  const root = requiredAbsoluteRoot(environment, 'NFT_UPLOAD_WORK_DIR');
  const uploads = await client.query(
    `SELECT signed_item_path, data_item_id, sha256, byte_length
     FROM season_nft_uploads
     WHERE release_id = $1 AND state IN ('PREPARED', 'UPLOADED', 'VERIFIED')
     ORDER BY kind`,
    [releaseId],
  );
  if (uploads.rows.length === 0)
    throw new Error('The release has no signed upload evidence to restore.');
  const { DataItem } = require('@dha-team/arbundles');
  for (const upload of uploads.rows) {
    const bytes = await readMountedFile(root, upload.signed_item_path, 0o600);
    const item = new DataItem(bytes);
    const payload = Buffer.from(item.rawData);
    if (
      !(await item.isValid()) ||
      item.id !== upload.data_item_id ||
      BigInt(payload.byteLength) !== BigInt(upload.byte_length) ||
      createHash('sha256').update(payload).digest('hex') !== upload.sha256
    ) {
      throw new Error('A restored signed item does not match its persisted identity.');
    }
  }
}

async function assertPreparationKeysRestored(release, environment) {
  const root = requiredAbsoluteRoot(environment, 'NFT_PREPARATION_KEY_DIR');
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const umi = createUmi('http://127.0.0.1:8899');
  const keys = Object.entries(release.preparation_keys ?? {});
  if (keys.length === 0)
    throw new Error('The release has no persisted preparation key identity.');
  for (const [address, relativePath] of keys) {
    const bytes = await readMountedFile(root, relativePath, 0o600);
    const values = JSON.parse(bytes.toString('utf8'));
    if (
      !Array.isArray(values) ||
      values.length !== 64 ||
      values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    ) {
      throw new Error('A restored preparation key does not match its frozen address.');
    }
    const signer = umiModule.createSignerFromKeypair(
      umi,
      umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(values)),
    );
    if (String(signer.publicKey) !== address)
      throw new Error('A restored preparation key does not match its frozen address.');
  }
}

async function assertSnapshotSourceRestored(client, release, environment) {
  const root = requiredAbsoluteRoot(environment, 'CANVAS_SNAPSHOT_STORAGE_ROOT');
  const snapshot = await client.query(
    `SELECT cs.id, cs.through_sequence, cs.image_key, cs.image_bytes,
            cs.image_sha256, c.last_chunk_sequence
     FROM canvas_snapshots cs
     JOIN canvases c ON c.id = cs.canvas_id
     WHERE cs.canvas_id = $1 AND cs.status = 'READY' AND cs.is_final = true
       AND ($2::uuid IS NULL OR cs.id = $2)
     ORDER BY cs.created_at DESC, cs.id DESC
     LIMIT 2`,
    [release.season_id, release.snapshot_id],
  );
  if (snapshot.rows.length !== 1)
    throw new Error('The release does not have one final READY snapshot.');
  const source = snapshot.rows[0];
  const expectedKey = `snapshots/seasons/${release.season_id.toLowerCase()}/${source.id.toLowerCase()}/image.png`;
  const bytes = await readMountedFile(root, source.image_key);
  if (
    source.image_key !== expectedKey ||
    source.through_sequence !== source.last_chunk_sequence ||
    BigInt(source.image_bytes) !== BigInt(bytes.byteLength) ||
    createHash('sha256').update(bytes).digest('hex') !== source.image_sha256 ||
    (release.snapshot_id !== null &&
      (source.through_sequence !== release.through_sequence ||
        BigInt(source.image_bytes) !== BigInt(release.image_byte_length) ||
        source.image_sha256 !== release.image_sha256))
  ) {
    throw new Error('The final snapshot source still differs from frozen evidence.');
  }
}

async function rpcRequest(endpoint, method) {
  if (!endpoint) throw new Error('The NFT RPC endpoint is not configured.');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(5000),
  });
  const value = await response.json();
  if (!response.ok || value.error || typeof value.result !== 'string')
    throw new Error('The NFT RPC prerequisite check failed.');
  return value.result;
}

/** 설정한 Solana RPC가 release에 동결된 네트워크와 다시 일치하는지 확인한다. */
async function assertRpcRestored(release, environment) {
  const contract = require(path.join(
    PROJECT_ROOT,
    'dist/modules/season-nfts/resources/solana-nft/season-release-chain.js',
  ));
  const expected = contract.EXPECTED_GENESIS_HASHES?.[release.network];
  if (!expected) throw new Error('The expected genesis hash is unavailable.');
  // Worker와 preflight가 검증한 같은 RPC 설정으로 현재 genesis hash를 다시 읽는다.
  const actual = await rpcRequest(environment.SOLANA_RPC_URL, 'getGenesisHash');
  if (actual !== expected) throw new Error('The NFT RPC network identity changed.');
}

/** 동결 자료가 현재 DB 원본과 일치하는 release만 worker 재검사 대상으로 허용한다. */
async function assertCausePrerequisites(client, release, environment) {
  if (!release.last_error_code)
    throw new Error('The blocked release has no recorded cause.');
  const claims = await client.query(
    'SELECT count(*)::integer AS count FROM season_nft_claims WHERE release_id = $1',
    [release.id],
  );
  if (release.snapshot_id === null) {
    if (
      release.stage !== 'SNAPSHOT' ||
      release.eligible_count !== null ||
      claims.rows[0].count !== 0
    ) {
      throw new Error('Unfrozen release prerequisites are inconsistent.');
    }
  } else {
    const snapshot = await client.query(
    `SELECT cs.through_sequence, cs.image_bytes, cs.image_sha256
     FROM canvas_snapshots cs
     WHERE cs.id = $1 AND cs.canvas_id = $2
       AND cs.status = 'READY' AND cs.is_final = true`,
    [release.snapshot_id, release.season_id],
  );
    if (
      snapshot.rows.length !== 1 ||
      snapshot.rows[0].through_sequence !== release.through_sequence ||
      snapshot.rows[0].image_bytes !== release.image_byte_length ||
      snapshot.rows[0].image_sha256 !== release.image_sha256 ||
      claims.rows[0].count !== release.eligible_count
    ) {
      throw new Error('Frozen release prerequisites no longer match their source.');
    }
  }

  // BLOCKED 해제는 기록된 원인이 현재 사라졌음을 독립적으로 증명할 수 있는 경우만 허용한다.
  if (release.last_error_code === 'NFT_MEDIA_SIGNED_ITEM_MISSING') {
    await assertSignedItemsRestored(client, release.id, environment);
  } else if (release.last_error_code === 'NFT_PREPARATION_KEY_MISSING') {
    await assertPreparationKeysRestored(release, environment);
  } else if (
    release.last_error_code === 'NFT_FINAL_SNAPSHOT_INVALID' ||
    release.last_error_code === 'NFT_MEDIA_SOURCE_INVALID'
  ) {
    await assertSnapshotSourceRestored(client, release, environment);
  } else if (RPC_RETRY_CAUSES.has(release.last_error_code)) {
    await assertRpcRestored(release, environment);
  } else {
    throw new Error('The recorded blocked cause has no safe automated recheck.');
  }
}

/** season 다음 release 순서로 잠근 뒤 허용된 운영 필드만 변경한다. */
async function retryRelease(pool, input, environment = process.env) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = await client.query(
      'SELECT season_id FROM season_nft_releases WHERE id = $1',
      [input.releaseId],
    );
    if (identity.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        exitCode: 1,
        output: result('FAIL', 'RELEASE_NOT_FOUND', 'The release was not found.'),
      };
    }
    // 워커 repository와 같은 전역 순서를 사용해 운영 재시도와 worker가 교착하지 않게 한다.
    await client.query(
      'SELECT canvas_id FROM seasons WHERE canvas_id = $1 FOR UPDATE',
      [identity.rows[0].season_id],
    );
    const selected = await client.query(
      'SELECT * FROM season_nft_releases WHERE id = $1 FOR UPDATE',
      [input.releaseId],
    );
    const release = selected.rows[0];
    if (release.network !== input.network) {
      await client.query('ROLLBACK');
      return {
        exitCode: 1,
        output: result(
          'FAIL',
          'RELEASE_NETWORK_MISMATCH',
          'The release network does not match the requested network.',
        ),
      };
    }
    if (release.state === 'READY' || release.state === 'EMPTY') {
      await client.query('ROLLBACK');
      return {
        exitCode: 0,
        output: result(
          'PASS',
          'RELEASE_TERMINAL_UNCHANGED',
          'The terminal release was left unchanged.',
        ),
      };
    }
    if (release.state !== 'BLOCKED') {
      await client.query('ROLLBACK');
      return {
        exitCode: 1,
        output: result(
          'FAIL',
          'RELEASE_NOT_BLOCKED',
          'Only a BLOCKED release can be rescheduled.',
        ),
      };
    }
    try {
      await assertCausePrerequisites(client, release, environment);
    } catch {
      await client.query('ROLLBACK');
      return {
        exitCode: 1,
        output: result(
          'FAIL',
          'RELEASE_CAUSE_NOT_CLEARED',
          'The blocked release failed its current cause prerequisite checks.',
        ),
      };
    }
    await client.query(
      `UPDATE season_nft_releases
       SET state = CASE WHEN snapshot_id IS NULL THEN 'WAITING_SNAPSHOT' ELSE 'PREPARING' END,
           last_error_code = NULL, last_error_message = NULL,
           next_attempt_at = CURRENT_TIMESTAMP, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'BLOCKED'`,
      [input.releaseId],
    );
    await client.query('COMMIT');
    return {
      exitCode: 0,
      output: result(
        'PASS',
        'RELEASE_RESCHEDULED',
        'The blocked release was rescheduled with frozen evidence preserved.',
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    printResult(
      result('FAIL', 'INVALID_INVOCATION', 'Retry arguments are invalid.'),
      argv.includes('--json'),
    );
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  try {
    await assertExistingDist();
  } catch {
    printResult(
      result('FAIL', 'DIST_REQUIRED', 'Existing season NFT dist is required.'),
      options.json,
    );
    return 2;
  }
  const pool = databasePoolFromEnvironment(environment);
  try {
    const outcome = await retryRelease(pool, options);
    printResult(outcome.output, options.json);
    return outcome.exitCode;
  } catch {
    process.stderr.write('Season NFT release retry failed with a redacted diagnostic.\n');
    printResult(
      result('FAIL', 'RETRY_FAILED', 'The release retry failed.'),
      options.json,
    );
    return 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = { main, parseArguments, retryRelease, usage };
