const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const bs58 = require('bs58').default;
const {
  createNoopSigner,
  lamports,
  none,
  publicKey,
  some,
} = require('@metaplex-foundation/umi');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const core = require('@metaplex-foundation/mpl-core');
const candy = require('@metaplex-foundation/mpl-core-candy-machine');
const {
  getAssetV1AccountDataSerializer,
} = require('@metaplex-foundation/mpl-core/dist/src/generated/types/assetV1AccountData');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const {
  PgTransactionRunner,
} = require('../../dist/database/transaction/pg-transaction.runner');
const {
  ClaimRepository,
} = require('../../dist/modules/season-nfts/resources/claim/claim.repository');
const {
  NftTransactionRepository,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction.repository');
const {
  NftTransactionDispatcher,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher');
const {
  ReconcileNftTransactionsUseCase,
} = require('../../dist/modules/season-nfts/features/reconcile-nft-transactions/reconcile-nft-transactions.use-case');
const {
  SeasonClaimEffectInspector,
  SeasonClaimReceiptLookup,
  selectClaimPriorityFee,
  deriveClaimQuote,
} = require('../../dist/modules/season-nfts/resources/solana-nft/season-claim-chain');
const {
  NftRuntimeQueue,
} = require('../../dist/modules/season-nfts/resources/nft-worker/nft-runtime-queue');
const {
  NftRpcScheduler,
} = require('../../dist/modules/season-nfts/resources/nft-worker/rpc-scheduler');

function address() {
  return bs58.encode(randomBytes(32));
}

function missing(value) {
  return { exists: false, publicKey: publicKey(value) };
}

function account(value, owner, data = new Uint8Array()) {
  return {
    exists: true,
    publicKey: publicKey(value),
    owner: publicKey(owner),
    data,
    executable: false,
    lamports: lamports(0n),
    rentEpoch: 0,
  };
}

const CANDY_GUARD_PROGRAM_ID =
  'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
const CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

function receiptFixture(overrides = {}) {
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const source = {
    claimId: randomUUID(),
    network: 'devnet',
    walletAddress: address(),
    assetName: 'Recovered NFT',
    metadataUri: 'https://example.test/recovered.json',
    collectionAddress: address(),
    candyMachineAddress: address(),
    candyGuardAddress: address(),
    merkleRoot: randomBytes(32),
    knownMintSignature: null,
    receiptHistoryBefore: null,
    ...overrides,
  };
  const assetAddress = address();
  const payer = createNoopSigner(publicKey(source.walletAddress));
  const instruction = candy.mintV1(umi, {
    candyMachine: publicKey(source.candyMachineAddress),
    candyGuard: publicKey(source.candyGuardAddress),
    payer,
    minter: payer,
    owner: payer.publicKey,
    asset: createNoopSigner(publicKey(assetAddress)),
    collection: publicKey(source.collectionAddress),
    mintArgs: {
      allowList: { merkleRoot: source.merkleRoot },
      mintLimit: { id: 0 },
    },
  }).items[0].instruction;
  const accountKeys = instruction.keys.map(({ pubkey }) => String(pubkey));
  accountKeys.push(String(instruction.programId));
  const transaction = {
    error: null,
    blockTime: 1_700_000_000,
    accountKeys,
    instructions: [
      {
        programIdIndex: accountKeys.length - 1,
        accountIndexes: instruction.keys.map((_, index) => index),
        data: instruction.data,
      },
    ],
  };
  const machineData = candy.getCandyMachineAccountDataSerializer().serialize({
    authority: publicKey(address()),
    mintAuthority: publicKey(source.candyGuardAddress),
    collectionMint: publicKey(source.collectionAddress),
    itemsRedeemed: 1n,
    data: {
      itemsAvailable: 2n,
      maxEditionSupply: 0n,
      isMutable: false,
      configLineSettings: none(),
      hiddenSettings: some({
        name: source.assetName,
        uri: source.metadataUri,
        hash: new Uint8Array(32),
      }),
    },
  });
  const transferredAssetData = getAssetV1AccountDataSerializer().serialize({
    key: core.Key.AssetV1,
    owner: publicKey(address()),
    updateAuthority: {
      __kind: 'Collection',
      fields: [publicKey(source.collectionAddress)],
    },
    name: source.assetName,
    uri: source.metadataUri,
    seq: none(),
  });
  return { source, assetAddress, transaction, machineData, transferredAssetData };
}

const immediateScheduler = {
  enqueue: ({ run }) => run(AbortSignal.timeout(1000)),
};
const claimConfig = {
  get: (key) =>
    key === 'seasonNft.network' ? 'devnet' : 'http://127.0.0.1:8899',
};

test('priority selection uses the charged limit, honors cap, and quote does not double count', () => {
  const selected = selectClaimPriorityFee({
    estimatedMicroLamports: 10_000n,
    consumedUnits: 50_000n,
    capLamports: 100n,
  });
  assert.equal(selected.computeUnitLimit, 60_000);
  assert.ok(selected.microLamports > 0n);
  assert.ok(selected.quotedLamports <= 100n);
  const payer = address();
  const created = address();
  const pre = [
    account(payer, address()),
    missing(created),
  ];
  pre[0].lamports = lamports(10_000n);
  const post = [account(payer, address()), account(created, address())];
  post[0].lamports = lamports(3_900n);
  post[1].lamports = lamports(1_000n);
  const quote = deriveClaimQuote({
    feeLamports: 5_000n,
    priorityFeeLamports: 100n,
    payerAddress: payer,
    addresses: [payer, created],
    preAccounts: pre,
    postAccounts: post,
    rentByAddress: new Map([[created, 1_000n]]),
  });
  assert.equal(quote.totalLamports, 6_100n);
  assert.equal(quote.priorityFeeLamports, 100n);
});

test('user effect inspection keeps asset-present and wrong-owner evidence unknown', async () => {
  const guardProgram = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
  const source = {
    transactionId: randomUUID(),
    transactionState: 'PREPARED',
    kind: 'USER_MINT',
    claimId: randomUUID(),
    attemptId: randomUUID(),
    attemptState: 'AWAITING_SIGNATURE',
    walletAddress: address(),
    assetAddress: address(),
    candyMachineAddress: address(),
    candyGuardAddress: address(),
    merkleRoot: new Uint8Array(32),
  };
  let mode = 'asset';
  const inspector = new SeasonClaimEffectInspector(
    { get: () => 'http://127.0.0.1:8899' },
    { findReconciliationSources: async () => [source] },
    {
      getAccounts: async (addresses) => ({
        slot: 1n,
        accounts:
          mode === 'asset'
            ? [missing(addresses[0]), account(addresses[1], address())]
            : [account(addresses[0], address(), Uint8Array.from([0, 0])), missing(addresses[1])],
      }),
    },
  );
  const transaction = {
    id: source.transactionId,
    kind: 'USER_MINT',
    state: 'PREPARED',
    signature: null,
    serializedTransaction: Buffer.from([1]),
    lastValidBlockHeight: 1n,
  };
  let result = await inspector.inspect([transaction], AbortSignal.timeout(1000));
  assert.equal(result[0].accountEvidence, 'UNKNOWN');
  mode = 'owner';
  result = await inspector.inspect([transaction], AbortSignal.timeout(1000));
  assert.equal(result[0].accountEvidence, 'UNKNOWN');
  assert.notEqual(guardProgram, address());
});

test('known receipt signature verifies transfers and burn tombstones without history RPC', async () => {
  for (const burned of [false, true]) {
    const fixture = receiptFixture({ knownMintSignature: `known-${burned}` });
    let historyReads = 0;
    const lookup = new SeasonClaimReceiptLookup(
      claimConfig,
      { findReceiptSource: async () => fixture.source },
      {
        getSignaturesForAddress: async () => {
          historyReads += 1;
          throw new Error('history must not be required');
        },
        getTransaction: async () => fixture.transaction,
        getAccounts: async () => ({
          slot: 10n,
          accounts: [
            account(
              fixture.source.candyMachineAddress,
              candy.MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,
              fixture.machineData,
            ),
            account(
              fixture.assetAddress,
              CORE_PROGRAM_ID,
              burned ? Uint8Array.from([0]) : fixture.transferredAssetData,
            ),
          ],
        }),
      },
    );
    const result = await lookup.resolve(fixture.source.claimId, immediateScheduler);
    assert.equal(result.status, 'VERIFIED');
    assert.equal(result.assetAddress, fixture.assetAddress);
    assert.equal(historyReads, 0);
  }
});

test('receipt lookup keeps meta-null unknown and rejects a wrong mint discriminator', async () => {
  const fixture = receiptFixture();
  for (const mode of ['meta-null', 'wrong-discriminator']) {
    let readbacks = 0;
    const lookup = new SeasonClaimReceiptLookup(
      claimConfig,
      { findReceiptSource: async () => fixture.source },
      {
        getSignaturesForAddress: async () => [
          {
            signature: 'candidate',
            blockTime: 1_700_000_000,
            error: null,
            confirmationStatus: 'finalized',
          },
        ],
        getTransaction: async () =>
          mode === 'meta-null'
            ? null
            : {
                ...fixture.transaction,
                instructions: fixture.transaction.instructions.map((item) => ({
                  ...item,
                  data: Uint8Array.from([
                    item.data[0] ^ 0xff,
                    ...item.data.slice(1),
                  ]),
                })),
              },
        getAccounts: async () => {
          readbacks += 1;
          throw new Error('invalid candidates must not read account state');
        },
      },
    );
    const result = await lookup.resolve(fixture.source.claimId, immediateScheduler);
    assert.equal(result.status, 'PENDING');
    assert.equal(readbacks, 0);
  }
});

test('receipt history returns a durable bounded cursor and resumes past 1000 decoys', async () => {
  const first = receiptFixture();
  let page = 0;
  const decoyLookup = new SeasonClaimReceiptLookup(
    claimConfig,
    { findReceiptSource: async () => first.source },
    {
      getSignaturesForAddress: async (_address, _signal, before) => {
        if (page > 0) assert.equal(before, `decoy-${page - 1}-99`);
        const current = page;
        page += 1;
        return Array.from({ length: 100 }, (_, index) => ({
          signature: `decoy-${current}-${index}`,
          blockTime: 1_700_000_000,
          error: null,
          confirmationStatus: 'finalized',
        }));
      },
      getTransaction: async () => ({
        ...first.transaction,
        instructions: [],
      }),
      getAccounts: async () => {
        throw new Error('decoys must not read account state');
      },
    },
  );
  const pending = await decoyLookup.resolve(first.source.claimId, immediateScheduler);
  assert.deepEqual(pending, {
    status: 'PENDING',
    historyBefore: 'decoy-9-99',
  });
  assert.equal(page, 10);

  const resumed = receiptFixture({
    claimId: first.source.claimId,
    receiptHistoryBefore: pending.historyBefore,
  });
  const observedCursors = [];
  const resumedLookup = new SeasonClaimReceiptLookup(
    claimConfig,
    { findReceiptSource: async () => resumed.source },
    {
      getSignaturesForAddress: async (_address, _signal, before) => {
        observedCursors.push(before);
        if (before === undefined) {
          return Array.from({ length: 100 }, (_, index) => ({
            signature: `newest-decoy-${index}`,
            blockTime: 1_700_000_000,
            error: null,
            confirmationStatus: 'finalized',
          }));
        }
        return [
          {
            signature: 'target',
            blockTime: 1_700_000_000,
            error: null,
            confirmationStatus: 'finalized',
          },
        ];
      },
      getTransaction: async (signature) =>
        signature === 'target'
          ? resumed.transaction
          : { ...resumed.transaction, instructions: [] },
      getAccounts: async () => ({
        slot: 11n,
        accounts: [
          account(
            resumed.source.candyMachineAddress,
            candy.MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,
            resumed.machineData,
          ),
          account(resumed.assetAddress, CORE_PROGRAM_ID, Uint8Array.from([0])),
        ],
      }),
    },
  );
  const verified = await resumedLookup.resolve(
    resumed.source.claimId,
    immediateScheduler,
  );
  assert.deepEqual(observedCursors, [undefined, 'decoy-9-99']);
  assert.equal(verified.status, 'VERIFIED');
});

test('receipt retry probes newly indexed latest history before its durable cursor', async () => {
  const fixture = receiptFixture({ receiptHistoryBefore: 'deep-cursor' });
  const observed = [];
  const lookup = new SeasonClaimReceiptLookup(
    claimConfig,
    { findReceiptSource: async () => fixture.source },
    {
      getSignaturesForAddress: async (_address, _signal, before) => {
        observed.push(before);
        return before === undefined
          ? [
              {
                signature: 'newly-indexed-mint',
                blockTime: 1_700_000_000,
                error: null,
                confirmationStatus: 'finalized',
              },
            ]
          : [];
      },
      getTransaction: async () => fixture.transaction,
      getAccounts: async () => ({
        slot: 12n,
        accounts: [
          account(
            fixture.source.candyMachineAddress,
            candy.MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,
            fixture.machineData,
          ),
          account(fixture.assetAddress, CORE_PROGRAM_ID, Uint8Array.from([0])),
        ],
      }),
    },
  );

  const result = await lookup.resolve(
    fixture.source.claimId,
    immediateScheduler,
  );

  assert.equal(result.status, 'VERIFIED');
  assert.deepEqual(observed, [undefined]);
});

test('direct proof and mint effects survive terminal crash recovery through the real runtime', async () => {
  const { pool } = await testDatabaseModule();
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const nftTransactions = new NftTransactionRepository(pool, runner);
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const walletAddress = address();
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
             CURRENT_TIMESTAMP - interval '2 days',
             CURRENT_TIMESTAMP - interval '1 day')`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, capacity)
     VALUES ($1, $2, 'Recovery', 2)`,
    [seasonId, userId],
  );
  const releaseId = randomUUID();
  const machineAddress = address();
  const guardAddress = address();
  const collectionAddress = address();
  const merkleRoot = randomBytes(32);
  await pool.query(
    `INSERT INTO season_nft_releases
       (id, season_id, network, state, stage, asset_name, metadata_uri,
        collection_address, candy_machine_address, candy_guard_address,
        merkle_root)
     VALUES ($1, $2, 'devnet', 'WAITING_SNAPSHOT', 'SNAPSHOT', 'Recovery NFT',
             'https://example.test/metadata.json', $3, $4, $5, $6)`,
    [
      releaseId,
      seasonId,
      collectionAddress,
      machineAddress,
      guardAddress,
      merkleRoot,
    ],
  );
  const claimId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claims
       (id, release_id, network, user_id, wallet_account_id, wallet_address,
        state, merkle_proof, receipt_state)
     VALUES ($1, $2, 'devnet', $3, $4, $5, 'PROCESSING', '[]', 'NONE')`,
    [claimId, releaseId, userId, walletId, walletAddress],
  );
  const attemptId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
     VALUES ($1, $2, 'AWAITING_SIGNATURE', 'ALLOWLIST_PROOF')`,
    [attemptId, claimId],
  );
  const transactionId = randomUUID();
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, attempt_id, operation_key, kind, state,
        message_hash, serialized_transaction, recent_blockhash,
        last_valid_block_height, estimated_cost_lamports, estimated_at)
     VALUES ($1, 'devnet', $2, $3, $4, 'USER_PROOF', 'PREPARED', $5, $6,
             'blockhash', 10, 1, CURRENT_TIMESTAMP)`,
    [
      transactionId,
      releaseId,
      attemptId,
      `claim:${attemptId}:ALLOWLIST_PROOF`,
      'a'.repeat(64),
      Buffer.from([1]),
    ],
  );
  let effect = 'proof';
  const transport = {
    getAccounts: async (addresses) => ({
      slot: 77n,
      accounts:
        effect === 'proof'
          ? [
              account(
                addresses[0],
                CANDY_GUARD_PROGRAM_ID,
                candy.getAllowListProofAccountDataSerializer().serialize({
                  timestamp: 1n,
                }),
              ),
            ]
          : [
              account(
                addresses[0],
                CANDY_GUARD_PROGRAM_ID,
                candy.getMintCounterAccountDataSerializer().serialize({ count: 1 }),
              ),
              ...addresses.slice(1).map(missing),
            ],
    }),
  };
  const config = {
    get: (key) =>
      key === 'seasonNft.network' ? 'devnet' : 'http://127.0.0.1:8899',
  };
  const inspector = new SeasonClaimEffectInspector(config, claims, transport);
  const dispatcher = new NftTransactionDispatcher(nftTransactions, {
    sendSignedTransaction: async () => '',
    inspectTransactions: async () => {
      throw new Error('opaque inspection bypassed');
    },
    inspectSignatures: async (batch) =>
      batch.map(({ id }) => ({ transactionId: id, signature: 'ABSENT' })),
    inspectAccountEffects: (batch, signal) => inspector.inspect(batch, signal),
    getFinalizedBlockHeight: async () => 9n,
  });
  const scheduler = new NftRpcScheduler(
    { readRps: 50, sendIntervalMs: 1200 },
    { now: () => Date.now(), sleep: async () => {} },
  );
  await dispatcher.check([transactionId], scheduler);
  assert.equal(
    (await nftTransactions.findDispatchable(transactionId)).state,
    'RECONCILED',
  );
  // Crash boundary: the terminal transaction exists before the attempt update.
  await pool.query(
    `UPDATE season_nft_transactions SET state = 'FINALIZED' WHERE id = $1`,
    [transactionId],
  );
  const reconciliation = new ReconcileNftTransactionsUseCase(
    config,
    claims,
    transport,
    runner,
  );
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    { claimDue: async () => [] },
    claims,
    nftTransactions,
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    { check: async () => [], dispatch: async () => {} },
    { next: async () => null },
    { next: async () => null },
    { lookup: async () => ({ status: 'PENDING' }) },
    runner,
    reconciliation,
  );
  await runtime.scan(scheduler);
  let attempt;
  for (let index = 0; index < 20; index += 1) {
    attempt = (
      await pool.query(
        'SELECT state, step FROM season_nft_claim_attempts WHERE id = $1',
        [attemptId],
      )
    ).rows[0];
    if (attempt.step === 'MINT') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(attempt, { state: 'QUEUED', step: 'MINT' });
  assert.deepEqual(
    await claims.findPendingReconciliationTransactionIds('devnet', 20),
    [],
  );

  const mintId = randomUUID();
  const assetAddress = address();
  await pool.query(
    `UPDATE season_nft_claim_attempts
     SET state = 'AWAITING_SIGNATURE', asset_address = $2 WHERE id = $1`,
    [attemptId, assetAddress],
  );
  await pool.query(
    `INSERT INTO season_nft_transactions
       (id, network, release_id, attempt_id, operation_key, kind, state,
        message_hash, serialized_transaction, recent_blockhash,
        last_valid_block_height, asset_address, estimated_cost_lamports,
        estimated_at)
     VALUES ($1, 'devnet', $2, $3, $4, 'USER_MINT', 'PREPARED', $5, $6,
             'blockhash', 10, $7, 1, CURRENT_TIMESTAMP)`,
    [
      mintId,
      releaseId,
      attemptId,
      `claim:${attemptId}:MINT`,
      'b'.repeat(64),
      Buffer.from([2]),
      assetAddress,
    ],
  );
  effect = 'mint';
  await dispatcher.check([mintId], scheduler);
  assert.equal((await nftTransactions.findDispatchable(mintId)).state, 'RECONCILED');
  await runtime.scan(scheduler);
  let claimed;
  for (let index = 0; index < 20; index += 1) {
    claimed = (
      await pool.query(
        `SELECT state, receipt_state, asset_address
         FROM season_nft_claims WHERE id = $1`,
        [claimId],
      )
    ).rows[0];
    if (claimed.state === 'CLAIMED') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(claimed, {
    state: 'CLAIMED',
    receipt_state: 'RESOLVING',
    asset_address: assetAddress,
  });
  await claims.rescheduleReceipt({
    claimId,
    retryDelayMs: 1000,
    historyBefore: 'durable-cursor',
  });
  assert.equal(
    (
      await pool.query(
        'SELECT receipt_history_before FROM season_nft_claims WHERE id = $1',
        [claimId],
      )
    ).rows[0].receipt_history_before,
    'durable-cursor',
  );
  await runner.run((transaction) =>
    claims.completeClaim(
      {
        claimId,
        receiptState: 'VERIFIED',
        assetAddress,
        mintSignature: 'verified-signature',
        claimedAt: new Date(),
      },
      transaction,
    ),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT receipt_history_before FROM season_nft_claims WHERE id = $1',
        [claimId],
      )
    ).rows[0].receipt_history_before,
    null,
  );
  assert.deepEqual(
    await claims.findPendingReconciliationTransactionIds('devnet', 20),
    [],
  );
});
