const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { test } = require('node:test');
const http = require('node:http');
const bs58 = require('bs58').default;
const { Pool } = require('pg');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const {
  CHECK_IDS,
  quoteServiceSetup,
  readServiceWallet,
  validateRuntimeContract,
  verifyPersistenceEvidence,
  verifySdkEvidence,
} = require('../../scripts/season-nft/preflight.cjs');
const {
  EXPECTED_PACKAGES,
  PROGRAM_ADDRESSES,
  REQUIRED_EXTERNAL_TESTS,
} = require('../../scripts/season-nft/sdk-validation.cjs');
const {
  retryRelease,
} = require('../../scripts/season-nft/retry-release.cjs');

const projectRoot = resolve(__dirname, '../..');

function runScript(relativePath, args = [], environment = {}) {
  return spawnSync(process.execPath, [resolve(projectRoot, relativePath), ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

function runScriptAsync(relativePath, args = [], environment = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(projectRoot, relativePath), ...args],
      {
        cwd: projectRoot,
        env: { ...process.env, ...environment },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', (status) =>
      resolveResult({
        status,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

async function startGenesisRpc(t, expectedGenesis) {
  let mode = 'success';
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(payload.method);
      response.writeHead(200, {
        'connection': 'close',
        'content-type': 'application/json',
      });
      // The selected mode returns either the expected network, a mismatch, or an RPC error.
      if (mode === 'error') {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            error: { code: -32000, message: 'RPC unavailable.' },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: mode === 'wrong' ? 'wrong-genesis' : expectedGenesis,
        }),
      );
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(
    () =>
      new Promise((resolveClose) => {
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close(resolveClose);
      }),
  );
  return {
    requests,
    setMode(value) {
      mode = value;
    },
    url: `http://127.0.0.1:${server.address().port}`,
  };
}

test('preflight help documents read-only evidence inputs without requiring configuration', () => {
  const result = runScript('scripts/season-nft/preflight.cjs', ['--help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(
    result.stdout,
    /--evidence <absolute-path>.*--sdk-evidence <absolute-path>.*--json/s,
  );
  assert.match(result.stdout, /reads existing dist/i);
});

test('service balance quote rebuilds five runtime messages and uses only read-only RPC cost inputs', async () => {
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const signer = umiModule.generateSigner(createUmi('http://127.0.0.1:8899'));
  const wallet = {
    address: String(signer.publicKey),
    secretKey: signer.secretKey,
  };
  const methods = [];
  const call = async (method, params) => {
    methods.push(method);
    if (method === 'getMinimumBalanceForRentExemption')
      return 10_000 + Number(params[0]) * 10;
    if (method === 'getLatestBlockhash')
      return { value: { blockhash: '11111111111111111111111111111111' } };
    if (method === 'getFeeForMessage') return { value: 5_000 };
    if (method === 'getMultipleAccounts') {
      return {
        value: params[0].map((address) =>
          address === wallet.address ? { lamports: 10_000_000 } : null,
        ),
      };
    }
    if (method === 'simulateTransaction') {
      const addresses = params[1].accounts.addresses;
      const collectionIndex = addresses.findIndex(
        (address) =>
          address !== wallet.address &&
          address !== '11111111111111111111111111111111' &&
          address !== PROGRAM_ADDRESSES.mplCore,
      );
      const collectionLamports = 12_000;
      return {
        value: {
          err: null,
          accounts: addresses.map((address, index) => {
            if (address === wallet.address)
              return { lamports: 10_000_000 - collectionLamports, data: ['', 'base64'] };
            if (index === collectionIndex)
              return {
                lamports: collectionLamports,
                data: [Buffer.alloc(100).toString('base64'), 'base64'],
              };
            return null;
          }),
        },
      };
    }
    throw new Error(`Unexpected RPC method ${method}`);
  };

  const quote = await quoteServiceSetup(
    { network: 'devnet', rpcUrl: 'http://127.0.0.1:8899' },
    wallet,
    require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain.js'),
    call,
  );

  assert.deepEqual(
    quote.operations.map(({ operationKey }) => operationKey),
    ['collection:0', 'machine:0', 'lock:0', 'lock:1', 'lock:2'],
  );
  assert.equal(
    quote.operations.every(({ priorityFeeLamports }) => priorityFeeLamports === 0n),
    true,
  );
  assert.equal(methods.includes('sendTransaction'), false);
  assert.equal(methods.filter((method) => method === 'getFeeForMessage').length, 5);
  assert.equal(methods.filter((method) => method === 'simulateTransaction').length, 1);
  assert.equal(quote.totalLamports > 25_000n, true);
});

test('preflight rejects stale dist that lacks the exact setup builders', () => {
  assert.throws(
    () =>
      validateRuntimeContract({
        EXPECTED_GENESIS_HASHES: {
          devnet: 'devnet-genesis',
          'mainnet-beta': 'mainnet-genesis',
        },
      }),
    /incompatible/i,
  );
});

test('service balance quote retains a verified lower bound when collection simulation is unavailable', async () => {
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const signer = umiModule.generateSigner(createUmi('http://127.0.0.1:8899'));
  const wallet = {
    address: String(signer.publicKey),
    secretKey: signer.secretKey,
  };
  await assert.rejects(
    () =>
      quoteServiceSetup(
        { network: 'devnet', rpcUrl: 'http://127.0.0.1:8899' },
        wallet,
        require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain.js'),
        async (method, params) => {
          if (method === 'getMinimumBalanceForRentExemption')
            return 10_000 + Number(params[0]);
          if (method === 'getLatestBlockhash')
            return { value: { blockhash: '11111111111111111111111111111111' } };
          if (method === 'getFeeForMessage') return { value: 5_000 };
          if (method === 'getMultipleAccounts') {
            return {
              value: params[0].map((address) =>
                address === wallet.address ? { lamports: 1 } : null,
              ),
            };
          }
          if (method === 'simulateTransaction') {
            return {
              value: {
                err: { InstructionError: [0, 'InsufficientFunds'] },
                accounts: null,
              },
            };
          }
          throw new Error(`Unexpected RPC method ${method}`);
        },
      ),
    (error) => {
      assert.equal(error.name, 'SetupQuoteUnavailableError');
      assert.equal(error.lowerBoundLamports > 25_000n, true);
      assert.equal(error.operations.length, 5);
      return true;
    },
  );
});

test('full preflight process composes PASS, missing-evidence PENDING, and genesis mismatch without side effects', async (t) => {
  const { pool } = await testDatabaseModule();
  const root = await mkdtemp(join(tmpdir(), 'season-nft-preflight-process-'));
  const configuredPaths = {};
  const persistencePaths = [];
  for (const purpose of ['snapshot', 'upload', 'preparation-key']) {
    const directory = join(root, purpose);
    await mkdir(directory, { mode: 0o700 });
    const probe = join(directory, 'redeploy-probe.txt');
    await writeFile(probe, `probe:${purpose}`, { mode: 0o600 });
    const hash = createHash('sha256').update(await readFile(probe)).digest('hex');
    configuredPaths[purpose] = directory;
    persistencePaths.push({
      purpose,
      absolutePath: directory,
      probeRelativePath: 'redeploy-probe.txt',
      sha256Before: hash,
      sha256After: hash,
    });
  }
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const signer = umiModule.generateSigner(createUmi('http://127.0.0.1:8899'));
  const walletPath = join(root, 'service.json');
  await writeFile(walletPath, JSON.stringify([...signer.secretKey]), { mode: 0o400 });
  const backendCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).stdout.trim();
  const persistencePath = join(root, 'persistence.json');
  await writeFile(
    persistencePath,
    JSON.stringify({
      schemaVersion: 1,
      network: 'devnet',
      backendCommit,
      checkedAt: new Date().toISOString(),
      restartVerified: true,
      paths: persistencePaths,
    }),
    { mode: 0o600 },
  );
  const checkedSdk = JSON.parse(
    await readFile(
      join(projectRoot, 'docs/deployment/season-nft-sdk-evidence.json'),
      'utf8',
    ),
  );
  const sdkPath = join(root, 'sdk.json');
  await writeFile(
    sdkPath,
    JSON.stringify({
      ...checkedSdk,
      network: 'devnet',
      gitCommit: backendCommit,
      checkedAt: new Date().toISOString(),
      gates: {
        LOCAL_SDK: 'PASS',
        CHAIN_AUTHORITY: 'PASS',
        STORAGE_RECOVERY: 'PASS',
      },
      tests: checkedSdk.tests.map((item) => ({
        ...item,
        status: 'PASS',
        reason: null,
        signatures:
          item.gate === 'LOCAL_SDK'
            ? item.signatures
            : item.signatures.length > 0
              ? item.signatures
              : [`fixture-${item.id}`],
      })),
    }),
    { mode: 0o600 },
  );

  const methods = [];
  let wrongGenesis = false;
  const expectedGenesis = require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain.js')
    .EXPECTED_GENESIS_HASHES.devnet;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      methods.push(payload.method);
      let result;
      if (payload.method === 'getGenesisHash')
        result = wrongGenesis ? 'wrong-genesis' : expectedGenesis;
      else if (payload.method === 'getBalance') result = { value: 1_000_000_000 };
      else if (payload.method === 'getMinimumBalanceForRentExemption')
        result = 10_000 + Number(payload.params[0]) * 10;
      else if (payload.method === 'getLatestBlockhash')
        result = {
          value: {
            blockhash: '11111111111111111111111111111111',
            lastValidBlockHeight: 100,
          },
        };
      else if (payload.method === 'getFeeForMessage') result = { value: 5_000 };
      else if (payload.method === 'getMultipleAccounts') {
        result = {
          value: payload.params[0].map((address) =>
            address === String(signer.publicKey)
              ? { lamports: 1_000_000_000 }
              : null,
          ),
        };
      } else if (payload.method === 'simulateTransaction') {
        const addresses = payload.params[1].accounts.addresses;
        const collectionIndex = addresses.findIndex(
          (address) =>
            address !== String(signer.publicKey) &&
            address !== '11111111111111111111111111111111' &&
            address !== PROGRAM_ADDRESSES.mplCore,
        );
        result = {
          value: {
            err: null,
            accounts: addresses.map((address, index) => {
              if (address === String(signer.publicKey))
                return {
                  lamports: 1_000_000_000 - 12_000,
                  data: ['', 'base64'],
                };
              if (index === collectionIndex)
                return {
                  lamports: 12_000,
                  data: [Buffer.alloc(100).toString('base64'), 'base64'],
                };
              return null;
            }),
          },
        };
      } else {
        response.writeHead(400, {
          'connection': 'close',
          'content-type': 'application/json',
        });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            error: { code: -32601, message: 'Method not allowed.' },
          }),
        );
        return;
      }
      response.writeHead(200, {
        'connection': 'close',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(
    () =>
      new Promise((resolveClose) => {
        server.closeIdleConnections();
        server.closeAllConnections();
        server.close(resolveClose);
      }),
  );
  const rpcUrl = `http://127.0.0.1:${server.address().port}`;
  const environment = {
    ...databaseEnvironment(pool),
    SEASON_NFT_ENABLED: 'false',
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: rpcUrl,
    SOLANA_SERVICE_KEYPAIR_PATH: walletPath,
    NFT_STORAGE_UPLOAD_URL: 'https://upload.example.test',
    NFT_STORAGE_PAYMENT_URL: 'https://payment.example.test',
    NFT_STORAGE_GATEWAY_URL: 'https://gateway.example.test',
    NFT_UPLOAD_WORK_DIR: configuredPaths.upload,
    NFT_PREPARATION_KEY_DIR: configuredPaths['preparation-key'],
    CANVAS_SNAPSHOT_STORAGE_ROOT: configuredPaths.snapshot,
    CANVAS_SNAPSHOT_ENABLED: 'true',
    CANVAS_SNAPSHOT_PUBLIC_BASE_URL: 'https://snapshots.example.test',
    CANVAS_SNAPSHOT_DISK_BUDGET_BYTES: '1048576',
    CANVAS_SNAPSHOT_MIN_FREE_BYTES: '524288',
    CANVAS_SNAPSHOT_INTERVAL_SECONDS: '60',
  };
  const counts = async () =>
    (
      await pool.query(
        `SELECT
           (SELECT count(*)::int FROM season_nft_releases) AS releases,
           (SELECT count(*)::int FROM season_nft_claims) AS claims,
           (SELECT count(*)::int FROM season_nft_transactions) AS transactions,
           (SELECT count(*)::int FROM season_nft_uploads) AS uploads`,
      )
    ).rows[0];
  const before = await counts();

  const passed = await runScriptAsync(
    'scripts/season-nft/preflight.cjs',
    ['--evidence', persistencePath, '--sdk-evidence', sdkPath, '--json'],
    environment,
  );
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.equal(passed.stderr, '');
  const passedBody = JSON.parse(passed.stdout);
  assert.equal(passedBody.status, 'PASS');
  assert.deepEqual(passedBody.checks.map(({ id }) => id), CHECK_IDS);
  assert.equal(passedBody.checks.every(({ status }) => status === 'PASS'), true);

  const missing = await runScriptAsync(
    'scripts/season-nft/preflight.cjs',
    [
      '--evidence',
      persistencePath,
      '--sdk-evidence',
      join(root, 'missing-sdk.json'),
      '--json',
    ],
    environment,
  );
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).checks.find(({ id }) => id === 'SDK_EVIDENCE').status, 'PENDING');

  wrongGenesis = true;
  const mismatch = await runScriptAsync(
    'scripts/season-nft/preflight.cjs',
    ['--evidence', persistencePath, '--sdk-evidence', sdkPath, '--json'],
    environment,
  );
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).checks.find(({ id }) => id === 'NETWORK_IDENTITY').status, 'FAIL');
  assert.deepEqual(await counts(), before);
  assert.equal(methods.includes('sendTransaction'), false);
  assert.equal(methods.every((method) => new Set([
    'getGenesisHash',
    'getBalance',
    'getMinimumBalanceForRentExemption',
    'getLatestBlockhash',
    'getFeeForMessage',
    'getMultipleAccounts',
    'simulateTransaction',
  ]).has(method)), true);
});

