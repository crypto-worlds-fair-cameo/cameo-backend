const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  mkdtemp,
  mkdir,
  readFile,
  stat,
  writeFile,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const {
  PreparationKeyStore,
  PreparationKeyStoreError,
} = require('../../dist/modules/season-nfts/resources/solana-nft/preparation-key-store');
const {
  EXPECTED_GENESIS_HASHES,
  SeasonNftRpcStartupValidator,
  SolanaJsonRpcTransport,
  SeasonReleaseChain,
  buildFinalGuardLock,
  buildCollectionAuthorityLock,
  buildMachineAndGuard,
  canOpenClaims,
  collectionHasOnlyReleasePlugins,
  guardHasOnlyReleaseRules,
  mintDelegatePreserved,
  releaseSupplyMatches,
} = require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain');
const {
  NftOperationPermanentError,
  NftOperationRetryError,
} = require('../../dist/modules/season-nfts/resources/nft-worker/nft-runtime-queue');
const {
  NftRpcScheduler,
} = require('../../dist/modules/season-nfts/resources/nft-worker/rpc-scheduler');
const {
  NftWorker,
} = require('../../dist/modules/season-nfts/resources/nft-worker/nft-worker');
const {
  NftTransactionDispatcher,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher');

const RELEASE_ID = '00000000-0000-4000-8000-000000000061';

function configService(values) {
  return {
    get(name) {
      return values[name];
    },
  };
}

function providerReadbackFixture({ itemsRedeemed = 0n } = {}) {
  const umiModule = require('@metaplex-foundation/umi');
  const candy = require('@metaplex-foundation/mpl-core-candy-machine');
  const core = require('@metaplex-foundation/mpl-core');
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const collection = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const machine = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  const lock = umi.eddsa.findPda(
    umiModule.publicKey('11111111111111111111111111111111'),
    [Buffer.from('cameo-nft-lock-v1')],
  )[0];
  const root = Buffer.alloc(32, 4);
  const source = {
    releaseId: RELEASE_ID,
    network: 'devnet',
    state: 'PREPARING',
    stage: 'MACHINE',
    version: 8n,
    name: 'Season 6',
    metadataUri: 'https://example.invalid/metadata',
    eligibleCount: 2,
    merkleRoot: root,
    collectionAddress: String(collection.publicKey),
    candyMachineAddress: String(machine.publicKey),
    candyGuardAddress: String(guard[0]),
    preparationKeys: {
      [String(collection.publicKey)]: `devnet/${RELEASE_ID}/collection.json`,
      [String(machine.publicKey)]: `devnet/${RELEASE_ID}/machine.json`,
    },
  };
  const guards = Object.fromEntries(
    candy.defaultCandyGuardNames.map((name) => [name, umiModule.none()]),
  );
  guards.allowList = umiModule.some({ merkleRoot: root });
  guards.mintLimit = umiModule.some({ id: 0, limit: 1 });
  const accounts = {
    slot: 20n,
    collection: {
      name: source.name,
      uri: source.metadataUri,
      updateAuthority: lock,
      updateDelegate: { authority: { type: 'UpdateAuthority' }, additionalDelegates: [candy.findCandyMachineAuthorityPda(umi, { candyMachine: machine.publicKey })[0]] },
    },
    machine: {
      authority: lock,
      mintAuthority: guard[0],
      collectionMint: collection.publicKey,
      itemsRedeemed,
      data: {
        itemsAvailable: 2n,
        maxEditionSupply: 0n,
        isMutable: false,
        configLineSettings: umiModule.none(),
        hiddenSettings: umiModule.some({
          name: source.name,
          uri: source.metadataUri,
          hash: new Uint8Array(32),
        }),
      },
    },
    guard: { authority: lock, guards, groups: [] },
  };
  const advances = [];
  let preparedOperations = 0;
  const provider = new SeasonReleaseChain(
    configService({ 'seasonNft.network': 'devnet' }),
    {
      advanceStage: async (input) => {
        advances.push(input);
        return { updated: true };
      },
    },
    {
      findByOperation: async () => {
        preparedOperations += 1;
        return null;
      },
    },
    { run: async (work) => work({}) },
    {},
    {},
    {},
  );
  return {
    accounts,
    advances,
    get preparedOperations() {
      return preparedOperations;
    },
    identity: { source, umi, service, collection, machine, guard, lock },
    provider,
  };
}

test('canOpenClaims rejects every missing finalized readback predicate', () => {
  const verified = {
    finalized: true,
    metadataMatches: true,
    rootMatches: true,
    supplyMatches: true,
    managementLocked: true,
    mintDelegatePreserved: true,
  };
  assert.equal(canOpenClaims(verified), true);
  for (const field of Object.keys(verified)) {
    assert.equal(canOpenClaims({ ...verified, [field]: false }), false, field);
  }
});

test('preparation keys keep one identity across restart and publish private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'season-nft-key-store-'));
  const umi = createUmi('http://127.0.0.1:8899');
  const settings = configService({ 'seasonNft.preparationKeyDir': root });

  const firstStore = new PreparationKeyStore(settings);
  const first = await firstStore.loadOrCreate({
    network: 'devnet',
    releaseId: RELEASE_ID,
    kind: 'collection',
    umi,
  });
  const restartedStore = new PreparationKeyStore(settings);
  const second = await restartedStore.loadOrCreate({
    network: 'devnet',
    releaseId: RELEASE_ID,
    kind: 'collection',
    expectedPublicKey: first.publicKey,
    umi,
  });

  assert.equal(second.publicKey, first.publicKey);
  assert.equal(second.relativePath, `devnet/${RELEASE_ID}/collection.json`);
  const directoryMode =
    (await stat(join(root, 'devnet', RELEASE_ID))).mode & 0o777;
  const fileMode = (await stat(join(root, second.relativePath))).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(fileMode, 0o600);
  const secret = JSON.parse(
    await readFile(join(root, second.relativePath), 'utf8'),
  );
  assert.equal(secret.length, 64);
});

