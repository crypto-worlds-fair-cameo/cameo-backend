const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  EXPECTED_PACKAGES,
  PROGRAM_ADDRESSES,
  REQUIRED_EXTERNAL_TESTS,
  loadSdkContract,
  verifyLocalSdk,
  createPendingEvidence,
} = require('../../scripts/season-nft/sdk-validation.cjs');

test('installed SDK contract exposes the operations used by preparation and claims', async () => {
  const contract = await loadSdkContract();

  assert.deepEqual(contract.packages, EXPECTED_PACKAGES);
  assert.deepEqual(contract.programAddresses, PROGRAM_ADDRESSES);
  assert.deepEqual(contract.missingExports, []);
});

test('100-wallet proof and mint transactions fit the Solana transaction limit', async () => {
  const result = await verifyLocalSdk();

  assert.equal(result.checks.find(({ id }) => id === 'proofFits100').status, 'PASS');
  assert.equal(result.checks.find(({ id }) => id === 'mintFits100').status, 'PASS');
  assert.ok(result.transactionBytes.proof > 0);
  assert.ok(result.transactionBytes.proof <= 1232);
  assert.ok(result.transactionBytes.mint > 0);
  assert.ok(result.transactionBytes.mint <= 1232);
  assert.equal(result.payer, result.recipient);
  assert.equal(result.encodedOwner, result.recipient);
  assert.deepEqual(result.transactionSignatures.proof, {
    required: 1,
    valid: 1,
  });
  assert.deepEqual(result.transactionSignatures.mint, {
    required: 2,
    valid: 2,
  });
});

test('persisted Turbo signed bytes round-trip locally without claiming upload recovery', async () => {
  const result = await verifyLocalSdk();
  const check = result.checks.find(({ id }) => id === 'signedItemRoundTrip');

  assert.equal(check.status, 'PASS');
  assert.match(result.signedItem.id, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(result.signedItem.byteLength > 0);
  assert.equal(
    result.checks.some(({ id }) => id === 'uploadItemRestoresSameId'),
    false,
  );
});

test('missing external credentials keep chain and storage gates independent and not run', async () => {
  const local = await verifyLocalSdk();
  const evidence = createPendingEvidence(local, 'Devnet validation inputs were not provided.');

  assert.deepEqual(evidence.gates, {
    LOCAL_SDK: 'PASS',
    CHAIN_AUTHORITY: 'NOT_RUN',
    STORAGE_RECOVERY: 'NOT_RUN',
  });
  assert.equal(evidence.overallStatus, 'EXTERNAL_VALIDATION_PENDING');
  const locallyVerified = new Set(local.checks.map(({ id }) => id));
  for (const id of REQUIRED_EXTERNAL_TESTS) {
    const item = evidence.tests.find((entry) => entry.id === id);
    assert.ok(item, `missing evidence test ${id}`);
    if (!locallyVerified.has(id)) assert.notEqual(item.status, 'PASS');
  }
  assert.equal(
    evidence.tests.find(({ id }) => id === 'uploadItemRestoresSameId').status,
    'NOT_RUN',
  );
  for (const id of ['uploadItemRestoresSameId', 'permanentUploadRetrievable']) {
    assert.equal(evidence.tests.find((item) => item.id === id).gate, 'STORAGE_RECOVERY');
  }
});

test('dry-run CLI writes one machine-readable pending result without external mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-sdk-evidence-'));
  const evidencePath = join(directory, 'evidence.json');
  const result = spawnSync(
    process.execPath,
    ['scripts/season-nft/verify-devnet.cjs', '--json', '--evidence', evidencePath],
    {
      cwd: join(__dirname, '../..'),
      encoding: 'utf8',
      env: { ...process.env, SOLANA_NETWORK: 'devnet' },
    },
  );

  assert.equal(result.status, 3, result.stderr);
  const stdout = JSON.parse(result.stdout);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(stdout.status, 'EXTERNAL_VALIDATION_PENDING');
  assert.equal(evidence.overallStatus, stdout.status);
  assert.equal(evidence.gates.LOCAL_SDK, 'PASS');
  assert.equal(evidence.gates.CHAIN_AUTHORITY, 'NOT_RUN');
  assert.equal(evidence.gates.STORAGE_RECOVERY, 'NOT_RUN');
});

test('CLI rejects mainnet before loading credentials or submitting transactions', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/season-nft/verify-devnet.cjs', '--execute', '--json'],
    {
      cwd: join(__dirname, '../..'),
      encoding: 'utf8',
      env: { ...process.env, SOLANA_NETWORK: 'mainnet-beta' },
    },
  );

  assert.equal(result.status, 2);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.status, 'CONFIGURATION_ERROR');
  assert.equal(stdout.checks[0].code, 'DEVNET_REQUIRED');
});

