#!/usr/bin/env node

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { lstat, readFile, realpath } = require('node:fs/promises');
const path = require('node:path');
const bs58 = require('bs58').default;
const { Pool } = require('pg');
const {
  EXPECTED_PACKAGES,
  PROGRAM_ADDRESSES,
  REQUIRED_EXTERNAL_TESTS,
} = require('./sdk-validation.cjs');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_SDK_EVIDENCE_PATH = path.join(
  PROJECT_ROOT,
  'docs/deployment/season-nft-sdk-evidence.json',
);
const CHECK_IDS = Object.freeze([
  'CONFIG',
  'DB_SCHEMA',
  'NETWORK_IDENTITY',
  'SERVICE_WALLET',
  'SERVICE_BALANCE',
  'SNAPSHOT_SETTINGS',
  'STORAGE_ENDPOINTS',
  'PRIVATE_PATHS',
  'PERSISTENCE_EVIDENCE',
  'SDK_EVIDENCE',
]);
const REQUIRED_LOCAL_TESTS = Object.freeze([
  'sdkExports',
  'sdkVersions',
  'programAddresses',
  'proofFits100',
  'mintFits100',
  'payerRecipientSerialization',
  'signedItemRoundTrip',
]);
const STORAGE_TESTS = new Set([
  'uploadItemRestoresSameId',
  'permanentUploadRetrievable',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function usage() {
  return [
    'Usage: node scripts/season-nft/preflight.cjs [--evidence <absolute-path>] [--sdk-evidence <absolute-path>] [--json]',
    '',
    'Reads existing dist and deployment evidence. It never builds, writes the DB, uploads, funds, or sends a transaction.',
  ].join('\n');
}

function check(id, status, code, message) {
  return { id, status, code, message };
}

function pendingChecks(failedId, code, message) {
  return CHECK_IDS.map((id) =>
    id === failedId
      ? check(id, 'FAIL', code, message)
      : check(id, 'PENDING', 'NOT_RUN', 'The check did not run.'),
  );
}

function parseArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (
      argument === '--evidence' || argument === '--sdk-evidence'
    ) {
      const value = argv[index + 1];
      if (!value || !path.isAbsolute(value))
        throw new Error(`${argument} requires an absolute path.`);
      const key =
        argument === '--evidence'
          ? 'evidencePath'
          : 'sdkEvidencePath';
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function parseUrl(name, source) {
  if (!source) throw new Error(`${name} is required.`);
  const parsed = new URL(source);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error(`${name} must use http or https.`);
  return parsed.toString().replace(/\/$/, '');
}

function absolutePath(name, source) {
  if (!source || !path.isAbsolute(source))
    throw new Error(`${name} must be an absolute path.`);
  return source;
}

/** 배포 환경의 snapshot 설정을 실제 애플리케이션과 같은 dist validator로 검증한다. */
function loadCanvasSnapshotConfig(environment) {
  const artifact = path.join(PROJECT_ROOT, 'dist/config/canvas-snapshot.config.js');
  // 별도 프로세스에 검사 대상 환경만 전달해 현재 CLI 프로세스의 환경을 바꾸지 않는다.
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      "const factory = require(process.argv[1]).default; process.stdout.write(JSON.stringify(factory()));",
      artifact,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  return JSON.parse(output);
}

/** 운영 CLI 환경과 실제 snapshot 설정 계약을 함께 검증해 이후 read-only 검사 입력을 만든다. */
function validateEnvironment(environment) {
  if (!['true', 'false'].includes(environment.SEASON_NFT_ENABLED ?? 'false'))
    throw new Error('SEASON_NFT_ENABLED must be true or false.');
  if (!['devnet', 'mainnet-beta'].includes(environment.SOLANA_NETWORK))
    throw new Error('SOLANA_NETWORK must be devnet or mainnet-beta.');
  const snapshot = loadCanvasSnapshotConfig(environment);
  const config = {
    network: environment.SOLANA_NETWORK,
    rpcUrl: parseUrl('SOLANA_RPC_URL', environment.SOLANA_RPC_URL),
    serviceKeypairPath: absolutePath(
      'SOLANA_SERVICE_KEYPAIR_PATH',
      environment.SOLANA_SERVICE_KEYPAIR_PATH,
    ),
    storageUploadUrl: parseUrl(
      'NFT_STORAGE_UPLOAD_URL',
      environment.NFT_STORAGE_UPLOAD_URL,
    ),
    storagePaymentUrl: parseUrl(
      'NFT_STORAGE_PAYMENT_URL',
      environment.NFT_STORAGE_PAYMENT_URL,
    ),
    storageGatewayUrl: parseUrl(
      'NFT_STORAGE_GATEWAY_URL',
      environment.NFT_STORAGE_GATEWAY_URL,
    ),
    uploadWorkDir: absolutePath(
      'NFT_UPLOAD_WORK_DIR',
      environment.NFT_UPLOAD_WORK_DIR,
    ),
    preparationKeyDir: absolutePath(
      'NFT_PREPARATION_KEY_DIR',
      environment.NFT_PREPARATION_KEY_DIR,
    ),
    snapshotRoot: snapshot.storageRoot,
    snapshotEnabled: snapshot.enabled,
  };
  if (!config.snapshotEnabled)
    throw new Error('CANVAS_SNAPSHOT_ENABLED must be true.');
  return config;
}

function gitCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

async function loadRuntimeContract() {
  const artifact = path.join(
    PROJECT_ROOT,
    'dist/modules/season-nfts/resources/solana-nft/season-release-chain.js',
  );
  const status = await lstat(artifact).catch(() => null);
  if (!status?.isFile()) throw new Error('Existing season NFT dist is required.');
  const runtime = require(artifact);
  validateRuntimeContract(runtime);
  return runtime;
}

/** Refuses stale dist because quoting without the production builders can understate setup cost. */
function validateRuntimeContract(runtime) {
  if (
    !runtime.EXPECTED_GENESIS_HASHES ||
    typeof runtime.EXPECTED_GENESIS_HASHES.devnet !== 'string' ||
    typeof runtime.EXPECTED_GENESIS_HASHES['mainnet-beta'] !== 'string' ||
    typeof runtime.buildMachineAndGuard !== 'function' ||
    typeof runtime.buildFinalGuardLock !== 'function'
  ) {
    throw new Error('Existing season NFT dist is incompatible.');
  }
}

class SetupQuoteUnavailableError extends Error {
  constructor(lowerBoundLamports, operations, options) {
    super('The exact setup quote is unavailable.', options);
    this.name = SetupQuoteUnavailableError.name;
    this.lowerBoundLamports = lowerBoundLamports;
    this.operations = operations;
  }
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

/** Reads only PostgreSQL catalogs and rolls back the read-only transaction. */
async function verifyDatabaseSchema(environment) {
  const pool = databasePoolFromEnvironment(environment);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[
        'season_nft_releases',
        'season_nft_claims',
        'season_nft_claim_attempts',
        'season_nft_transactions',
        'season_nft_uploads',
      ]],
    );
    const indexes = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [[
        'season_nft_one_active_attempt',
        'season_nft_one_live_or_completed_operation',
        'season_nft_claim_receipt_due_idx',
        'season_nft_release_due_idx',
      ]],
    );
    await client.query('ROLLBACK');
    if (tables.rows.length !== 5 || indexes.rows.length !== 4)
      return check(
        'DB_SCHEMA',
        'FAIL',
        'DB_SCHEMA_MISMATCH',
        'Required season NFT tables or indexes are missing.',
      );
    return check(
      'DB_SCHEMA',
      'PASS',
      'DB_SCHEMA_VALID',
      'Required season NFT tables and indexes are present.',
    );
  } catch {
    await client?.query('ROLLBACK').catch(() => undefined);
    return check(
      'DB_SCHEMA',
      'FAIL',
      'DB_SCHEMA_UNAVAILABLE',
      'The season NFT database schema could not be verified.',
    );
  } finally {
    client?.release();
    await pool.end();
  }
}