test('preparation key orphan is adopted but mismatch and missing durable evidence block', async () => {
  const root = await mkdtemp(join(tmpdir(), 'season-nft-key-orphan-'));
  const umi = createUmi('http://127.0.0.1:8899');
  const settings = configService({ 'seasonNft.preparationKeyDir': root });
  const store = new PreparationKeyStore(settings);
  const orphan = await store.loadOrCreate({
    network: 'devnet',
    releaseId: RELEASE_ID,
    kind: 'machine',
    umi,
  });

  await assert.rejects(
    store.loadOrCreate({
      network: 'devnet',
      releaseId: RELEASE_ID,
      kind: 'machine',
      expectedPublicKey: '11111111111111111111111111111111',
      umi,
    }),
    (error) =>
      error instanceof PreparationKeyStoreError &&
      error.code === 'NFT_PREPARATION_KEY_MISMATCH',
  );

  await assert.rejects(
    store.loadOrCreate({
      network: 'devnet',
      releaseId: RELEASE_ID,
      kind: 'collection',
      expectedPublicKey: orphan.publicKey,
      umi,
    }),
    (error) =>
      error instanceof PreparationKeyStoreError &&
      error.code === 'NFT_PREPARATION_KEY_MISSING',
  );
});

test('preparation key store rejects corrupt existing final files without replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'season-nft-key-corrupt-'));
  const directory = join(root, 'devnet', RELEASE_ID);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, 'collection.json');
  await writeFile(finalPath, '[1,2,3]\n', { mode: 0o600 });
  const store = new PreparationKeyStore(
    configService({ 'seasonNft.preparationKeyDir': root }),
  );

  await assert.rejects(
    store.loadOrCreate({
      network: 'devnet',
      releaseId: RELEASE_ID,
      kind: 'collection',
      umi: createUmi('http://127.0.0.1:8899'),
    }),
    (error) =>
      error instanceof PreparationKeyStoreError &&
      error.code === 'NFT_PREPARATION_KEY_INVALID',
  );
  assert.equal(await readFile(finalPath, 'utf8'), '[1,2,3]\n');
});