test('retry help exposes only release identity, network, and JSON output controls', () => {
  const result = runScript('scripts/season-nft/retry-release.cjs', ['--help']);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(
    result.stdout,
    /--release-id <uuid> --network <devnet\|mainnet-beta> \[--json\]/,
  );
  assert.doesNotMatch(result.stdout, /root|metadata|claim|reset/i);
});

test('invalid preflight configuration emits every stable check ID once and redacts inputs', () => {
  const secret = 'do-not-print-this-password';
  const rpcSecret = 'do-not-print-this-rpc-key';
  const result = runScript(
    'scripts/season-nft/preflight.cjs',
    ['--json'],
    {
      DB_PASSWORD: secret,
      SOLANA_RPC_URL: `https://rpc.example.test/?api-key=${rpcSecret}`,
      SOLANA_NETWORK: 'invalid-network',
      SOLANA_SERVICE_KEYPAIR_PATH: '',
      NFT_STORAGE_UPLOAD_URL: '',
      NFT_STORAGE_PAYMENT_URL: '',
      NFT_STORAGE_GATEWAY_URL: '',
      NFT_UPLOAD_WORK_DIR: '',
      NFT_PREPARATION_KEY_DIR: '',
      CANVAS_SNAPSHOT_STORAGE_ROOT: '',
      CANVAS_SNAPSHOT_ENABLED: 'false',
    },
  );

  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.checks.map(({ id }) => id),
    CHECK_IDS,
  );
  assert.equal(new Set(output.checks.map(({ id }) => id)).size, CHECK_IDS.length);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  assert.equal(`${result.stdout}${result.stderr}`.includes(rpcSecret), false);
});