test('execute mode without isolated Devnet inputs records external validation as not run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-sdk-missing-inputs-'));
  const result = spawnSync(
    process.execPath,
    [
      'scripts/season-nft/verify-devnet.cjs',
      '--execute',
      '--json',
      '--evidence',
      join(directory, 'evidence.json'),
    ],
    {
      cwd: join(__dirname, '../..'),
      encoding: 'utf8',
      env: { SOLANA_NETWORK: 'devnet', PATH: process.env.PATH },
    },
  );

  assert.equal(result.status, 3, result.stderr);
  const stdout = JSON.parse(result.stdout);
  assert.equal(stdout.status, 'EXTERNAL_VALIDATION_PENDING');
  assert.equal(stdout.gates.CHAIN_AUTHORITY, 'NOT_RUN');
  assert.equal(stdout.gates.STORAGE_RECOVERY, 'NOT_RUN');
  assert.match(
    stdout.checks.find(({ id }) => id === 'mintAfterLock').reason,
    /NFT_PREPARATION_KEY_DIR/,
  );
  assert.match(
    stdout.checks.find(({ id }) => id === 'permanentUploadRetrievable').reason,
    /NFT_UPLOAD_WORK_DIR/,
  );
});

test('execute mode rejects relative persistence roots before fixture creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-sdk-relative-roots-'));
  const result = spawnSync(
    process.execPath,
    [join(__dirname, '../../scripts/season-nft/verify-devnet.cjs'), '--execute', '--json', '--evidence', join(directory, 'evidence.json')],
    {
      cwd: directory,
      encoding: 'utf8',
      env: {
        SOLANA_NETWORK: 'devnet',
        SOLANA_RPC_URL: 'http://127.0.0.1:1',
        NFT_PREPARATION_KEY_DIR: 'relative-keys',
        NFT_UPLOAD_WORK_DIR: 'relative-uploads',
        PATH: process.env.PATH,
      },
    },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).checks[0].code, 'ABSOLUTE_ROOT_REQUIRED');
  assert.deepEqual(await readdir(directory), []);
});

test('final lock transaction removes the start gate and locks guard authority atomically', async () => {
  const { createFinalLockBuilder } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const contract = await loadSdkContract();
  const umiModule = contract.modules['@metaplex-foundation/umi'];
  const { createUmi } = contract.modules['@metaplex-foundation/umi-bundle-defaults'];
  const core = contract.modules['@metaplex-foundation/mpl-core'];
  const candy = contract.modules['@metaplex-foundation/mpl-core-candy-machine'];
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const authority = umiModule.generateSigner(umi);
  umi.use(umiModule.signerIdentity(authority));
  const root = candy.getMerkleRoot([authority.publicKey]);
  const builder = createFinalLockBuilder({
    umi,
    candy,
    authority,
    candyGuard: umiModule.generateSigner(umi).publicKey,
    lockAuthority: umiModule.generateSigner(umi).publicKey,
    merkleRoot: root,
  });

  assert.equal(builder.items.length, 2);
  assert.deepEqual(
    builder.items.map(({ instruction }) => String(instruction.programId)),
    [PROGRAM_ADDRESSES.mplCoreCandyGuard, PROGRAM_ADDRESSES.mplCoreCandyGuard],
  );
});