test('startup validator uses the shared scheduler and rejects a replacement endpoint on genesis mismatch', async () => {
  const starts = [];
  const scheduler = new NftRpcScheduler(
    { readRps: 5, sendIntervalMs: 1200 },
    {
      now: () => starts.length * 10,
      sleep: async () => {},
    },
  );
  const matching = new SeasonNftRpcStartupValidator(
    configService({ 'seasonNft.network': 'devnet' }),
    { getGenesisHash: async () => EXPECTED_GENESIS_HASHES.devnet },
  );
  await matching.validate(scheduler);

  const replacement = new SeasonNftRpcStartupValidator(
    configService({ 'seasonNft.network': 'devnet' }),
    { getGenesisHash: async () => EXPECTED_GENESIS_HASHES['mainnet-beta'] },
  );
  await assert.rejects(
    replacement.validate(scheduler),
    /configured network genesis hash/,
  );
});

test('installed SDK keeps machine creation and final Guard lock instruction sets atomic', async () => {
  const umiModule = require('@metaplex-foundation/umi');
  const core = require('@metaplex-foundation/mpl-core');
  const candy = require('@metaplex-foundation/mpl-core-candy-machine');
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const collection = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const machine = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const lock = umi.eddsa.findPda(
    umiModule.publicKey('11111111111111111111111111111111'),
    [Buffer.from('cameo-nft-lock-v1')],
  )[0];
  umi.use(umiModule.signerIdentity(service));
  const root = new Uint8Array(32).fill(7);

  const create = await buildMachineAndGuard({
    umi,
    service,
    collection: collection.publicKey,
    machine,
    name: 'Season 6',
    metadataUri: 'https://example.invalid/metadata',
    eligibleCount: 2,
    merkleRoot: root,
    rentLamports: 123n,
  });
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  const finalLock = buildFinalGuardLock({
    umi,
    authority: service,
    candyGuard: guard,
    lockAuthority: lock,
    merkleRoot: root,
  });

  assert.equal(create.items.length, 4);
  assert.equal(finalLock.items.length, 2);
});

test('mint delegate verification requires Guard mint authority, collection binding, and no unexpected delegates', () => {
  const expected = {
    machineMintAuthority: 'guard',
    candyGuardAddress: 'guard',
    machineCollection: 'collection',
    collectionAddress: 'collection',
    collectionDelegatePlugins: ['updateDelegate'],
    collectionMintDelegateMatches: true,
  };
  assert.equal(mintDelegatePreserved(expected), true);
  for (const changed of [
    { machineMintAuthority: 'other' },
    { machineCollection: 'other' },
    { collectionDelegatePlugins: [] },
    { collectionDelegatePlugins: ['updateDelegate', 'transferDelegate'] },
    { collectionMintDelegateMatches: false },
  ]) {
    assert.equal(mintDelegatePreserved({ ...expected, ...changed }), false);
  }
});