async function rpcCall(rpcUrl, method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('RPC HTTP request failed.');
  const payload = await response.json();
  if (payload.error || payload.result === undefined)
    throw new Error('RPC response was invalid.');
  return payload.result;
}

async function readServiceWallet(filePath) {
  const status = await lstat(filePath);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.mode & 0o077) !== 0 ||
    status.size <= 0 ||
    status.size > 1024
  ) {
    throw new Error('Service wallet key file must be a private non-symlink file.');
  }
  const source = JSON.parse(await readFile(filePath, 'utf8'));
  if (
    !Array.isArray(source) ||
    source.length !== 64 ||
    !source.every(
      (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  ) {
    throw new Error('Service wallet key file must contain 64 bytes.');
  }
  const secretKey = Uint8Array.from(source);
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const umi = createUmi('http://127.0.0.1:8899');
  const signer = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.createKeypairFromSecretKey(secretKey),
  );
  if (String(signer.publicKey) !== bs58.encode(secretKey.subarray(32)))
    throw new Error('Service wallet secret does not derive its public key.');
  return {
    address: String(signer.publicKey),
    realPath: await realpath(filePath),
    secretKey,
  };
}

function rpcAccountLamports(account) {
  return BigInt(account?.lamports ?? 0);
}

function rpcAccountDataLength(account) {
  if (!account || !Array.isArray(account.data) || typeof account.data[0] !== 'string')
    throw new Error('RPC simulation account data is unavailable.');
  return Buffer.from(account.data[0], 'base64').byteLength;
}