test('Devnet scenario builders construct and sign offline within transaction limits', async () => {
  const { createFinalLockBuilder } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const contract = await loadSdkContract();
  const umiModule = contract.modules['@metaplex-foundation/umi'];
  const { createUmi } = contract.modules['@metaplex-foundation/umi-bundle-defaults'];
  const core = contract.modules['@metaplex-foundation/mpl-core'];
  const candy = contract.modules['@metaplex-foundation/mpl-core-candy-machine'];
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.generateSigner(umi);
  const user = umiModule.generateSigner(umi);
  const collection = umiModule.generateSigner(umi);
  const alternateCollection = umiModule.generateSigner(umi);
  const machine = umiModule.generateSigner(umi);
  const asset = umiModule.generateSigner(umi);
  const lockAuthority = umiModule.generateSigner(umi).publicKey;
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  const merkleRoot = candy.getMerkleRoot([user.publicKey]);
  const blockhash = '11111111111111111111111111111111';
  umi.use(umiModule.signerIdentity(service));
  umi.rpc.getRent = async () => umiModule.lamports(10_000_000n);

  const createMachine = await candy.create(umi, {
    candyMachine: machine,
    collection: collection.publicKey,
    collectionUpdateAuthority: service,
    payer: service,
    authority: service.publicKey,
    itemsAvailable: 2,
    maxEditionSupply: 0,
    isMutable: false,
    hiddenSettings: umiModule.some({
      name: 'Cameo Season SDK Validation',
      uri: 'https://example.invalid/metadata.json',
      hash: new Uint8Array(32),
    }),
    configLineSettings: umiModule.none(),
    guards: {
      allowList: umiModule.some({ merkleRoot }),
      mintLimit: umiModule.some({ id: 0, limit: 1 }),
      startDate: umiModule.some({ date: umiModule.dateTime(2_000_000_000) }),
    },
    groups: [],
  });
  const builders = {
    createCollection: core.createCollection(umi, {
      collection,
      updateAuthority: service.publicKey,
      payer: service,
      name: 'Cameo Season SDK Validation',
      uri: 'https://example.invalid/metadata.json',
      plugins: [{ type: 'ImmutableMetadata' }],
    }),
    createMachine,
    lockMachine: candy.setCandyMachineAuthority(umi, {
      candyMachine: machine.publicKey,
      authority: service,
      newAuthority: lockAuthority,
    }),
    lockCollection: core.removeCollectionPlugin(umi, {
      collection: collection.publicKey, payer: service, authority: service, plugin: { type: 'ImmutableMetadata' },
    }).add(core.updateCollectionV1(umi, {
      collection: collection.publicKey,
      payer: service,
      authority: service,
      newUpdateAuthority: lockAuthority,
      newName: umiModule.none(),
      newUri: umiModule.none(),
    })),
    finalLock: createFinalLockBuilder({
      umi,
      candy,
      authority: service,
      candyGuard: guard,
      lockAuthority,
      merkleRoot,
    }),
    updateMachine: candy.updateCandyMachine(umi, {
      candyMachine: machine.publicKey,
      authority: service,
      data: {
        itemsAvailable: 3,
        maxEditionSupply: 0,
        isMutable: false,
        hiddenSettings: umiModule.some({
          name: 'Cameo Season SDK Validation',
          uri: 'https://example.invalid/metadata.json',
          hash: new Uint8Array(32),
        }),
        configLineSettings: umiModule.none(),
      },
    }),
    updateGuard: candy.updateCandyGuard(umi, {
      candyGuard: guard,
      authority: service,
      guards: {
        allowList: umiModule.some({ merkleRoot }),
        mintLimit: umiModule.some({ id: 0, limit: 1 }),
      },
      groups: [],
    }),
    setMintAuthority: candy.setMintAuthority(umi, {
      candyMachine: machine.publicKey,
      authority: service,
      mintAuthority: service,
    }),
    directMint: candy.mintAssetFromCandyMachine(umi, {
      candyMachine: machine.publicKey,
      mintAuthority: service,
      payer: service,
      assetOwner: service.publicKey,
      asset,
      collection: collection.publicKey,
      plugins: [],
    }),
    updateAsset: core.updateV1(umi, {
      asset: asset.publicKey,
      collection: collection.publicKey,
      payer: service,
      authority: service,
      newName: umiModule.some('mutated'),
      newUri: umiModule.none(),
      newUpdateAuthority: umiModule.none(),
    }),
    moveCollection: core.updateV2(umi, {
      asset: asset.publicKey,
      collection: collection.publicKey,
      newCollection: alternateCollection.publicKey,
      payer: service,
      authority: service,
      newName: umiModule.none(),
      newUri: umiModule.none(),
      newUpdateAuthority: umiModule.none(),
    }),
    transfer: core.transferV1(umi, {
      asset: asset.publicKey,
      collection: collection.publicKey,
      payer: service,
      authority: service,
      newOwner: user.publicKey,
    }),
    burn: core.burnV1(umi, {
      asset: asset.publicKey,
      collection: collection.publicKey,
      payer: service,
      authority: service,
    }),
  };

  for (const [name, builder] of Object.entries(builders)) {
    const signed = await builder.setBlockhash(blockhash).buildAndSign(umi);
    const serialized = umi.transactions.serialize(signed);
    const byteLength = serialized.length;
    assert.ok(byteLength > 0, `${name} did not serialize`);
    assert.ok(byteLength <= 1232, `${name} is ${byteLength} bytes`);
    assert.ok(signed.signatures.every((signature) => (
      signature.length === 64 && Buffer.from(signature).some(Boolean)
    )), `${name} has an invalid required signature`);
    assert.deepEqual(
      Buffer.from(umi.transactions.serialize(umi.transactions.deserialize(serialized))),
      Buffer.from(serialized),
      `${name} changed during recovery deserialization`,
    );
  }
  assert.equal(builders.finalLock.items.length, 2);
});