test('readback rejects extra collection plugins, external adapters, and Candy Guard rules', () => {
  const umi = require('@metaplex-foundation/umi');
  const candy = require('@metaplex-foundation/mpl-core-candy-machine');
  const collection = {
    immutableMetadata: { authority: { type: 'UpdateAuthority' } },
  };
  assert.equal(collectionHasOnlyReleasePlugins(collection), true);
  assert.equal(
    collectionHasOnlyReleasePlugins({ ...collection, royalties: {} }),
    false,
  );
  assert.equal(
    collectionHasOnlyReleasePlugins({
      ...collection,
      lifecycleHooks: [{ type: 'LifecycleHook' }],
    }),
    false,
  );

  const guards = Object.fromEntries(
    candy.defaultCandyGuardNames.map((name) => [name, umi.none()]),
  );
  guards.allowList = umi.some({ merkleRoot: new Uint8Array(32) });
  guards.mintLimit = umi.some({ id: 0, limit: 1 });
  guards.startDate = umi.some({ date: 1n });
  assert.equal(guardHasOnlyReleaseRules(guards), true);
  assert.equal(
    guardHasOnlyReleaseRules({
      ...guards,
      solPayment: umi.some({ lamports: 1n }),
    }),
    false,
  );
  assert.equal(
    guardHasOnlyReleaseRules({
      ...guards,
      endDate: umi.some({ date: 2n }),
    }),
    false,
  );
});

// Machine 설치가 추가한 delegate를 collection 단계와 거래 복구 경로 모두에서 인정한다.
test('production advances an initialized collection and reconciles its setup effect', async () => {
  const fixture = providerReadbackFixture();
  fixture.identity.source.stage = 'COLLECTION';
  fixture.accounts.collection.updateAuthority = fixture.identity.service.publicKey;
  fixture.accounts.collection.immutableMetadata = { authority: { type: 'UpdateAuthority' } };
  await fixture.provider.progress(fixture.identity, fixture.accounts, {
    blockhash: 'blockhash', lastValidBlockHeight: 1n, fetchedAt: Date.now(),
  });
  assert.equal(fixture.advances[0].nextStage, 'MACHINE');
  assert.equal(fixture.provider.operationEffect('setup:machine:0', fixture.identity, fixture.accounts), true);
});

test('production finalized readback blocks unexpected plugins and guards before mutation', async () => {
  for (const mutate of [
    (accounts) => { accounts.collection.updateDelegate.additionalDelegates.push('unexpected'); },
    (accounts) => { delete accounts.collection.updateDelegate; },
    (accounts) => {
      accounts.collection.royalties = { basisPoints: 500 };
    },
    (accounts) => {
      accounts.collection.lifecycleHooks = [{ type: 'LifecycleHook' }];
    },
    (accounts) => {
      accounts.guard.guards.solPayment = {
        __option: 'Some',
        value: { lamports: 1n },
      };
    },
  ]) {
    const fixture = providerReadbackFixture();
    mutate(fixture.accounts);
    await assert.rejects(
      fixture.provider.progress(fixture.identity, fixture.accounts, {
        blockhash: 'blockhash',
        lastValidBlockHeight: 1n,
        fetchedAt: Date.now(),
      }),
      (error) => error instanceof NftOperationPermanentError,
    );
    assert.equal(fixture.advances.length, 0);
  }
});

test('production readback rejects incoherent Guard authority and Start Date before mutation', async () => {
  const umi = require('@metaplex-foundation/umi');
  for (const mutate of [
    (fixture) => {
      fixture.accounts.guard.authority = fixture.identity.service.publicKey;
      fixture.accounts.guard.guards.startDate = umi.none();
    },
    (fixture) => {
      fixture.accounts.guard.authority = fixture.identity.lock;
      fixture.accounts.guard.guards.startDate = umi.some({
        date: 9223372036854775807n,
      });
    },
  ]) {
    const fixture = providerReadbackFixture();
    mutate(fixture);
    await assert.rejects(
      fixture.provider.progress(fixture.identity, fixture.accounts, {
        blockhash: 'blockhash',
        lastValidBlockHeight: 1n,
        fetchedAt: Date.now(),
      }),
      (error) =>
        error instanceof NftOperationPermanentError &&
        error.errorCode === 'NFT_MACHINE_CONFIGURATION_INVALID',
    );
    assert.equal(fixture.preparedOperations, 0);
    assert.equal(fixture.advances.length, 0);
  }
});