test('preflight refuses missing or invalid required snapshot settings before running deployment checks', () => {
  const validSnapshotEnvironment = {
    SEASON_NFT_ENABLED: 'false',
    SOLANA_NETWORK: 'devnet',
    SOLANA_RPC_URL: 'https://rpc.example.test',
    SOLANA_SERVICE_KEYPAIR_PATH: '/private/service.json',
    NFT_STORAGE_UPLOAD_URL: 'https://upload.example.test',
    NFT_STORAGE_PAYMENT_URL: 'https://payment.example.test',
    NFT_STORAGE_GATEWAY_URL: 'https://gateway.example.test',
    NFT_UPLOAD_WORK_DIR: '/private/uploads',
    NFT_PREPARATION_KEY_DIR: '/private/preparation-keys',
    CANVAS_SNAPSHOT_STORAGE_ROOT: '/private/snapshots',
    CANVAS_SNAPSHOT_ENABLED: 'true',
    CANVAS_SNAPSHOT_PUBLIC_BASE_URL: 'https://snapshots.example.test',
    CANVAS_SNAPSHOT_DISK_BUDGET_BYTES: '1048576',
    CANVAS_SNAPSHOT_MIN_FREE_BYTES: '524288',
    CANVAS_SNAPSHOT_INTERVAL_SECONDS: '60',
  };
  const invalidSettings = [
    ['missing public base URL', 'CANVAS_SNAPSHOT_PUBLIC_BASE_URL', undefined],
    ['missing disk budget', 'CANVAS_SNAPSHOT_DISK_BUDGET_BYTES', undefined],
    ['missing minimum free bytes', 'CANVAS_SNAPSHOT_MIN_FREE_BYTES', undefined],
    ['invalid public base URL', 'CANVAS_SNAPSHOT_PUBLIC_BASE_URL', 'ftp://snapshots.example.test'],
    ['invalid disk budget', 'CANVAS_SNAPSHOT_DISK_BUDGET_BYTES', '0'],
    ['invalid minimum free bytes', 'CANVAS_SNAPSHOT_MIN_FREE_BYTES', 'invalid'],
    ['invalid interval', 'CANVAS_SNAPSHOT_INTERVAL_SECONDS', '1.5'],
  ];

  for (const [label, name, value] of invalidSettings) {
    const result = runScript('scripts/season-nft/preflight.cjs', ['--json'], {
      ...validSnapshotEnvironment,
      [name]: value,
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, 2, label);
    assert.deepEqual(output.checks[0], {
      id: 'CONFIG',
      status: 'FAIL',
      code: 'CONFIG_INVALID',
      message: 'Season NFT deployment configuration or existing dist is invalid.',
    });
  }
});

test('SDK evidence requires exact packages, programs, tests, and derived gates', () => {
  const localIds = [
    'sdkExports',
    'sdkVersions',
    'programAddresses',
    'proofFits100',
    'mintFits100',
    'payerRecipientSerialization',
    'signedItemRoundTrip',
  ];
  const local = localIds.map((id) => ({
    id,
    gate: 'LOCAL_SDK',
    status: 'PASS',
    signatures: [],
    reason: null,
  }));
  const localSet = new Set(localIds);
  const external = REQUIRED_EXTERNAL_TESTS.filter((id) => !localSet.has(id)).map(
    (id) => ({
      id,
      gate: ['uploadItemRestoresSameId', 'permanentUploadRetrievable'].includes(id)
        ? 'STORAGE_RECOVERY'
        : 'CHAIN_AUTHORITY',
      status: 'NOT_RUN',
      signatures: [],
      reason: 'External mutation was not authorized.',
    }),
  );
  const context = { network: 'devnet', backendCommit: 'd'.repeat(40) };
  const evidence = {
    schemaVersion: 1,
    checkedAt: '2026-10-10T12:00:00.000Z',
    network: context.network,
    gitCommit: context.backendCommit,
    packages: { ...EXPECTED_PACKAGES },
    programAddresses: { ...PROGRAM_ADDRESSES },
    gates: {
      LOCAL_SDK: 'PASS',
      CHAIN_AUTHORITY: 'NOT_RUN',
      STORAGE_RECOVERY: 'NOT_RUN',
    },
    tests: [...local, ...external],
  };

  assert.equal(verifySdkEvidence(evidence, context).status, 'PENDING');
  assert.equal(verifySdkEvidence(undefined, context).status, 'PENDING');
  const completedTests = evidence.tests.map((item) => ({
    ...item,
    status: 'PASS',
    reason: null,
    signatures: item.gate === 'LOCAL_SDK' ? [] : [`sig-${item.id}`],
  }));
  const completed = {
    ...evidence,
    gates: {
      LOCAL_SDK: 'PASS',
      CHAIN_AUTHORITY: 'PASS',
      STORAGE_RECOVERY: 'PASS',
    },
    tests: completedTests,
  };
  assert.equal(
    verifySdkEvidence(completed, {
      network: 'mainnet-beta',
      backendCommit: context.backendCommit,
    }).status,
    'PASS',
  );
  assert.equal(
    verifySdkEvidence({ ...completed, network: 'mainnet-beta' }, context).status,
    'FAIL',
  );
  assert.equal(verifySdkEvidence({}, context).status, 'FAIL');
  assert.equal(
    verifySdkEvidence({ ...evidence, packages: {} }, context).status,
    'FAIL',
  );
  assert.equal(
    verifySdkEvidence(
      {
        ...evidence,
        programAddresses: { ...PROGRAM_ADDRESSES, mplCore: 'wrong' },
      },
      context,
    ).status,
    'FAIL',
  );
  assert.equal(
    verifySdkEvidence(
      {
        ...evidence,
        gates: {
          LOCAL_SDK: 'PASS',
          CHAIN_AUTHORITY: 'PASS',
          STORAGE_RECOVERY: 'PASS',
        },
      },
      context,
    ).status,
    'FAIL',
  );
});

test('service wallet accepts owner-read-only mounts and rejects group-readable secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'season-nft-wallet-mode-'));
  const walletPath = join(root, 'service.json');
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const signer = umiModule.generateSigner(createUmi('http://127.0.0.1:8899'));
  await writeFile(walletPath, JSON.stringify([...signer.secretKey]), { mode: 0o600 });
  await chmod(walletPath, 0o400);
  await assert.doesNotReject(() => readServiceWallet(walletPath));
  const corrupt = Uint8Array.from(signer.secretKey);
  corrupt[0] ^= 1;
  await chmod(walletPath, 0o600);
  await writeFile(walletPath, JSON.stringify([...corrupt]), { mode: 0o400 });
  await assert.rejects(() => readServiceWallet(walletPath));
  await chmod(walletPath, 0o440);
  await assert.rejects(() => readServiceWallet(walletPath));
});