test('rejection evidence accepts program errors but never timeout or transport failures', () => {
  const {
    isProgramRejection,
    matchesExpectedProgramRejection,
    redactDiagnostic,
    simulationRejectionEvidence,
  } = require('../../scripts/season-nft/sdk-devnet.cjs');

  const programFailure = {
    value: {
      err: { InstructionError: [0, { Custom: 6029 }] },
      logs: ['Program CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ failed: custom program error: 0x178d'],
    },
  };
  assert.equal(isProgramRejection(programFailure), true);
  assert.equal(matchesExpectedProgramRejection(
    programFailure,
    PROGRAM_ADDRESSES.mplCoreCandyGuard,
    [0x178d],
  ), true);
  assert.equal(matchesExpectedProgramRejection(
    programFailure,
    PROGRAM_ADDRESSES.mplCoreCandyGuard,
    [0x177b],
  ), false, 'sold-out or unrelated errors must not prove mint-limit rejection');
  assert.equal(isProgramRejection({ error: { message: 'fetch timed out' } }), false);
  assert.equal(isProgramRejection({ value: { err: null, logs: [] } }), false);
  const evidence = simulationRejectionEvidence(
    programFailure,
    PROGRAM_ADDRESSES.mplCoreCandyGuard,
    'https://secret.example/rpc?api-key=hidden',
  );
  assert.match(evidence.reason, new RegExp(PROGRAM_ADDRESSES.mplCoreCandyGuard));
  assert.match(evidence.reason, /6029/);
  assert.deepEqual(evidence.details.logTail, programFailure.value.logs);
  assert.equal(
    redactDiagnostic(
      'POST https://secret.example/rpc?api-key=hidden timed out',
      'https://secret.example/rpc?api-key=hidden',
    ),
    'POST [RPC_ENDPOINT] timed out',
  );
});

test('evidence cannot become externally verified when a required result is omitted', async () => {
  const { finalizeEvidence } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const local = await verifyLocalSdk();
  const localIds = new Set(local.checks.map(({ id }) => id));
  const external = REQUIRED_EXTERNAL_TESTS
    .filter((id) => !localIds.has(id) && id !== 'outsiderRejected')
    .map((id) => ({
      id,
      gate: ['uploadItemRestoresSameId', 'permanentUploadRetrievable'].includes(id)
        ? 'STORAGE_RECOVERY'
        : 'CHAIN_AUTHORITY',
      status: 'PASS',
      signatures: [],
      reason: null,
    }));
  const evidence = finalizeEvidence(local, external);

  assert.equal(evidence.overallStatus, 'BLOCKED_TECHNICAL');
  assert.equal(evidence.gates.LOCAL_SDK, 'FAIL');
  assert.match(
    evidence.tests.find(({ id }) => id === 'evidenceIntegrity').reason,
    /outsiderRejected occurs 0 times/,
  );
});

test('evidence rejects unknown statuses instead of treating them as pass', async () => {
  const { finalizeEvidence } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const local = await verifyLocalSdk();
  const localIds = new Set(local.checks.map(({ id }) => id));
  const external = REQUIRED_EXTERNAL_TESTS
    .filter((id) => !localIds.has(id))
    .map((id) => ({
      id,
      gate: ['uploadItemRestoresSameId', 'permanentUploadRetrievable'].includes(id)
        ? 'STORAGE_RECOVERY'
        : 'CHAIN_AUTHORITY',
      status: 'UNKNOWN',
      signatures: [],
      reason: null,
    }));
  const evidence = finalizeEvidence(local, external);

  assert.equal(evidence.overallStatus, 'BLOCKED_TECHNICAL');
  assert.match(evidence.tests.find(({ id }) => id === 'evidenceIntegrity').reason, /invalid status UNKNOWN/);
});

test('Core burn evidence requires the one-byte uninitialized tombstone', () => {
  const { inspectBurnTombstone } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const tombstone = inspectBurnTombstone({
    exists: true,
    owner: PROGRAM_ADDRESSES.mplCore,
    data: Uint8Array.of(0),
    lamports: { basisPoints: 890_880n },
  }, PROGRAM_ADDRESSES.mplCore);

  assert.deepEqual(tombstone, {
    owner: PROGRAM_ADDRESSES.mplCore,
    byteLength: 1,
    discriminator: 0,
    lamports: '890880',
  });
  assert.throws(() => inspectBurnTombstone({ exists: false }, PROGRAM_ADDRESSES.mplCore), /tombstone/);
  assert.throws(() => inspectBurnTombstone({
    exists: true,
    owner: PROGRAM_ADDRESSES.mplCore,
    data: Uint8Array.of(1),
    lamports: { basisPoints: 1n },
  }, PROGRAM_ADDRESSES.mplCore), /uninitialized/);
});