test('production finalized readback recovers READY after a valid post-lock mint', async () => {
  const fixture = providerReadbackFixture({ itemsRedeemed: 1n });
  assert.equal(
    releaseSupplyMatches({
      eligibleCount: 2,
      itemsAvailable: 2n,
      itemsRedeemed: 1n,
      mintLimitId: 0,
      mintLimit: 1,
      groupCount: 0,
    }),
    true,
  );

  await fixture.provider.progress(fixture.identity, fixture.accounts, {
    blockhash: 'blockhash',
    lastValidBlockHeight: 1n,
    fetchedAt: Date.now(),
  });

  assert.equal(fixture.advances.length, 1);
  assert.equal(fixture.advances[0].nextStage, 'LOCKED');
});

test('persisted preparation addresses require exact durable relative references', async () => {
  const umiModule = require('@metaplex-foundation/umi');
  const core = require('@metaplex-foundation/mpl-core');
  const candy = require('@metaplex-foundation/mpl-core-candy-machine');
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const collection = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const machine = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  const collectionPath = `devnet/${RELEASE_ID}/collection.json`;
  const machinePath = `devnet/${RELEASE_ID}/machine.json`;
  const base = {
    releaseId: RELEASE_ID,
    network: 'devnet',
    state: 'PREPARING',
    stage: 'METADATA',
    version: 5n,
    name: 'Season 6',
    metadataUri: 'https://example.invalid/metadata',
    eligibleCount: 2,
    merkleRoot: Buffer.alloc(32, 4),
    collectionAddress: String(collection.publicKey),
    candyMachineAddress: String(machine.publicKey),
    candyGuardAddress: String(guard[0]),
  };
  for (const preparationKeys of [
    {},
    {
      [String(collection.publicKey)]: 'devnet/wrong/collection.json',
      [String(machine.publicKey)]: machinePath,
    },
    {
      [String(collection.publicKey)]: collectionPath,
      [String(machine.publicKey)]: machinePath,
      extra: 'devnet/extra.json',
    },
  ]) {
    const provider = new SeasonReleaseChain(
      configService({ 'seasonNft.network': 'devnet' }),
      { findChainSource: async () => ({ ...base, preparationKeys }) },
      {},
      {},
      {
        loadOrCreate: async ({ kind }) => {
          const signer = kind === 'collection' ? collection : machine;
          return {
            publicKey: String(signer.publicKey),
            relativePath: kind === 'collection' ? collectionPath : machinePath,
            signer,
          };
        },
      },
      { create: async () => ({ umi, service }) },
      {},
    );
    await assert.rejects(
      provider.next(RELEASE_ID),
      (error) =>
        error instanceof NftOperationPermanentError &&
        error.errorCode === 'NFT_PREPARATION_IDENTITY_MISMATCH',
    );
  }
});

test('HTTP 429 becomes typed runtime retry and parses delta or HTTP-date Retry-After', async () => {
  const now = Date.now();
  for (const [header, minimum] of [
    ['3', 3000],
    [new Date(now + 4000).toUTCString(), 2500],
  ]) {
    const transport = new SolanaJsonRpcTransport(
      configService({ 'seasonNft.rpcUrl': 'https://rpc.invalid' }),
      async () =>
        new Response('', { status: 429, headers: { 'retry-after': header } }),
    );
    await assert.rejects(
      transport.getGenesisHash(AbortSignal.timeout(1000)),
      (error) =>
        error instanceof NftOperationRetryError &&
        error.retry.reason === 'RATE_LIMITED' &&
        error.retry.retryAfterMs >= minimum,
    );
  }
});