/** Builds the same five setup messages and derives only read-only RPC fee/rent/debit evidence. */
async function quoteServiceSetup(config, wallet, runtime, call) {
  const [umiModule, defaults, coreModule, candyModule] = await Promise.all([
    import('@metaplex-foundation/umi'),
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/mpl-core'),
    import('@metaplex-foundation/mpl-core-candy-machine'),
  ]);
  const core = coreModule.default ? { ...coreModule.default, ...coreModule } : coreModule;
  const candy = candyModule.default
    ? { ...candyModule.default, ...candyModule }
    : candyModule;
  const umi = defaults.createUmi(config.rpcUrl)
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.createKeypairFromSecretKey(wallet.secretKey),
  );
  if (String(service.publicKey) !== wallet.address)
    throw new Error('Service wallet secret does not derive its stored public key.');
  umi.use(umiModule.signerIdentity(service));

  const collection = umiModule.generateSigner(umi);
  const machine = umiModule.generateSigner(umi);
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  const lock = umi.eddsa.findPda(
    umiModule.publicKey('11111111111111111111111111111111'),
    [Buffer.from('cameo-nft-lock-v1', 'utf8')],
  )[0];
  const merkleRoot = new Uint8Array(32);
  const name = `Cameo ${'x'.repeat(26)}`;
  const metadataUri = `https://arweave.net/${'x'.repeat(43)}`;
  const machineSize = candy.getCandyMachineSize(100, umiModule.none());
  const machineRent = BigInt(
    await call('getMinimumBalanceForRentExemption', [
      machineSize,
      { commitment: 'finalized' },
    ]),
  );
  const collectionBuilder = core.createCollection(umi, {
    collection,
    updateAuthority: service.publicKey,
    payer: service,
    name,
    uri: metadataUri,
    plugins: [{ type: 'ImmutableMetadata' }],
  });
  const machineBuilder = await runtime.buildMachineAndGuard({
    umi,
    service,
    collection: collection.publicKey,
    machine,
    name,
    metadataUri,
    eligibleCount: 100,
    merkleRoot,
    rentLamports: machineRent,
  });
  const builders = [
    ['collection:0', 'SETUP_COLLECTION', collectionBuilder],
    ['machine:0', 'SETUP_MACHINE', machineBuilder],
    [
      'lock:0',
      'SETUP_LOCK',
      candy.setCandyMachineAuthority(umi, {
        candyMachine: machine.publicKey,
        authority: service,
        newAuthority: lock,
      }),
    ],
    [
      'lock:1',
      'SETUP_LOCK',
      runtime.buildCollectionAuthorityLock({
        umi, collection: collection.publicKey, authority: service, lockAuthority: lock,
      }),
    ],
    [
      'lock:2',
      'SETUP_LOCK',
      runtime.buildFinalGuardLock({
        umi,
        authority: service,
        candyGuard: guard,
        lockAuthority: lock,
        merkleRoot,
      }),
    ],
  ];
  const latest = await call('getLatestBlockhash', [{ commitment: 'finalized' }]);
  const blockhash = latest?.value?.blockhash;
  if (typeof blockhash !== 'string') throw new Error('RPC blockhash is unavailable.');

  const operations = [];
  let totalLamports = 0n;
  let collectionTransaction;
  for (const [operationKey, kind, builder] of builders) {
    const transaction = await builder.setBlockhash(blockhash).buildAndSign(umi);
    if (String(transaction.message.accounts[0]) !== wallet.address)
      throw new Error('Setup transaction fee payer is not the service wallet.');
    const fee = await call('getFeeForMessage', [
      Buffer.from(transaction.serializedMessage).toString('base64'),
      { commitment: 'confirmed' },
    ]);
    if (!Number.isSafeInteger(fee?.value) || fee.value <= 0)
      throw new Error('RPC setup fee quote is invalid.');
    const feeLamports = BigInt(fee.value);
    operations.push({
      operationKey,
      kind,
      messageSha256: createHash('sha256')
        .update(transaction.serializedMessage)
        .digest('hex'),
      feeLamports,
      priorityFeeLamports: 0n,
      rentLamports: 0n,
      protocolLamports: 0n,
      totalLamports: feeLamports,
    });
    totalLamports += feeLamports;
    if (operationKey === 'collection:0') collectionTransaction = transaction;
  }

  const wrappedAccountSizes = machineBuilder.items
    .map((item) => item.bytesCreatedOnChain)
    .filter((size) => Number.isInteger(size) && size > 0);
  if (
    wrappedAccountSizes.length !== 2 ||
    !wrappedAccountSizes.includes(machineSize + umiModule.ACCOUNT_HEADER_SIZE)
  ) {
    throw new Error('Runtime machine builder account sizes are incomplete.');
  }
  // Umi's builder accounting includes one 128-byte account header per account; RPC rent takes data bytes.
  const accountDataSizes = wrappedAccountSizes.map(
    (size) => size - umiModule.ACCOUNT_HEADER_SIZE,
  );
  if (accountDataSizes.some((size) => size <= 0))
    throw new Error('Runtime machine builder account data sizes are invalid.');
  const machineRents = await Promise.all(
    accountDataSizes.map(async (size) =>
      BigInt(
        await call('getMinimumBalanceForRentExemption', [
          size,
          { commitment: 'finalized' },
        ]),
      ),
    ),
  );
  if (machineRents.some((value) => value <= 0n))
    throw new Error('RPC setup rent quote is invalid.');
  const machineOperation = operations.find(({ operationKey }) => operationKey === 'machine:0');
  machineOperation.rentLamports = machineRents.reduce((sum, value) => sum + value, 0n);
  machineOperation.totalLamports += machineOperation.rentLamports;
  totalLamports += machineOperation.rentLamports;

  const addresses = collectionTransaction.message.accounts.map(String);
  let pre;
  let simulation;
  try {
    pre = await call('getMultipleAccounts', [
      addresses,
      { commitment: 'confirmed', encoding: 'base64' },
    ]);
    simulation = await call('simulateTransaction', [
      Buffer.from(umi.transactions.serialize(collectionTransaction)).toString('base64'),
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: true,
        replaceRecentBlockhash: false,
        accounts: { encoding: 'base64', addresses },
      },
    ]);
    if (
      !Array.isArray(pre?.value) ||
      pre.value.length !== addresses.length ||
      simulation?.value?.err ||
      !Array.isArray(simulation?.value?.accounts) ||
      simulation.value.accounts.length !== addresses.length
    ) {
      throw new Error('Collection setup simulation is incomplete.');
    }
  } catch (cause) {
    // Five base fees plus machine/guard rent are independently verified even when collection funding blocks simulation.
    throw new SetupQuoteUnavailableError(totalLamports, operations, { cause });
  }
  const collectionIndex = addresses.indexOf(String(collection.publicKey));
  if (collectionIndex < 0)
    throw new Error('Collection setup message omits its collection account.');
  const collectionRent = BigInt(
    await call('getMinimumBalanceForRentExemption', [
      rpcAccountDataLength(simulation.value.accounts[collectionIndex]),
      { commitment: 'finalized' },
    ]),
  );
  const { deriveMintFeeComponents } = require('./sdk-devnet.cjs');
  const collectionOperation = operations[0];
  const components = deriveMintFeeComponents({
    feeLamports: collectionOperation.feeLamports,
    priorityFeeLamports: 0n,
    payerAddress: wallet.address,
    addresses,
    preBalances: pre.value.map(rpcAccountLamports),
    postBalances: simulation.value.accounts.map(rpcAccountLamports),
    rentByAddress: new Map([[String(collection.publicKey), collectionRent]]),
  });
  if (components.rentLamports !== collectionRent)
    throw new Error('Collection simulation does not fund its exact rent reserve.');
  collectionOperation.rentLamports = components.rentLamports;
  collectionOperation.protocolLamports = components.protocolLamports;
  collectionOperation.totalLamports = components.totalLamports;
  totalLamports +=
    components.rentLamports + components.protocolLamports;

  return { totalLamports, operations };
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