test('mint fee components use named simulated accounts and preserve nonzero protocol fees', () => {
  const { deriveMintFeeComponents } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const result = deriveMintFeeComponents({
    feeLamports: 100n,
    priorityFeeLamports: 0n,
    payerAddress: 'payer',
    addresses: ['payer', 'asset', 'counter', 'protocol'],
    preBalances: [10_000n, 0n, 0n, 100n],
    postBalances: [8_500n, 1_000n, 200n, 300n],
    rentByAddress: new Map([['asset', 700n], ['counter', 100n]]),
  });

  assert.equal(result.payerDebitLamports, 1_500n);
  assert.equal(result.rentLamports, 800n);
  assert.equal(result.protocolLamports, 600n);
  assert.equal(result.totalLamports, 1_500n);
  assert.deepEqual(result.namedAccounts.asset, {
    beforeLamports: '0',
    afterLamports: '1000',
    rentLamports: '700',
    protocolLamports: '300',
  });

  const simulationWithoutFeeDebit = deriveMintFeeComponents({
    feeLamports: 100n,
    priorityFeeLamports: 0n,
    payerAddress: 'payer',
    addresses: ['payer', 'asset', 'counter', 'protocol'],
    preBalances: [10_000n, 0n, 0n, 100n],
    postBalances: [8_600n, 1_000n, 200n, 300n],
    rentByAddress: new Map([['asset', 700n], ['counter', 100n]]),
  });
  assert.equal(simulationWithoutFeeDebit.observedPayerDebitLamports, 1_400n);
  assert.equal(simulationWithoutFeeDebit.payerDebitLamports, 1_500n);
  assert.equal(simulationWithoutFeeDebit.feeObservedInPayerBalance, false);
});

test('external verification requires and persists complete observed lock state', async () => {
  const { finalizeEvidence } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const local = await verifyLocalSdk();
  const localIds = new Set(local.checks.map(({ id }) => id));
  const external = REQUIRED_EXTERNAL_TESTS
    .filter((id) => !localIds.has(id))
    .map((id) => ({
      id,
      gate: ['uploadItemRestoresSameId', 'permanentUploadRetrievable'].includes(id)
        ? 'STORAGE_RECOVERY'
        : 'CHAIN_AUTHORITY',
      status: 'PASS',
      signatures: [],
      reason: null,
    }));
  const withoutObservedState = finalizeEvidence(local, external);
  assert.equal(withoutObservedState.overallStatus, 'BLOCKED_TECHNICAL');
  assert.match(
    withoutObservedState.tests.find(({ id }) => id === 'evidenceIntegrity').reason,
    /observed lock state is missing/,
  );

  const lockAddress = '11111111111111111111111111111111';
  const guardAddress = PROGRAM_ADDRESSES.mplCoreCandyGuard;
  const collectionAddress = PROGRAM_ADDRESSES.mplCore;
  const observedLockState = {
    candyGuardAddress: guardAddress,
    collectionAddress,
    derivation: {
      programId: '11111111111111111111111111111111',
      seedUtf8: 'cameo-nft-lock-v1',
      bump: 254,
      address: lockAddress,
    },
    machineAuthority: { expected: lockAddress, actual: lockAddress },
    mintAuthority: { expected: guardAddress, actual: guardAddress },
    guardAuthority: { expected: lockAddress, actual: lockAddress },
    collectionUpdateAuthority: { expected: lockAddress, actual: lockAddress },
    immutableMetadata: { present: false, authorityKind: null },
    collectionMetadataProtection: 'LOCKED_AUTHORITY',
    collectionDelegatePluginsPresent: ['updateDelegate'],
    collectionMintDelegate: { expected: 'machine-pda', actual: ['machine-pda'], authorityKind: 'UpdateAuthority' },
    assets: ['asset-a', 'asset-b'].map((address) => ({
      address,
      updateAuthority: { type: 'Collection', address: collectionAddress },
      delegatePluginsPresent: [],
    })),
  };
  const evidence = finalizeEvidence(local, external, { observedLockState });
  assert.equal(evidence.overallStatus, 'EXTERNAL_VERIFIED');
  assert.deepEqual(evidence.observedLockState, observedLockState);
  for (const changed of [
    { collectionMintDelegate: undefined },
    { collectionDelegatePluginsPresent: [] },
    { collectionDelegatePluginsPresent: ['updateDelegate', 'burnDelegate'] },
    { collectionMintDelegate: { expected: 'machine-pda', actual: ['unexpected'], authorityKind: 'UpdateAuthority' } },
    { collectionMintDelegate: { expected: 'machine-pda', actual: ['machine-pda', 'unexpected'], authorityKind: 'UpdateAuthority' } },
  ]) assert.equal(finalizeEvidence(local, external, { observedLockState: { ...observedLockState, ...changed } }).overallStatus, 'BLOCKED_TECHNICAL');
});