test('enabled worker validates RPC identity before opening the PostgreSQL leader session', async () => {
  let connects = 0;
  const runtime = {
    enabled: true,
    network: 'devnet',
    advisoryNetworkKey: 1,
    rpcReadRps: 5,
    rpcSendIntervalMs: 1200,
    rpcTimeoutMs: 10_000,
    jobScanIntervalMs: 1000,
    seasonScanIntervalMs: 60_000,
    uploadTimeoutMs: 120_000,
    gatewayTimeoutMs: 30_000,
    shutdownTimeoutMs: 15_000,
  };
  const worker = new NftWorker(
    { read: () => runtime },
    {
      connect: async () => {
        connects += 1;
        throw new Error('must not connect');
      },
    },
    { scan: async () => {} },
    {
      validate: async () => {
        throw new Error('wrong genesis');
      },
    },
  );

  await assert.rejects(worker.onApplicationBootstrap(), /wrong genesis/);
  assert.equal(connects, 0);
});

test('production inspection seam budgets status, account effect, and height as three scheduler requests', async () => {
  const outcomes = [];
  const transaction = {
    id: 'tx',
    state: 'SIGNED',
    signature: 'signature',
    serializedTransaction: Buffer.from([1]),
    lastValidBlockHeight: 10n,
  };
  const chain = {
    sendSignedTransaction: async () => 'signature',
    inspectTransactions: async () => {
      throw new Error('opaque inspection bypassed');
    },
    inspectSignatures: async () => [
      { transactionId: 'tx', signature: 'ABSENT' },
    ],
    inspectAccountEffects: async () => [
      { transactionId: 'tx', accountEvidence: 'ABSENT' },
    ],
    getFinalizedBlockHeight: async () => 9n,
  };
  const dispatcher = new NftTransactionDispatcher(
    {
      findDispatchable: async () => transaction,
      recordDispatchOutcome: async (outcome) => outcomes.push(outcome),
    },
    chain,
  );
  const jobs = [];
  const decisions = await dispatcher.check(['tx'], {
    enqueue: async (job) => {
      jobs.push({ kind: job.kind, rpcType: job.rpcType });
      return job.run(AbortSignal.timeout(1000));
    },
  });

  assert.deepEqual(jobs, [
    { kind: 'USER_CHECK', rpcType: 'READ' },
    { kind: 'USER_CHECK', rpcType: 'READ' },
    { kind: 'USER_CHECK', rpcType: 'READ' },
  ]);
  assert.deepEqual(decisions, [{ transactionId: 'tx', resendSigned: true }]);
  assert.equal(outcomes.at(-1).state, 'SIGNED');
});

test('production inspection splits setup effects before the 100-account RPC limit', async () => {
  const transactions = Array.from({ length: 60 }, (_, index) => ({
    id: `tx-${index}`,
    releaseId: `release-${index}`,
    operationKey: 'setup:collection:0',
    state: 'SIGNED',
    signature: `signature-${index}`,
    serializedTransaction: Buffer.from([index]),
    lastValidBlockHeight: 10n,
  }));
  const jobs = [];
  const effectBatchSizes = [];
  const dispatcher = new NftTransactionDispatcher(
    {
      findDispatchable: async (id) =>
        transactions.find((transaction) => transaction.id === id),
      recordDispatchOutcome: async () => {},
    },
    {
      sendSignedTransaction: async () => '',
      inspectTransactions: async () => {
        throw new Error('opaque inspection bypassed');
      },
      inspectSignatures: async (batch) =>
        batch.map(({ id }) => ({ transactionId: id, signature: 'ABSENT' })),
      inspectAccountEffects: async (batch) => {
        effectBatchSizes.push(batch.length);
        return batch.map(({ id }) => ({
          transactionId: id,
          accountEvidence: 'SUCCESS',
          reconciliationEvidence: { operationKey: 'setup:collection:0' },
        }));
      },
      getFinalizedBlockHeight: async () => 9n,
    },
  );

  await dispatcher.check(
    transactions.map(({ id }) => id),
    {
      enqueue: async (job) => {
        jobs.push(job.rpcType);
        return job.run(AbortSignal.timeout(1000));
      },
    },
  );

  assert.deepEqual(effectBatchSizes, [33, 27]);
  assert.deepEqual(jobs, ['READ', 'READ', 'READ']);
});