async function privateDirectory(directory, exactMode) {
  const status = await lstat(directory);
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (exactMode
      ? (status.mode & 0o777) !== exactMode
      : (status.mode & 0o022) !== 0)
  ) {
    throw new Error('Configured persistent directory is not private.');
  }
  return realpath(directory);
}

async function verifyPrivatePaths(config, wallet) {
  try {
    const snapshot = await privateDirectory(config.snapshotRoot, undefined);
    const upload = await privateDirectory(config.uploadWorkDir, 0o700);
    const preparation = await privateDirectory(config.preparationKeyDir, 0o700);
    const publicSnapshots = path.join(snapshot, 'snapshots');
    if (
      [wallet.realPath, upload, preparation].some((candidate) =>
        containsPath(publicSnapshots, candidate),
      ) ||
      containsPath(upload, preparation) ||
      containsPath(preparation, upload)
    ) {
      throw new Error('Configured private paths overlap.');
    }
    return {
      result: check(
        'PRIVATE_PATHS',
        'PASS',
        'PRIVATE_PATHS_VALID',
        'Configured persistent and private paths are separated.',
      ),
      realPaths: {
        snapshot,
        upload,
        'preparation-key': preparation,
      },
    };
  } catch {
    return {
      result: check(
        'PRIVATE_PATHS',
        'FAIL',
        'PRIVATE_PATHS_INVALID',
        'Configured persistent or private paths are unsafe.',
      ),
      realPaths: null,
    };
  }
}