test('signed transaction response loss reconciles by signature without rebuilding bytes', async () => {
  const { sendSignedTransaction } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-signed-send-'));
  const transaction = {
    signatures: [Uint8Array.from({ length: 64 }, () => 7)],
    message: { accounts: [] },
  };
  let sends = 0;
  const umi = {
    transactions: { serialize: () => Uint8Array.of(1, 2, 3, 4) },
    rpc: {
      sendTransaction: async (sent) => {
        sends += 1;
        assert.equal(sent, transaction);
        throw new Error('RPC timeout after send');
      },
      getSignatureStatuses: async () => [{ error: null, commitment: 'finalized', confirmations: null }],
    },
  };

  const signature = await sendSignedTransaction(umi, transaction, {
    directory,
    label: 'response-lost',
    retryDelayMs: 0,
  });
  assert.equal(sends, 1);
  assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]+$/);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(directory, files[0])), Buffer.from([1, 2, 3, 4]));
});

test('unresolved signed transaction retries the identical transaction and persisted bytes', async () => {
  const { sendSignedTransaction } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-signed-resend-'));
  const transaction = {
    signatures: [Uint8Array.from({ length: 64 }, () => 9)],
    message: { accounts: [] },
  };
  const sent = [];
  let statusQueries = 0;
  const umi = {
    transactions: { serialize: () => Uint8Array.of(5, 6, 7, 8) },
    rpc: {
      sendTransaction: async (value) => {
        sent.push(value);
        throw new Error('RPC timeout after send');
      },
      getSignatureStatuses: async () => {
        statusQueries += 1;
        return [statusQueries > 8
          ? { error: null, commitment: 'finalized', confirmations: null }
          : null];
      },
    },
  };

  await sendSignedTransaction(umi, transaction, {
    directory,
    label: 'same-bytes',
    retryDelayMs: 0,
    sendAttempts: 2,
  });
  assert.deepEqual(sent, [transaction, transaction]);
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(directory, files[0])), Buffer.from([5, 6, 7, 8]));
});

test('exhausted signature status remains pending with its persisted signature', async () => {
  const {
    AmbiguousTransactionError,
    chainResultsForError,
    sendSignedTransaction,
  } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-signed-pending-'));
  const transaction = {
    signatures: [Uint8Array.from({ length: 64 }, () => 11)],
    message: { accounts: [] },
  };
  const umi = {
    transactions: { serialize: () => Uint8Array.of(10, 20, 30) },
    rpc: {
      sendTransaction: async () => { throw new Error('RPC timeout after send'); },
      getSignatureStatuses: async () => [null],
    },
  };

  let pendingError;
  try {
    await sendSignedTransaction(umi, transaction, {
      directory,
      label: 'pending-step',
      retryDelayMs: 0,
      sendAttempts: 1,
    });
  } catch (error) {
    pendingError = error;
  }
  assert.ok(pendingError instanceof AmbiguousTransactionError);
  assert.equal(pendingError.label, 'pending-step');
  assert.match(pendingError.signature, /^[1-9A-HJ-NP-Za-km-z]+$/);
  const pendingResults = chainResultsForError(pendingError, 'https://rpc.invalid');
  assert.ok(pendingResults.every(({ status }) => status === 'NOT_RUN'));
  assert.ok(pendingResults.every(({ signatures }) => signatures.length === 0));
  assert.ok(pendingResults.every(({ details }) => (
    details.pendingTransaction.signature === pendingError.signature &&
    details.pendingTransaction.label === 'pending-step'
  )));
  assert.ok(chainResultsForError(new Error('confirmed program failure')).every(
    ({ status }) => status === 'FAIL',
  ));
  const files = await readdir(directory);
  assert.equal(files.length, 1);
  assert.deepEqual(await readFile(join(directory, files[0])), Buffer.from([10, 20, 30]));
});

test('second process reloads and reconciles persisted bytes before building a new transaction', async () => {
  const { AmbiguousTransactionError, send, sendSignedTransaction } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-signed-resume-'));
  const transaction = {
    signatures: [Uint8Array.from({ length: 64 }, () => 13)],
    message: { accounts: [] },
  };
  const bytes = Uint8Array.of(40, 50, 60, 70);
  const firstProcess = {
    transactions: { serialize: () => bytes },
    rpc: {
      sendTransaction: async () => { throw new Error('network timeout after send'); },
      getSignatureStatuses: async () => [null],
    },
  };
  await assert.rejects(
    sendSignedTransaction(firstProcess, transaction, {
      directory,
      label: 'resume-step',
      retryDelayMs: 0,
      sendAttempts: 1,
    }),
    AmbiguousTransactionError,
  );

  let builds = 0;
  let sends = 0;
  let statusQueries = 0;
  const recoveredTransaction = { ...transaction, recovered: true };
  const secondProcess = {
    transactions: {
      deserialize: (persisted) => {
        assert.deepEqual(Buffer.from(persisted), Buffer.from(bytes));
        return recoveredTransaction;
      },
      serialize: (value) => {
        assert.equal(value, recoveredTransaction);
        return bytes;
      },
    },
    rpc: {
      getSignatureStatuses: async () => {
        statusQueries += 1;
        return [statusQueries === 1
          ? null
          : { error: null, commitment: 'finalized', confirmations: null }];
      },
      sendTransaction: async (value) => {
        sends += 1;
        assert.equal(value, recoveredTransaction);
        return recoveredTransaction.signatures[0];
      },
    },
  };
  const builder = {
    setLatestBlockhash: async () => {
      builds += 1;
      throw new Error('must not build after restart');
    },
  };

  const signature = await send(secondProcess, builder, {
    directory,
    label: 'resume-step',
    retryDelayMs: 0,
    sendAttempts: 1,
  });
  assert.match(signature, /^[1-9A-HJ-NP-Za-km-z]+$/);
  assert.equal(builds, 0);
  assert.equal(sends, 1);
});