test('production inspection schedules mixed setup and user effects as separate RPC requests', async () => {
  const transactions = [
    {
      id: 'setup',
      kind: 'SETUP_COLLECTION',
      state: 'SIGNED',
      signature: 'setup-signature',
      serializedTransaction: Buffer.from([1]),
      lastValidBlockHeight: 10n,
    },
    {
      id: 'user',
      kind: 'USER_MINT',
      state: 'SIGNED',
      signature: 'user-signature',
      serializedTransaction: Buffer.from([2]),
      lastValidBlockHeight: 10n,
    },
  ];
  const effectFamilies = [];
  const dispatcher = new NftTransactionDispatcher(
    {
      findDispatchable: async (id) =>
        transactions.find((transaction) => transaction.id === id),
      recordDispatchOutcome: async () => {},
    },
    {
      sendSignedTransaction: async () => '',
      inspectTransactions: async () => {
        throw new Error('opaque inspection bypassed');
      },
      inspectSignatures: async (batch) =>
        batch.map(({ id }) => ({ transactionId: id, signature: 'ABSENT' })),
      inspectAccountEffects: async (batch) => {
        const families = new Set(
          batch.map(({ kind }) => (kind.startsWith('SETUP_') ? 'SETUP' : 'USER')),
        );
        assert.equal(families.size, 1);
        effectFamilies.push([...families][0]);
        return batch.map(({ id }) => ({
          transactionId: id,
          accountEvidence: 'SUCCESS',
          reconciliationEvidence: { operationKey: id },
        }));
      },
      getFinalizedBlockHeight: async () => 9n,
    },
  );
  const jobs = [];
  await dispatcher.check(['setup', 'user'], {
    enqueue: async (job) => {
      jobs.push(job.rpcType);
      return job.run(AbortSignal.timeout(1000));
    },
  });
  assert.deepEqual(effectFamilies, ['SETUP', 'USER']);
  assert.deepEqual(jobs, ['READ', 'READ', 'READ']);
});

test('release provider persists identity, PREPARED bytes, then SIGNED evidence without sending', async () => {
  const umiModule = require('@metaplex-foundation/umi');
  const core = require('@metaplex-foundation/mpl-core');
  const candy = require('@metaplex-foundation/mpl-core-candy-machine');
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const collection = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  const machine = umiModule.createSignerFromKeypair(
    umi,
    umi.eddsa.generateKeypair(),
  );
  umi.use(umiModule.signerIdentity(service));
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  let source = {
    releaseId: RELEASE_ID,
    network: 'devnet',
    state: 'PREPARING',
    stage: 'METADATA',
    version: 4n,
    name: 'Season 6',
    metadataUri: 'https://example.invalid/metadata',
    eligibleCount: 2,
    merkleRoot: Buffer.alloc(32, 4),
    collectionAddress: null,
    candyMachineAddress: null,
    candyGuardAddress: null,
    preparationKeys: {},
  };
  const events = [];
  let preparedRow = null;
  const releases = {
    findChainSource: async () => source,
    recordPreparationIdentity: async (input) => {
      events.push('IDENTITY');
      source = {
        ...source,
        version: 5n,
        collectionAddress: input.collectionAddress,
        candyMachineAddress: input.candyMachineAddress,
        candyGuardAddress: input.candyGuardAddress,
        preparationKeys: input.preparationKeys,
      };
      return { updated: true, conflict: false };
    },
    advanceStage: async () => ({ updated: true }),
  };
  const nftTransactions = {
    findByOperation: async () => null,
    insertPrepared: async (input) => {
      events.push('PREPARED');
      preparedRow = {
        id: 'transaction',
        state: 'PREPARED',
        signature: null,
        serializedTransaction: input.serializedTransaction,
        lastValidBlockHeight: input.lastValidBlockHeight,
      };
      return { created: true, transactionId: 'transaction', state: 'PREPARED' };
    },
    findDispatchable: async () => preparedRow,
    acceptSigned: async (input) => {
      assert.ok(input.signedBytes.length > 0);
      assert.ok(input.signature.length > 0);
      events.push('SIGNED');
      return {
        accepted: true,
        currentTransactionState: 'SIGNED',
        signature: input.signature,
      };
    },
  };
  let sends = 0;
  const transport = {
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 50n,
    }),
    getAccounts: async (addresses) => ({
      slot: 10n,
      accounts: addresses.map((address) => ({
        exists: false,
        publicKey: umiModule.publicKey(address),
      })),
    }),
    sendTransaction: async () => {
      sends += 1;
      throw new Error('must not send');
    },
  };
  const provider = new SeasonReleaseChain(
    configService({ 'seasonNft.network': 'devnet' }),
    releases,
    nftTransactions,
    { run: async (work) => work({}) },
    {
      loadOrCreate: async ({ kind }) => {
        const signer = kind === 'collection' ? collection : machine;
        return {
          publicKey: String(signer.publicKey),
          relativePath: `devnet/${RELEASE_ID}/${kind}.json`,
          signer,
        };
      },
    },
    { create: async () => ({ umi, service }) },
    transport,
  );

  await (await provider.next(RELEASE_ID)).run(AbortSignal.timeout(1000));
  await (await provider.next(RELEASE_ID)).run(AbortSignal.timeout(1000));

  assert.equal(source.candyGuardAddress, String(guard[0]));
  assert.deepEqual(events, ['IDENTITY', 'PREPARED', 'SIGNED']);
  assert.equal(sends, 0);
});