async function readEvidence(filePath) {
  if (!filePath) return undefined;
  const status = await lstat(filePath);
  if (!status.isFile() || status.isSymbolicLink())
    throw new Error('Evidence path must be a regular non-symlink file.');
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function assertNoSymlinkPath(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    const status = await lstat(current);
    if (status.isSymbolicLink()) throw new Error('Probe path contains a symlink.');
  }
  return current;
}

/** Validates operator redeploy evidence against all current configured roots and probe bytes. */
async function verifyPersistenceEvidence(evidence, context) {
  if (!evidence)
    return {
      status: 'PENDING',
      code: 'PERSISTENCE_EVIDENCE_REQUIRED',
      message: 'Redeployment persistence evidence is required.',
    };
  try {
    if (
      evidence.schemaVersion !== 1 ||
      evidence.network !== context.network ||
      evidence.backendCommit !== context.backendCommit ||
      evidence.restartVerified !== true ||
      !Number.isFinite(Date.parse(evidence.checkedAt)) ||
      !Array.isArray(evidence.paths) ||
      evidence.paths.length !== 3
    ) {
      throw new Error('Persistence evidence metadata is invalid.');
    }
    const observed = new Set();
    for (const item of evidence.paths) {
      if (
        !item ||
        !['snapshot', 'upload', 'preparation-key'].includes(item.purpose) ||
        observed.has(item.purpose) ||
        !path.isAbsolute(item.absolutePath) ||
        typeof item.probeRelativePath !== 'string' ||
        item.probeRelativePath.length === 0 ||
        path.isAbsolute(item.probeRelativePath) ||
        !SHA256_PATTERN.test(item.sha256Before) ||
        item.sha256Before !== item.sha256After
      ) {
        throw new Error('Persistence evidence path entry is invalid.');
      }
      observed.add(item.purpose);
      const configured = await realpath(context.configuredPaths[item.purpose]);
      if ((await realpath(item.absolutePath)) !== configured)
        throw new Error('Persistence evidence root does not match configuration.');
      const candidate = path.resolve(configured, item.probeRelativePath);
      if (!containsPath(configured, candidate))
        throw new Error('Persistence probe escapes its configured root.');
      const resolvedProbe = await assertNoSymlinkPath(
        configured,
        path.relative(configured, candidate),
      );
      if ((await realpath(resolvedProbe)) !== candidate)
        throw new Error('Persistence probe resolves through a link.');
      const currentHash = createHash('sha256')
        .update(await readFile(candidate))
        .digest('hex');
      if (currentHash !== item.sha256Before)
        throw new Error('Persistence probe hash changed.');
    }
    if (observed.size !== 3)
      throw new Error('Each persistence purpose is required exactly once.');
    return {
      status: 'PASS',
      code: 'PERSISTENCE_EVIDENCE_VALID',
      message: 'All configured probe files match redeployment evidence.',
    };
  } catch {
    return {
      status: 'FAIL',
      code: 'PERSISTENCE_EVIDENCE_INVALID',
      message: 'Redeployment persistence evidence is invalid.',
    };
  }
}