test('simulated burn remint rejection keeps the burn signature as supporting detail only', () => {
  const { attachBurnSupportEvidence } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const rejection = {
    id: 'remintAfterBurnRejected',
    gate: 'CHAIN_AUTHORITY',
    status: 'PASS',
    signatures: [],
    reason: 'Simulation rejected by the expected program.',
    details: { simulation: true },
  };

  attachBurnSupportEvidence(rejection, 'burn-signature', { byteLength: 1 }, 1);
  assert.deepEqual(rejection.signatures, []);
  assert.equal(rejection.details.burnSignature, 'burn-signature');
  assert.equal(rejection.details.mintCounter, 1);
});

test('runChainValidation resumes after burn without replaying invalidated earlier scenarios', async () => {
  const bs58Module = require('bs58');
  const bs58 = bs58Module.default?.encode ? bs58Module.default : bs58Module;
  const {
    CHAIN_CHECKPOINTS,
    runChainValidation,
    saveChainCheckpoint,
  } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const directory = await mkdtemp(join(tmpdir(), 'season-nft-chain-resume-'));
  const fixtures = Object.fromEntries([
    'service', 'allowed-a', 'allowed-b', 'outsider-c', 'collection',
    'alternate-collection', 'candy-machine', 'asset-a', 'asset-b',
  ].map((name) => [name, { publicKey: name }]));
  const signatureA = Uint8Array.from({ length: 64 }, () => 17);
  const firstMintSignature = bs58.encode(signatureA);
  const preexistingIds = [
    'outsiderRejected', 'secondMintRejected', 'nameChangeRejected', 'uriChangeRejected',
    'rootChangeRejected', 'supplyChangeRejected', 'mintAuthorityChangeRejected',
    'noBypassGuardGroup', 'assetMetadataChangeRejected', 'collectionChangeRejected',
    'transferWorks', 'remintAfterTransferRejected', 'remintAfterBurnRejected',
  ];
  const tests = preexistingIds.map((id) => ({
    id,
    gate: 'CHAIN_AUTHORITY',
    status: 'PASS',
    signatures: [],
    reason: null,
  }));
  const firstMintQuote = {
    feeLamports: 100n,
    priorityFeeLamports: 0n,
    payerDebitLamports: 1_500n,
    rentLamports: 800n,
    protocolLamports: 600n,
    totalLamports: 1_500n,
    addresses: ['allowed-a', 'asset-a', 'counter-a', 'protocol'],
    rentByAddress: new Map([['asset-a', 700n], ['counter-a', 100n]]),
  };
  await saveChainCheckpoint(directory, {
    stage: CHAIN_CHECKPOINTS.BURNED,
    tests,
    mintSignatures: [firstMintSignature],
    assetLockObservations: [{
      address: 'asset-a',
      updateAuthority: { type: 'Collection', address: 'collection' },
      delegatePluginsPresent: [],
    }],
    firstMintSignature,
    firstMintQuote,
  });

  let sequence = 18;
  const sent = new Set();
  const builder = (id, payer, owner = payer) => {
    const signature = Uint8Array.from({ length: 64 }, () => sequence++);
    const transaction = {
      id,
      signatures: [signature],
      message: {
        accounts: [payer],
        instructions: [{ accountIndexes: [0, 0, 0, 0, 0, 0, 0] }],
      },
      serializedMessage: Uint8Array.of(1, 2, 3),
    };
    return {
      setLatestBlockhash: async () => ({
        items: [{ instruction: { keys: Array.from({ length: 7 }, (_, index) => ({
          pubkey: index === 6 ? owner : `key-${index}`,
        })) } }],
        buildAndSign: async () => transaction,
      }),
    };
  };
  const keyForSignature = (signature) => Buffer.from(signature).toString('hex');
  const umi = {
    use: () => umi,
    eddsa: { findPda: () => ['lock-authority', 254] },
    transactions: {
      serialize: (transaction) => Buffer.from(JSON.stringify({
        id: transaction.id,
        signature: [...transaction.signatures[0]],
      })),
      deserialize: () => { throw new Error('unexpected deserialize'); },
    },
    rpc: {
      accountExists: async () => true,
      getBalance: async () => ({ basisPoints: 1_000_000_000n }),
      sendTransaction: async (transaction) => {
        sent.add(keyForSignature(transaction.signatures[0]));
        return transaction.signatures[0];
      },
      getSignatureStatuses: async ([signature]) => [sent.has(keyForSignature(signature))
        ? { error: null, commitment: 'finalized', confirmations: null }
        : null],
      getTransaction: async () => ({
        meta: {
          err: null,
          fee: { basisPoints: 100n },
          preBalances: [10_000n, 0n, 0n, 100n].map((basisPoints) => ({ basisPoints })),
          postBalances: [8_500n, 1_000n, 200n, 300n].map((basisPoints) => ({ basisPoints })),
        },
      }),
    },
  };
  const forbidden = () => { throw new Error('an invalidated pre-burn scenario was replayed'); };
  const umiModule = {
    publicKey: (value) => value,
    signerIdentity: () => ({}),
  };
  const core = {
    createCollection: forbidden,
    updateCollectionV1: forbidden,
    fetchCollection: async () => ({
      updateAuthority: 'lock-authority',
      updateDelegate: { authority: { type: 'UpdateAuthority' }, additionalDelegates: ['machine-pda'] },
    }),
    fetchAsset: async (_umi, address) => {
      assert.equal(address, 'asset-b', 'burned asset A must not be fetched during resumed earlier stages');
      return {
        name: 'Cameo Season SDK Validation',
        uri: 'https://example.invalid/cameo-season-sdk-validation.json',
        owner: 'allowed-b',
        updateAuthority: { type: 'Collection', address: 'collection' },
      };
    },
    transferV1: forbidden,
    burnV1: forbidden,
  };
  const candy = {
    getMerkleRoot: () => Uint8Array.of(1),
    getMerkleProof: () => [Uint8Array.of(2)],
    findCandyGuardPda: () => ['candy-guard', 255],
    findCandyMachineAuthorityPda: () => ['machine-pda', 254],
    fetchCandyMachine: async () => ({
      authority: 'lock-authority',
      mintAuthority: 'candy-guard',
      data: {},
    }),
    fetchCandyGuard: async () => ({ authority: 'lock-authority' }),
    create: forbidden,
    route: (_umi, input) => builder('proof-1', input.payer.publicKey),
    mintV1: (_umi, input) => {
      assert.equal(input.asset.publicKey, 'asset-b', 'only the second mint may resume after burn');
      return builder('mint-1', input.payer.publicKey, input.owner);
    },
    setCandyMachineAuthority: forbidden,
    updateCandyGuard: forbidden,
    setCandyGuardAuthority: forbidden,
  };

  const result = await runChainValidation({
    umi,
    modules: {
      '@metaplex-foundation/umi': umiModule,
      '@metaplex-foundation/mpl-core': core,
      '@metaplex-foundation/mpl-core-candy-machine': candy,
    },
    fixtures,
    rpcUrl: 'https://rpc.invalid',
    programAddresses: PROGRAM_ADDRESSES,
    transactionDirectory: directory,
  });

  assert.equal(result.tests.length, 16);
  assert.equal(result.tests.find(({ id }) => id === 'remintAfterBurnRejected').signatures.length, 0);
  assert.equal(result.tests.find(({ id }) => id === 'mintAfterLock').signatures.length, 2);
  assert.deepEqual(result.observedLockState.assets.map(({ address }) => address), ['asset-a', 'asset-b']);
});

test('Turbo response loss retries the same signed bytes and requires the original item ID', async () => {
  const { uploadSignedItemWithRetry } = require('../../scripts/season-nft/sdk-devnet.cjs');
  const expected = Buffer.from('persisted signed data item');
  const received = [];
  let attempts = 0;
  const turbo = {
    uploadSignedDataItem: async (factory) => {
      attempts += 1;
      received.push(await readFileFromFactory(factory));
      if (attempts === 1) throw new Error('network timeout after upload');
      return { id: 'expected-id' };
    },
  };
  const factory = { dataItemStreamFactory: () => Buffer.from(expected) };

  await uploadSignedItemWithRetry(turbo, factory, 'expected-id', 3, 0);
  assert.equal(attempts, 2);
  assert.deepEqual(received, [expected, expected]);
});

async function readFileFromFactory(factory) {
  const value = factory.dataItemStreamFactory();
  if (Buffer.isBuffer(value)) return value;
  const chunks = [];
  for await (const chunk of value) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('read-only retry uses bounded attempts', async () => {
  const { retryRead } = require('../../scripts/season-nft/sdk-devnet.cjs');
  let attempts = 0;
  const result = await retryRead(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('429');
    return 'ok';
  }, 4, 0);

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});