test('persistence evidence proves each configured real path with the same current probe hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'season-nft-preflight-'));
  const configuredPaths = {};
  const paths = [];
  for (const purpose of ['snapshot', 'upload', 'preparation-key']) {
    const directory = join(root, purpose);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, 'redeploy-probe.txt'), purpose, { mode: 0o600 });
    const hash = createHash('sha256')
      .update(await readFile(join(directory, 'redeploy-probe.txt')))
      .digest('hex');
    configuredPaths[purpose] = directory;
    paths.push({
      purpose,
      absolutePath: directory,
      probeRelativePath: 'redeploy-probe.txt',
      sha256Before: hash,
      sha256After: hash,
    });
  }
  const evidence = {
    schemaVersion: 1,
    network: 'devnet',
    backendCommit: 'c'.repeat(40),
    checkedAt: '2026-10-10T12:00:00.000Z',
    restartVerified: true,
    paths,
  };

  assert.equal(
    (
      await verifyPersistenceEvidence(evidence, {
        network: 'devnet',
        backendCommit: 'c'.repeat(40),
        configuredPaths,
      })
    ).status,
    'PASS',
  );
  assert.equal(
    (
      await verifyPersistenceEvidence(
        { ...evidence, network: 'mainnet-beta' },
        {
          network: 'mainnet-beta',
          backendCommit: 'c'.repeat(40),
          configuredPaths,
        },
      )
    ).status,
    'PASS',
  );
  assert.equal(
    (
      await verifyPersistenceEvidence(evidence, {
        network: 'mainnet-beta',
        backendCommit: 'c'.repeat(40),
        configuredPaths,
      })
    ).status,
    'FAIL',
  );
  assert.equal(
    (
      await verifyPersistenceEvidence(
        { ...evidence, paths: [paths[0], paths[0], paths[2]] },
        {
          network: 'devnet',
          backendCommit: 'c'.repeat(40),
          configuredPaths,
        },
      )
    ).status,
    'FAIL',
  );

  await symlink(join(configuredPaths.snapshot, 'redeploy-probe.txt'), join(configuredPaths.upload, 'probe-link'));
  const linked = paths.map((item) =>
    item.purpose === 'upload'
      ? { ...item, probeRelativePath: 'probe-link' }
      : item,
  );
  assert.equal(
    (
      await verifyPersistenceEvidence(
        { ...evidence, paths: linked },
        {
          network: 'devnet',
          backendCommit: 'c'.repeat(40),
          configuredPaths,
        },
      )
    ).status,
    'FAIL',
  );
});