// Candy Machine 생성 직후 Devnet에서 관측한 필수 collection delegate를 재현한다.
test('collection permits only the exact Candy Machine PDA delegate after initialization', () => {
  const delegate = 'GkemBEshtLVzHVMtrPJDUk2V6RXfNsTyi1wJu41SYkvx';
  const collection = {
    immutableMetadata: { authority: { type: 'UpdateAuthority' } },
    updateDelegate: { authority: { type: 'UpdateAuthority' }, additionalDelegates: [delegate] },
  };
  assert.equal(collectionHasOnlyReleasePlugins(collection, delegate), true);
  assert.equal(collectionHasOnlyReleasePlugins(collection), false);
  for (const plugin of [
    undefined,
    { authority: { type: 'UpdateAuthority' }, additionalDelegates: [] },
    { authority: { type: 'UpdateAuthority' }, additionalDelegates: ['unexpected'] },
    { authority: { type: 'UpdateAuthority' }, additionalDelegates: [delegate, 'unexpected'] },
    { authority: { type: 'Address', address: delegate }, additionalDelegates: [delegate] },
  ]) assert.equal(collectionHasOnlyReleasePlugins({ ...collection, updateDelegate: plugin }, delegate), false);
  assert.equal(collectionHasOnlyReleasePlugins({ ...collection, royalties: {} }, delegate), false);
});

// ImmutableMetadata는 authority 변경도 거절하므로 제거와 잠금은 반드시 한 거래다.
test('collection lock atomically removes the temporary plugin before authority transfer', () => {
  const fixture = providerReadbackFixture();
  const { umi, service, collection, lock } = fixture.identity;
  const builder = buildCollectionAuthorityLock({ umi, authority: service, collection: collection.publicKey, lockAuthority: lock });
  assert.equal(builder.items.length, 2);
  const core = require('@metaplex-foundation/mpl-core');
  const remove = core.getRemoveCollectionPluginV1InstructionDataSerializer().deserialize(builder.items[0].instruction.data)[0];
  assert.equal(remove.pluginType, core.PluginType.ImmutableMetadata);
  const update = core.getUpdateCollectionV1InstructionDataSerializer().deserialize(builder.items[1].instruction.data)[0];
  assert.equal(builder.items[1].instruction.keys[3].pubkey, lock);
  assert.equal(update.newName.__option, 'None');
  assert.equal(update.newUri.__option, 'None');
});