function sameStringMap(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const keys = Object.keys(expected).sort();
  return (
    JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(keys) &&
    keys.every((key) => actual[key] === expected[key])
  );
}

function derivedGateStatus(tests, gate) {
  const selected = tests.filter((item) => item.gate === gate);
  if (selected.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (selected.every((item) => item.status === 'PASS')) return 'PASS';
  return 'NOT_RUN';
}

/** Re-derives every gate from the exact required test set instead of trusting summary fields. */
function verifySdkEvidence(evidence, context) {
  if (!evidence)
    return check(
      'SDK_EVIDENCE',
      'PENDING',
      'SDK_EVIDENCE_REQUIRED',
      'Devnet SDK evidence is required.',
    );
  try {
    if (
      evidence?.schemaVersion !== 1 ||
      evidence.network !== 'devnet' ||
      evidence.gitCommit !== context.backendCommit ||
      !Number.isFinite(Date.parse(evidence.checkedAt)) ||
      !sameStringMap(evidence.packages, EXPECTED_PACKAGES) ||
      !sameStringMap(evidence.programAddresses, PROGRAM_ADDRESSES) ||
      !Array.isArray(evidence.tests)
    ) {
      throw new Error('SDK evidence metadata is invalid.');
    }
    const expected = new Map();
    for (const id of REQUIRED_LOCAL_TESTS) expected.set(id, 'LOCAL_SDK');
    for (const id of REQUIRED_EXTERNAL_TESTS) {
      if (!expected.has(id))
        expected.set(
          id,
          STORAGE_TESTS.has(id) ? 'STORAGE_RECOVERY' : 'CHAIN_AUTHORITY',
        );
    }
    if (evidence.tests.length !== expected.size)
      throw new Error('SDK evidence test count is invalid.');
    const observed = new Set();
    for (const item of evidence.tests) {
      if (
        !item ||
        observed.has(item.id) ||
        expected.get(item.id) !== item.gate ||
        !['PASS', 'FAIL', 'NOT_RUN'].includes(item.status) ||
        !Array.isArray(item.signatures) ||
        (item.status === 'NOT_RUN' &&
          (typeof item.reason !== 'string' || item.reason.length === 0)) ||
        (item.status === 'PASS' &&
          item.gate !== 'LOCAL_SDK' &&
          item.signatures.length === 0 &&
          (!item.details || Object.keys(item.details).length === 0))
      ) {
        throw new Error('SDK evidence test record is invalid.');
      }
      observed.add(item.id);
    }
    const gates = {
      LOCAL_SDK: derivedGateStatus(evidence.tests, 'LOCAL_SDK'),
      CHAIN_AUTHORITY: derivedGateStatus(evidence.tests, 'CHAIN_AUTHORITY'),
      STORAGE_RECOVERY: derivedGateStatus(evidence.tests, 'STORAGE_RECOVERY'),
    };
    if (
      !evidence.gates ||
      Object.entries(gates).some(([gate, status]) => evidence.gates[gate] !== status)
    ) {
      throw new Error('SDK evidence gate summaries do not match their tests.');
    }
    const statuses = Object.values(gates);
    if (statuses.includes('FAIL'))
      return check(
        'SDK_EVIDENCE',
        'FAIL',
        'SDK_EVIDENCE_FAILED',
        'At least one required SDK evidence gate failed.',
      );
    if (statuses.includes('NOT_RUN'))
      return check(
        'SDK_EVIDENCE',
        'PENDING',
        'SDK_EVIDENCE_PENDING',
        'Required external SDK evidence gates are not complete.',
      );
    return check(
      'SDK_EVIDENCE',
      'PASS',
      'SDK_EVIDENCE_VALID',
        'All required Devnet SDK evidence gates passed for this backend identity.',
    );
  } catch {
    return check(
      'SDK_EVIDENCE',
      'FAIL',
      'SDK_EVIDENCE_INVALID',
      'Season NFT SDK evidence is invalid.',
    );
  }
}

function overallResult(checks) {
  if (checks.some(({ status }) => status === 'FAIL'))
    return { status: 'FAIL', exitCode: 1 };
  if (checks.some(({ status }) => status === 'PENDING'))
    return { status: 'PENDING', exitCode: 3 };
  return { status: 'PASS', exitCode: 0 };
}

function printResult(status, checks, json) {
  process.stdout.write(
    `${JSON.stringify({ status, checks }, null, json ? 0 : 2)}\n`,
  );
}

/** Runs independent read-only checks without constructing Nest or importing AppModule. */
async function main(
  argv = process.argv.slice(2),
  environment = process.env,
) {
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    const checks = pendingChecks(
      'CONFIG',
      'INVALID_INVOCATION',
      'Preflight arguments are invalid.',
    );
    printResult('FAIL', checks, argv.includes('--json'));
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let runtime;
  let config;
  try {
    runtime = await loadRuntimeContract();
    config = validateEnvironment(environment);
  } catch {
    const checks = pendingChecks(
      'CONFIG',
      'CONFIG_INVALID',
      'Season NFT deployment configuration or existing dist is invalid.',
    );
    printResult('FAIL', checks, options.json);
    return 2;
  }

  const backendCommit = gitCommit();
  const checksById = new Map();
  checksById.set(
    'CONFIG',
    check(
      'CONFIG',
      'PASS',
      'CONFIG_VALID',
      'Season NFT deployment configuration is complete.',
    ),
  );
  checksById.set(
    'SNAPSHOT_SETTINGS',
    check(
      'SNAPSHOT_SETTINGS',
      'PASS',
      'SNAPSHOT_SETTINGS_VALID',
      'Final snapshot storage is enabled and configured.',
    ),
  );
  checksById.set(
    'STORAGE_ENDPOINTS',
    check(
      'STORAGE_ENDPOINTS',
      'PASS',
      'STORAGE_ENDPOINTS_VALID',
      'Storage upload, payment, and gateway endpoints are valid URLs.',
    ),
  );
  checksById.set('DB_SCHEMA', await verifyDatabaseSchema(environment));

  let wallet;
  try {
    wallet = await readServiceWallet(config.serviceKeypairPath);
    checksById.set(
      'SERVICE_WALLET',
      check(
        'SERVICE_WALLET',
        'PASS',
        'SERVICE_WALLET_VALID',
        'The service wallet key file has the required private format.',
      ),
    );
  } catch {
    checksById.set(
      'SERVICE_WALLET',
      check(
        'SERVICE_WALLET',
        'FAIL',
        'SERVICE_WALLET_INVALID',
        'The service wallet key file is invalid.',
      ),
    );
  }

  const pathCheck = wallet
    ? await verifyPrivatePaths(config, wallet)
    : {
        result: check(
          'PRIVATE_PATHS',
          'FAIL',
          'PRIVATE_PATHS_INVALID',
          'Private paths cannot be verified without a valid service wallet.',
        ),
        realPaths: null,
      };
  checksById.set('PRIVATE_PATHS', pathCheck.result);

  let genesisHash;
  let balanceLamports;
  try {
    genesisHash = await rpcCall(config.rpcUrl, 'getGenesisHash');
    if (genesisHash !== runtime.EXPECTED_GENESIS_HASHES[config.network])
      throw new Error('RPC genesis does not match configured network.');
    checksById.set(
      'NETWORK_IDENTITY',
      check(
        'NETWORK_IDENTITY',
        'PASS',
        'NETWORK_IDENTITY_VALID',
        'RPC genesis matches the configured Solana network.',
      ),
    );
    if (wallet) {
      const balance = await rpcCall(config.rpcUrl, 'getBalance', [
        wallet.address,
        { commitment: 'finalized' },
      ]);
      if (!Number.isSafeInteger(balance?.value) || balance.value < 0)
        throw new Error('RPC balance response is invalid.');
      balanceLamports = BigInt(balance.value);
    }
  } catch {
    checksById.set(
      'NETWORK_IDENTITY',
      check(
        'NETWORK_IDENTITY',
        'FAIL',
        'NETWORK_IDENTITY_INVALID',
        'RPC genesis or read-only network access could not be verified.',
      ),
    );
  }

  try {
    if (!wallet) {
      checksById.set(
        'SERVICE_BALANCE',
        check(
          'SERVICE_BALANCE',
          'FAIL',
          'SERVICE_WALLET_INVALID',
          'Service balance cannot be verified without a valid service wallet.',
        ),
      );
    } else {
      if (!genesisHash || balanceLamports === undefined)
      throw new Error('Service wallet balance is unavailable.');
      const quote = await quoteServiceSetup(
        config,
        wallet,
        runtime,
        (method, params) => rpcCall(config.rpcUrl, method, params),
      );
      checksById.set(
        'SERVICE_BALANCE',
        balanceLamports < quote.totalLamports
          ? check(
              'SERVICE_BALANCE',
              'FAIL',
              'SERVICE_BALANCE_INSUFFICIENT',
              `Service wallet balance ${balanceLamports} lamports is below the read-only ${quote.totalLamports} lamport setup quote.`,
            )
          : check(
              'SERVICE_BALANCE',
              'PASS',
              'SERVICE_BALANCE_SUFFICIENT',
              `Service wallet balance covers the read-only ${quote.totalLamports} lamport setup quote.`,
            ),
      );
    }
  } catch (error) {
    checksById.set(
      'SERVICE_BALANCE',
      error instanceof SetupQuoteUnavailableError &&
        balanceLamports !== undefined &&
        balanceLamports < error.lowerBoundLamports
        ? check(
            'SERVICE_BALANCE',
            'FAIL',
            'SERVICE_BALANCE_BELOW_VERIFIED_LOWER_BOUND',
            `Service wallet balance ${balanceLamports} lamports is below the verified ${error.lowerBoundLamports} lamport setup lower bound; collection rent and protocol debit remain additional.`,
          )
        : check(
            'SERVICE_BALANCE',
            'PENDING',
            'SETUP_QUOTE_UNAVAILABLE',
            error instanceof SetupQuoteUnavailableError
              ? `The exact setup quote is unavailable; ${error.lowerBoundLamports} lamports of five-transaction fees and machine/guard rent were verified, while collection rent and protocol debit remain unverified.`
              : 'The exact read-only five-transaction setup quote could not be verified.',
          ),
    );
  }

  try {
    const persistenceEvidence = await readEvidence(
      options.evidencePath || environment.SEASON_NFT_PERSISTENCE_EVIDENCE_PATH,
    );
    const persistence = pathCheck.realPaths
      ? await verifyPersistenceEvidence(persistenceEvidence, {
          network: config.network,
          backendCommit,
          configuredPaths: pathCheck.realPaths,
        })
      : {
          status: 'FAIL',
          code: 'PERSISTENCE_EVIDENCE_INVALID',
          message: 'Configured persistence paths are invalid.',
        };
    checksById.set('PERSISTENCE_EVIDENCE', {
      id: 'PERSISTENCE_EVIDENCE',
      ...persistence,
    });
  } catch {
    checksById.set(
      'PERSISTENCE_EVIDENCE',
      check(
        'PERSISTENCE_EVIDENCE',
        'FAIL',
        'PERSISTENCE_EVIDENCE_INVALID',
        'Redeployment persistence evidence is invalid.',
      ),
    );
  }

  try {
    const sdkEvidence = await readEvidence(
      options.sdkEvidencePath ||
        environment.SEASON_NFT_SDK_EVIDENCE_PATH ||
        DEFAULT_SDK_EVIDENCE_PATH,
    );
    checksById.set(
      'SDK_EVIDENCE',
      verifySdkEvidence(sdkEvidence, {
        network: config.network,
        backendCommit,
      }),
    );
  } catch (error) {
    checksById.set(
      'SDK_EVIDENCE',
      check(
        'SDK_EVIDENCE',
        error?.code === 'ENOENT' ? 'PENDING' : 'FAIL',
        error?.code === 'ENOENT'
          ? 'SDK_EVIDENCE_REQUIRED'
          : 'SDK_EVIDENCE_INVALID',
        error?.code === 'ENOENT'
          ? 'Devnet SDK evidence is required.'
          : 'Season NFT SDK evidence is invalid.',
      ),
    );
  }

  const checks = CHECK_IDS.map((id) => checksById.get(id));
  const overall = overallResult(checks);
  printResult(overall.status, checks, options.json);
  return overall.exitCode;
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.stderr.write('Season NFT preflight failed with a redacted diagnostic.\n');
      const checks = pendingChecks(
        'CONFIG',
        'PREFLIGHT_FAILED',
        'Season NFT preflight failed.',
      );
      printResult('FAIL', checks, process.argv.includes('--json'));
      process.exitCode = 1;
    });
}

module.exports = {
  CHECK_IDS,
  main,
  parseArguments,
  quoteServiceSetup,
  readServiceWallet,
  usage,
  validateRuntimeContract,
  verifyPersistenceEvidence,
  verifySdkEvidence,
};