function databaseEnvironment(pool) {
  const connection = pool.options.connectionString
    ? new URL(pool.options.connectionString)
    : null;
  return {
    DB_HOST: connection?.hostname ?? pool.options.host,
    DB_PORT: connection?.port || String(pool.options.port),
    DB_USER: connection
      ? decodeURIComponent(connection.username)
      : pool.options.user,
    DB_PASSWORD: connection
      ? decodeURIComponent(connection.password)
      : (pool.options.password ?? ''),
    DB_NAME: connection
      ? decodeURIComponent(connection.pathname.slice(1))
      : pool.options.database,
    DB_SSL: 'false',
  };
}

async function createSignedItem(payload) {
  const [{ TurboFactory }, { createUmi }, umiModule] = await Promise.all([
    import('@ardrive/turbo-sdk'),
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const umi = createUmi('http://127.0.0.1:8899');
  const signer = umiModule.generateSigner(umi);
  const turbo = TurboFactory.authenticated({
    privateKey: bs58.encode(signer.secretKey),
    token: 'solana',
    gatewayUrl: 'https://example.invalid',
  });
  const signed = await turbo.signer.signDataItem({
    fileStreamFactory: () => Buffer.from(payload),
    fileSizeFactory: () => payload.byteLength,
    dataItemOpts: { tags: [{ name: 'Content-Type', value: 'image/png' }] },
  });
  const chunks = [];
  for await (const chunk of signed.dataItemStreamFactory())
    chunks.push(Buffer.from(chunk));
  const bytes = Buffer.concat(chunks);
  const { DataItem } = require('@dha-team/arbundles');
  return { bytes, id: new DataItem(bytes).id };
}

async function seedBlockedRelease(
  pool,
  state = 'BLOCKED',
  errorCode = 'NFT_MEDIA_SIGNED_ITEM_MISSING',
) {
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const walletAddress = bs58.encode(randomBytes(32));
  const walletId = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [userId, walletAddress],
    )
  ).rows[0].id;
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 500, 500, 1,
             CURRENT_TIMESTAMP - interval '2 hours',
             CURRENT_TIMESTAMP - interval '1 hour')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Operator retry', 2)`,
    [seasonId, userId],
  );
  const snapshotId = randomUUID();
  await pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 0, 'operator-test', 500, 500, 'READY', true,
             $3, $4, 3, 2, $5, $6, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `snapshots/seasons/${seasonId}/${snapshotId}/image.png`,
      `snapshots/seasons/${seasonId}/${snapshotId}/continuation.json`,
      'a'.repeat(64),
      'b'.repeat(64),
    ],
  );
  const releaseId = randomUUID();
  const stage = state === 'READY' ? 'LOCKED' : 'MACHINE';
  const finalizedAt = state === 'READY' ? new Date() : null;
  await pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, snapshot_id, through_sequence,
        eligible_count, frozen_title, frozen_description, season_ended_at,
        asset_name, image_byte_length, image_sha256, metadata_sha256,
        image_uri, metadata_uri, collection_address, candy_machine_address,
        candy_guard_address, merkle_root, preparation_keys, locked_at, ready_at,
        last_error_code, last_error_message)
     VALUES ($1, $2, 'devnet', $3, $4, $5, 0, 1,
             'Frozen title', 'Frozen description', CURRENT_TIMESTAMP - interval '1 hour',
             'Frozen NFT', 3, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
             $15, $15,
             $16, 'The release was blocked for the operator test.')`,
    [
      releaseId,
      seasonId,
      state,
      stage,
      snapshotId,
      'a'.repeat(64),
      'c'.repeat(64),
      'https://arweave.net/image',
      'https://arweave.net/metadata',
      bs58.encode(randomBytes(32)),
      bs58.encode(randomBytes(32)),
      bs58.encode(randomBytes(32)),
      randomBytes(32),
      JSON.stringify({ collection: 'devnet/release/collection.json' }),
      finalizedAt,
      errorCode,
    ],
  );
  const claimId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, receipt_state)
     VALUES ($1, $2, 'devnet', $3, $4, $5, 'UNCLAIMED', '[]', 'NONE')`,
    [claimId, releaseId, userId, walletId, walletAddress],
  );
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, operation_key, kind, state, message_hash,
        serialized_transaction, signature, recent_blockhash,
        last_valid_block_height)
     VALUES ($1, 'devnet', $2, 'setup:machine:0', 'SETUP_MACHINE', 'SIGNED',
             $3, $4, $5, 'blockhash', 100)`,
    [
      transactionId,
      releaseId,
      'd'.repeat(64),
      Buffer.from([1, 2, 3]),
      `signed-${transactionId}`,
    ],
  );
  await pool.query(
    `INSERT INTO season_nft_uploads
       (id, release_id, kind, state, sha256, byte_length, data_item_id,
        signed_item_path)
     VALUES ($1, $2, 'IMAGE', 'PREPARED', $3, 3, $4,
             'release/image.signed')`,
    [randomUUID(), releaseId, 'a'.repeat(64), `data-item-${releaseId}`],
  );
  return { releaseId, seasonId, claimId, transactionId };
}

test('retry reschedules one eligible BLOCKED release and preserves frozen and dependent evidence', async () => {
  const { pool } = await testDatabaseModule();
  const seeded = await seedBlockedRelease(pool);
  const uploadRoot = await mkdtemp(join(tmpdir(), 'season-nft-retry-upload-'));
  await mkdir(join(uploadRoot, 'release'), { mode: 0o700 });
  const payload = Buffer.from('signed-item');
  const signed = await createSignedItem(payload);
  await writeFile(join(uploadRoot, 'release/image.signed'), signed.bytes, {
    mode: 0o600,
  });
  await pool.query(
    `UPDATE season_nft_uploads
     SET data_item_id = $2, sha256 = $3, byte_length = $4
     WHERE release_id = $1`,
    [
      seeded.releaseId,
      signed.id,
      createHash('sha256').update(payload).digest('hex'),
      payload.byteLength,
    ],
  );
  const before = (
    await pool.query(
      `SELECT to_jsonb(r) - ARRAY['state','last_error_code','last_error_message',
             'next_attempt_at','version','updated_at']::text[] AS frozen
       FROM season_nft_releases r WHERE id = $1`,
      [seeded.releaseId],
    )
  ).rows[0].frozen;
  const dependentsBefore = await pool.query(
    `SELECT
       (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM season_nft_claims c WHERE c.release_id = $1) AS claims,
       (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM season_nft_transactions t WHERE t.release_id = $1) AS transactions,
       (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM season_nft_uploads u WHERE u.release_id = $1) AS uploads`,
    [seeded.releaseId],
  );

  const result = await retryRelease(pool, {
    releaseId: seeded.releaseId,
    network: 'devnet',
  }, { NFT_UPLOAD_WORK_DIR: uploadRoot });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.output, {
    status: 'PASS',
    checks: [
      {
        id: 'RETRY_RELEASE',
        status: 'PASS',
        code: 'RELEASE_RESCHEDULED',
        message: 'The blocked release was rescheduled with frozen evidence preserved.',
      },
    ],
  });
  const after = await pool.query(
    `SELECT state, last_error_code,
            to_jsonb(r) - ARRAY['state','last_error_code','last_error_message',
              'next_attempt_at','version','updated_at']::text[] AS frozen
     FROM season_nft_releases r WHERE id = $1`,
    [seeded.releaseId],
  );
  assert.equal(after.rows[0].state, 'PREPARING');
  assert.equal(after.rows[0].last_error_code, null);
  assert.deepEqual(after.rows[0].frozen, before);
  assert.deepEqual(
    (
      await pool.query(
        `SELECT
           (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM season_nft_claims c WHERE c.release_id = $1) AS claims,
           (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM season_nft_transactions t WHERE t.release_id = $1) AS transactions,
           (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM season_nft_uploads u WHERE u.release_id = $1) AS uploads`,
        [seeded.releaseId],
      )
    ).rows,
    dependentsBefore.rows,
  );
});

test('retry rechecks RPC causes through SOLANA_RPC_URL and keeps failures blocked', async (t) => {
  const { pool } = await testDatabaseModule();
  const expectedGenesis = require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain.js')
    .EXPECTED_GENESIS_HASHES.devnet;
  const rpc = await startGenesisRpc(t, expectedGenesis);

  const restored = await seedBlockedRelease(pool, 'BLOCKED', 'NFT_RPC_RETRY');
  const restoredOutcome = await retryRelease(
    pool,
    { releaseId: restored.releaseId, network: 'devnet' },
    { SOLANA_RPC_URL: rpc.url },
  );
  assert.equal(restoredOutcome.exitCode, 0);
  assert.equal(restoredOutcome.output.checks[0].code, 'RELEASE_RESCHEDULED');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [restored.releaseId])).rows[0].state,
    'PREPARING',
  );

  rpc.setMode('wrong');
  const wrongNetwork = await seedBlockedRelease(pool, 'BLOCKED', 'NFT_RPC_RETRY');
  const wrongNetworkOutcome = await retryRelease(
    pool,
    { releaseId: wrongNetwork.releaseId, network: 'devnet' },
    { SOLANA_RPC_URL: rpc.url },
  );
  assert.equal(wrongNetworkOutcome.exitCode, 1);
  assert.equal(wrongNetworkOutcome.output.checks[0].code, 'RELEASE_CAUSE_NOT_CLEARED');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [wrongNetwork.releaseId])).rows[0].state,
    'BLOCKED',
  );

  rpc.setMode('error');
  const unavailable = await seedBlockedRelease(pool, 'BLOCKED', 'NFT_RPC_RETRY');
  const unavailableOutcome = await retryRelease(
    pool,
    { releaseId: unavailable.releaseId, network: 'devnet' },
    { SOLANA_RPC_URL: rpc.url },
  );
  assert.equal(unavailableOutcome.exitCode, 1);
  assert.equal(unavailableOutcome.output.checks[0].code, 'RELEASE_CAUSE_NOT_CLEARED');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [unavailable.releaseId])).rows[0].state,
    'BLOCKED',
  );
  assert.deepEqual(rpc.requests, ['getGenesisHash', 'getGenesisHash', 'getGenesisHash']);
});

test('retry leaves terminal releases unchanged and rejects a network mismatch', async () => {
  const { pool } = await testDatabaseModule();
  const terminal = await seedBlockedRelease(pool, 'READY');
  const ready = await retryRelease(pool, {
    releaseId: terminal.releaseId,
    network: 'devnet',
  });
  assert.equal(ready.exitCode, 0);
  assert.equal(ready.output.checks[0].code, 'RELEASE_TERMINAL_UNCHANGED');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [terminal.releaseId])).rows[0].state,
    'READY',
  );

  const blocked = await seedBlockedRelease(pool);
  const mismatch = await retryRelease(pool, {
    releaseId: blocked.releaseId,
    network: 'mainnet-beta',
  });
  assert.equal(mismatch.exitCode, 1);
  assert.equal(mismatch.output.checks[0].code, 'RELEASE_NETWORK_MISMATCH');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [blocked.releaseId])).rows[0].state,
    'BLOCKED',
  );
});

test('retry keeps BLOCKED state until the recorded missing signed item is restored', async () => {
  const { pool } = await testDatabaseModule();
  const seeded = await seedBlockedRelease(pool);
  const uploadRoot = await mkdtemp(join(tmpdir(), 'season-nft-retry-missing-'));

  const outcome = await retryRelease(
    pool,
    { releaseId: seeded.releaseId, network: 'devnet' },
    { NFT_UPLOAD_WORK_DIR: uploadRoot },
  );

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.output.checks[0].code, 'RELEASE_CAUSE_NOT_CLEARED');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [seeded.releaseId])).rows[0].state,
    'BLOCKED',
  );
});

test('retry rejects a corrupt file at the restored signed-item path', async () => {
  const { pool } = await testDatabaseModule();
  const seeded = await seedBlockedRelease(pool);
  const uploadRoot = await mkdtemp(join(tmpdir(), 'season-nft-retry-corrupt-'));
  await mkdir(join(uploadRoot, 'release'), { mode: 0o700 });
  await writeFile(join(uploadRoot, 'release/image.signed'), 'not-an-ans104-item', {
    mode: 0o600,
  });

  const outcome = await retryRelease(
    pool,
    { releaseId: seeded.releaseId, network: 'devnet' },
    { NFT_UPLOAD_WORK_DIR: uploadRoot },
  );

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.output.checks[0].code, 'RELEASE_CAUSE_NOT_CLEARED');
});

test('retry rejects a preparation key whose seed does not derive its frozen address', async () => {
  const { pool } = await testDatabaseModule();
  const seeded = await seedBlockedRelease(
    pool,
    'BLOCKED',
    'NFT_PREPARATION_KEY_MISSING',
  );
  const [{ createUmi }, umiModule] = await Promise.all([
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/umi'),
  ]);
  const signer = umiModule.generateSigner(createUmi('http://127.0.0.1:8899'));
  const relativePath = `devnet/${seeded.releaseId}/collection.json`;
  const keyRoot = await mkdtemp(join(tmpdir(), 'season-nft-retry-key-'));
  await mkdir(join(keyRoot, 'devnet', seeded.releaseId), {
    recursive: true,
    mode: 0o700,
  });
  const corrupt = [...signer.secretKey];
  corrupt[0] = (corrupt[0] + 1) % 256;
  await writeFile(join(keyRoot, relativePath), JSON.stringify(corrupt), {
    mode: 0o600,
  });
  await pool.query(
    `UPDATE season_nft_releases SET preparation_keys = $2::jsonb
     WHERE id = $1`,
    [seeded.releaseId, JSON.stringify({ [String(signer.publicKey)]: relativePath })],
  );

  const outcome = await retryRelease(
    pool,
    { releaseId: seeded.releaseId, network: 'devnet' },
    { NFT_PREPARATION_KEY_DIR: keyRoot },
  );

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.output.checks[0].code, 'RELEASE_CAUSE_NOT_CLEARED');
});

test('retry rejects blocked causes without a safe cause-specific recheck', async () => {
  const { pool } = await testDatabaseModule();
  const seeded = await seedBlockedRelease(
    pool,
    'BLOCKED',
    'NFT_CHAIN_ACCOUNT_INVALID',
  );

  const outcome = await retryRelease(pool, {
    releaseId: seeded.releaseId,
    network: 'devnet',
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.output.checks[0].code, 'RELEASE_CAUSE_NOT_CLEARED');
  assert.equal(
    (await pool.query('SELECT state FROM season_nft_releases WHERE id = $1', [seeded.releaseId])).rows[0].state,
    'BLOCKED',
  );
});

test('missing release rolls back before returning the pooled connection', async () => {
  const { pool } = await testDatabaseModule();
  const applicationName = `retry-missing-${randomUUID()}`;
  const isolated = new Pool({
    ...pool.options,
    max: 1,
    application_name: applicationName,
  });
  try {
    const missing = await retryRelease(isolated, {
      releaseId: randomUUID(),
      network: 'devnet',
    });
    assert.equal(missing.exitCode, 1);
    assert.equal(missing.output.checks[0].code, 'RELEASE_NOT_FOUND');
    const activity = await pool.query(
      `SELECT state FROM pg_stat_activity
       WHERE datname = current_database() AND application_name = $1`,
      [applicationName],
    );
    assert.deepEqual(activity.rows, [{ state: 'idle' }]);
  } finally {
    await isolated.end();
  }
});
