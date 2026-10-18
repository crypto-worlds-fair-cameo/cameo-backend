const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const core = require('@metaplex-foundation/mpl-core');
const candy = require('@metaplex-foundation/mpl-core-candy-machine');
const umi = require('@metaplex-foundation/umi');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const { PgTransactionRunner } = require('../../dist/database/transaction/pg-transaction.runner');
const { WalletAccountRepository } = require('../../dist/modules/auth/resources/wallet-account/wallet-account.repository');
const { SessionRepository } = require('../../dist/modules/auth/resources/session/session.repository');
const { SessionAuthenticator } = require('../../dist/modules/auth/resources/session/session-authenticator');
const { PrepareSeasonNftUseCase } = require('../../dist/modules/season-nfts/features/prepare-season-nft/prepare-season-nft.use-case');
const { SeasonNftCandidatesQuery } = require('../../dist/modules/season-nfts/features/prepare-season-nft/season-nft-candidates.query');
const { SeasonNftMerkleArtifacts, calculateSeasonNftMerklePass } = require('../../dist/modules/season-nfts/features/prepare-season-nft/season-nft-merkle-artifacts');
const { CreateClaimAttemptUseCase } = require('../../dist/modules/season-nfts/features/create-claim-attempt/create-claim-attempt.use-case');
const { GetClaimAttemptUseCase } = require('../../dist/modules/season-nfts/features/get-claim-attempt/get-claim-attempt.use-case');
const { SubmitClaimTransactionUseCase } = require('../../dist/modules/season-nfts/features/submit-claim-transaction/submit-claim-transaction.use-case');
const { ReconcileNftTransactionsUseCase } = require('../../dist/modules/season-nfts/features/reconcile-nft-transactions/reconcile-nft-transactions.use-case');
const { SeasonNftRepository } = require('../../dist/modules/season-nfts/resources/season-nft/season-nft.repository');
const { ClaimRepository } = require('../../dist/modules/season-nfts/resources/claim/claim.repository');
const { NftTransactionRepository } = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction.repository');
const { SeasonClaimChain, SeasonClaimEffectInspector, SeasonClaimReceiptLookup } = require('../../dist/modules/season-nfts/resources/solana-nft/season-claim-chain');
const { SeasonReleaseChain } = require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain');
const { NftTransactionDispatcher } = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher');
const { NftRuntimeQueue } = require('../../dist/modules/season-nfts/resources/nft-worker/nft-runtime-queue');
const { NftRpcScheduler } = require('../../dist/modules/season-nfts/resources/nft-worker/rpc-scheduler');

const ORIGIN = 'http://localhost:5173';
const GUARD_PROGRAM = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
const CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

function missing(value) {
  return { exists: false, publicKey: umi.publicKey(value) };
}

function account(value, owner, data = new Uint8Array(), balance = 0n) {
  return {
    exists: true,
    publicKey: umi.publicKey(value),
    owner: umi.publicKey(owner),
    data,
    executable: false,
    lamports: umi.lamports(balance),
    rentEpoch: 0,
  };
}

function settings() {
  const values = {
    'seasonNft.enabled': true,
    'seasonNft.network': 'devnet',
    'seasonNft.rpcUrl': 'http://127.0.0.1:8899',
    'seasonNft.priorityFeeMaxLamports': 0n,
    'cors.originList': [ORIGIN],
  };
  return {
    get: (key) => values[key],
    getOrThrow: (key) => values[key],
  };
}

async function waitFor(read, accept) {
  let last;
  for (let index = 0; index < 100; index += 1) {
    const value = await read();
    last = value;
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for the durable NFT state transition: ${JSON.stringify(last)}`);
}

async function actor(pool) {
  const context = createUmi('http://127.0.0.1:8899');
  const signer = umi.generateSigner(context);
  const userId = (await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')).rows[0].id;
  const walletAddress = String(signer.publicKey);
  const walletAccountId = (
    await pool.query(
      `INSERT INTO user_wallets (user_id, chain_namespace, address, address_key)
       VALUES ($1, 'solana', $2, $2) RETURNING id`,
      [userId, walletAddress],
    )
  ).rows[0].id;
  const token = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO auth_sessions (user_id, wallet_account_id, token_hash)
     VALUES ($1, $2, $3)`,
    [userId, walletAccountId, createHash('sha256').update(token).digest('hex')],
  );
  return { userId, walletAccountId, walletAddress, token, signer };
}

function authenticator(pool) {
  return new SessionAuthenticator(
    new WalletAccountRepository(pool),
    new SessionRepository(pool),
  );
}

function rpcScheduler() {
  return new NftRpcScheduler(
    { readRps: 100, sendIntervalMs: 0 },
    { now: () => Date.now(), sleep: async () => {} },
  );
}

async function signPrepared(member, serializedBase64) {
  const context = createUmi('http://127.0.0.1:8899');
  const prepared = context.transactions.deserialize(
    Buffer.from(serializedBase64, 'base64'),
  );
  // Phantom은 budget 명령이 없는 거래를 변경하므로 0 수수료도 서버가 명시해야 한다.
  const budget = prepared.message.instructions.slice(0, 2);
  assert.deepEqual(budget.map((instruction) => String(prepared.message.accounts[instruction.programIndex])), [
    'ComputeBudget111111111111111111111111111111',
    'ComputeBudget111111111111111111111111111111',
  ]);
  assert.equal(Buffer.from(budget[0].data).readUInt32LE(1), 200_000);
  assert.equal(Buffer.from(budget[1].data).readBigUInt64LE(1), 0n);
  const signed = await member.signer.signTransaction(prepared);
  return Buffer.from(context.transactions.serialize(signed)).toString('base64');
}

/** Fakes RPC state only; every claim transition still runs through production providers and repositories. */
class ClaimRpcFixture {
  constructor(pool, members) {
    this.pool = pool;
    this.wallets = new Set(members.map(({ walletAddress }) => walletAddress));
    this.effects = new Map();
    this.finalized = new Set();
    this.sentKinds = [];
    this.receiptTransactions = new Map();
  }

  async getLatestBlockhash() {
    return {
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100n,
    };
  }

  async getFeeForMessage() { return 5_000n; }
  async getPriorityFeeEstimate() { return 0n; }
  async getRent() { return 0n; }

  async getAccounts(addresses) {
    return {
      slot: 77n,
      accounts: addresses.map((value) => {
        const address = String(value);
        if (this.effects.has(address)) return this.effects.get(address);
        if (this.wallets.has(address))
          return account(address, '11111111111111111111111111111111', new Uint8Array(), 10_000_000n);
        return missing(address);
      }),
    };
  }

  async simulateTransaction(_bytes, addresses) {
    return {
      error: null,
      unitsConsumed: 10_000n,
      logs: [],
      accounts: addresses.map((value) => {
        const address = String(value);
        return this.wallets.has(address)
          ? account(address, '11111111111111111111111111111111', new Uint8Array(), 9_995_000n)
          : account(address, '11111111111111111111111111111111', Uint8Array.of(1));
      }),
    };
  }

  async sendSignedTransaction(bytes) {
    const row = (
      await this.pool.query(
        `SELECT t.signature, t.kind, t.asset_address, c.wallet_address,
                r.asset_name, r.metadata_uri, r.collection_address,
                r.candy_machine_address, r.candy_guard_address, r.merkle_root
         FROM season_nft_transactions t
         JOIN season_nft_claim_attempts a ON a.id = t.attempt_id
         JOIN season_nft_claims c ON c.id = a.claim_id
         JOIN season_nft_releases r ON r.id = c.release_id
         WHERE t.state = 'SIGNED' AND t.serialized_transaction = $1`,
        [bytes],
      )
    ).rows[0];
    assert.ok(row);
    const context = createUmi('http://127.0.0.1:8899').use(candy.mplCandyMachine());
    const common = {
      user: umi.publicKey(row.wallet_address),
      candyGuard: umi.publicKey(row.candy_guard_address),
      candyMachine: umi.publicKey(row.candy_machine_address),
    };
    const effect = row.kind === 'USER_PROOF'
      ? String(candy.findAllowListProofPda(context, { ...common, merkleRoot: row.merkle_root })[0])
      : String(candy.findMintCounterPda(context, { ...common, id: 0 })[0]);
    const data = row.kind === 'USER_PROOF'
      ? candy.getAllowListProofAccountDataSerializer().serialize({ timestamp: 1n })
      : candy.getMintCounterAccountDataSerializer().serialize({ count: 1 });
    this.effects.set(effect, account(effect, GUARD_PROGRAM, data));
    if (row.asset_address)
      this.effects.set(row.asset_address, account(row.asset_address, CORE_PROGRAM, Uint8Array.of(0)));
    if (row.kind === 'USER_MINT') {
      const payer = umi.createNoopSigner(umi.publicKey(row.wallet_address));
      const instruction = candy.mintV1(context, {
        candyMachine: umi.publicKey(row.candy_machine_address),
        candyGuard: umi.publicKey(row.candy_guard_address),
        payer,
        minter: payer,
        owner: payer.publicKey,
        asset: umi.createNoopSigner(umi.publicKey(row.asset_address)),
        collection: umi.publicKey(row.collection_address),
        mintArgs: {
          allowList: { merkleRoot: row.merkle_root },
          mintLimit: { id: 0 },
        },
      }).items[0].instruction;
      const accountKeys = instruction.keys.map(({ pubkey }) => String(pubkey));
      accountKeys.push(String(instruction.programId));
      this.receiptTransactions.set(row.signature, {
        error: null,
        blockTime: 1_700_000_000,
        accountKeys,
        instructions: [{
          programIdIndex: accountKeys.length - 1,
          accountIndexes: instruction.keys.map((_, index) => index),
          data: instruction.data,
        }],
      });
      const machineData = candy.getCandyMachineAccountDataSerializer().serialize({
        authority: umi.publicKey('11111111111111111111111111111111'),
        mintAuthority: umi.publicKey(row.candy_guard_address),
        collectionMint: umi.publicKey(row.collection_address),
        itemsRedeemed: 1n,
        data: {
          itemsAvailable: 2n,
          maxEditionSupply: 0n,
          isMutable: false,
          configLineSettings: umi.none(),
          hiddenSettings: umi.some({
            name: row.asset_name,
            uri: row.metadata_uri,
            hash: new Uint8Array(32),
          }),
        },
      });
      this.effects.set(
        row.candy_machine_address,
        account(
          row.candy_machine_address,
          candy.MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID,
          machineData,
        ),
      );
    }
    this.finalized.add(row.signature);
    this.sentKinds.push(row.kind);
    return row.signature;
  }

  async getTransaction(signature) {
    return this.receiptTransactions.get(signature) ?? null;
  }

  async getSignaturesForAddress() {
    return [];
  }
}

function runtimeFixture(pool, rpc) {
  const runner = new PgTransactionRunner(pool);
  const claims = new ClaimRepository(pool, runner);
  const releases = new SeasonNftRepository(pool, runner);
  const nftTransactions = new NftTransactionRepository(pool, runner);
  const effectInspector = new SeasonClaimEffectInspector(settings(), claims, rpc);
  const dispatcher = new NftTransactionDispatcher(nftTransactions, {
    sendSignedTransaction: (bytes) => rpc.sendSignedTransaction(bytes),
    inspectTransactions: async () => assert.fail('opaque inspection bypassed'),
    inspectSignatures: async (batch) => batch.map(({ id, signature }) => ({
      transactionId: id,
      signature: rpc.finalized.has(signature) ? 'FINALIZED' : 'ABSENT',
    })),
    inspectAccountEffects: (batch, signal) => effectInspector.inspect(batch, signal),
    getFinalizedBlockHeight: async () => 1n,
  });
  const reconciliation = new ReconcileNftTransactionsUseCase(
    settings(), claims, rpc, runner,
  );
  const claimBuilder = new SeasonClaimChain(
    settings(), claims, nftTransactions, rpc, runner,
  );
  const receiptLookup = new SeasonClaimReceiptLookup(settings(), claims, rpc);
  const runtime = new NftRuntimeQueue(
    { read: () => ({ enabled: true, network: 'devnet' }) },
    releases,
    claims,
    nftTransactions,
    { execute: async () => {}, prepareMedia: async () => {} },
    { findUnreleased: async () => [] },
    dispatcher,
    { next: async () => null },
    claimBuilder,
    receiptLookup,
    runner,
    reconciliation,
  );
  return { runner, claims, nftTransactions, claimBuilder, runtime };
}

test('normal season end reaches two claims through real use cases, runtime, dispatcher, and restart recovery', async () => {
  const { pool } = await testDatabaseModule();
  const creator = await actor(pool);
  const members = [await actor(pool), await actor(pool)];
  const seasonId = randomUUID();
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at,
        last_chunk_sequence)
     VALUES ($1, 'season', 1000, 1000, 2,
             CURRENT_TIMESTAMP - interval '2 days',
             CURRENT_TIMESTAMP - interval '1 day', 3)`,
    [seasonId],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id, creator_id, title, description, capacity)
     VALUES ($1, $2, 'End to End', 'Two members', 2)`,
    [seasonId, creator.userId],
  );
  for (const member of members) {
    await pool.query(
      `INSERT INTO season_participants
         (season_id, user_id, wallet_account_id, wallet_address)
       VALUES ($1, $2, $3, $4)`,
      [seasonId, member.userId, member.walletAccountId, member.walletAddress],
    );
    await pool.query(
      `INSERT INTO canvas_stroke_usages
         (canvas_id, user_id, client_stroke_id)
       VALUES ($1, $2, $3)`,
      [seasonId, member.userId, randomUUID()],
    );
  }
  const pngBytes = Buffer.from('stage-10-final-snapshot');
  const imageSha256 = createHash('sha256').update(pngBytes).digest('hex');
  const snapshotId = randomUUID();
  await pool.query(
    `INSERT INTO canvas_snapshots
       (id, canvas_id, through_sequence, renderer_version, width, height,
        status, is_final, image_key, continuation_key, image_bytes,
        continuation_bytes, image_sha256, continuation_sha256,
        continuation_schema_version, captured_at)
     VALUES ($1, $2, 3, 'e2e', 1000, 1000, 'READY', true,
             $3, $4, $5, 2, $6, $7, 1, CURRENT_TIMESTAMP)`,
    [
      snapshotId,
      seasonId,
      `snapshots/seasons/${seasonId}/${snapshotId}/image.png`,
      `snapshots/seasons/${seasonId}/${snapshotId}/continuation.json`,
      pngBytes.length,
      imageSha256,
      'c'.repeat(64),
    ],
  );

  const runner = new PgTransactionRunner(pool);
  const releases = new SeasonNftRepository(pool, runner);
  const prepare = new PrepareSeasonNftUseCase(
    settings(),
    runner,
    releases,
    new SeasonNftCandidatesQuery(pool),
    {
      read: async () => ({
        canvasId: seasonId,
        snapshotId,
        throughSequence: 3n,
        pngBytes,
        imageSha256,
        byteLength: BigInt(pngBytes.length),
      }),
    },
    new SeasonNftMerkleArtifacts(calculateSeasonNftMerklePass),
    {
      publish: async ({ kind, sha256 }) => ({
        uri: `https://arweave.net/e2e-${kind.toLowerCase()}`,
        sha256,
        dataItemId: `e2e-${kind.toLowerCase()}`,
      }),
    },
  );
  const frozen = await prepare.execute(seasonId);
  assert.equal(frozen.status, 'FROZEN');
  assert.equal((await prepare.prepareMedia(frozen.releaseId)).status, 'IMAGE');
  assert.equal((await prepare.prepareMedia(frozen.releaseId)).status, 'METADATA');

  // The production release provider validates fake finalized RPC readback before each repository transition.
  const context = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umi.generateSigner(context);
  const collection = umi.generateSigner(context);
  const machine = umi.generateSigner(context);
  const guard = candy.findCandyGuardPda(context, { base: machine.publicKey });
  const lock = context.eddsa.findPda(
    umi.publicKey('11111111111111111111111111111111'),
    [Buffer.from('cameo-nft-lock-v1')],
  )[0];
  const identitySource = await releases.findChainSource(frozen.releaseId);
  await releases.recordPreparationIdentity({
    releaseId: frozen.releaseId,
    expectedVersion: identitySource.version,
    collectionAddress: String(collection.publicKey),
    candyMachineAddress: String(machine.publicKey),
    candyGuardAddress: String(guard[0]),
    preparationKeys: {
      [String(collection.publicKey)]:
        `devnet/${frozen.releaseId}/collection.json`,
      [String(machine.publicKey)]: `devnet/${frozen.releaseId}/machine.json`,
    },
  });
  const releaseProvider = new SeasonReleaseChain(
    settings(), releases, {}, runner, {}, {}, {},
  );
  const guards = Object.fromEntries(
    candy.defaultCandyGuardNames.map((name) => [name, umi.none()]),
  );
  const root = (await releases.findChainSource(frozen.releaseId)).merkleRoot;
  guards.allowList = umi.some({ merkleRoot: root });
  guards.mintLimit = umi.some({ id: 0, limit: 1 });
  const chainAccounts = {
    slot: 20n,
    collection: {
      name: 'Cameo End to End',
      uri: 'https://arweave.net/e2e-metadata',
      updateAuthority: lock,
      updateDelegate: {
        authority: { type: 'UpdateAuthority' },
        additionalDelegates: [candy.findCandyMachineAuthorityPda(context, { candyMachine: machine.publicKey })[0]],
      },
    },
    machine: {
      authority: lock,
      mintAuthority: guard[0],
      collectionMint: collection.publicKey,
      itemsRedeemed: 0n,
      data: {
        itemsAvailable: 2n,
        maxEditionSupply: 0n,
        isMutable: false,
        configLineSettings: umi.none(),
        hiddenSettings: umi.some({
          name: 'Cameo End to End',
          uri: 'https://arweave.net/e2e-metadata',
          hash: new Uint8Array(32),
        }),
      },
    },
    guard: { authority: lock, guards, groups: [] },
  };
  for (const expectedStage of ['METADATA', 'COLLECTION', 'MACHINE']) {
    const source = await releases.findChainSource(frozen.releaseId);
    assert.equal(source.stage, expectedStage);
    await releaseProvider.progress(
      { source, umi: context, service, collection, machine, guard, lock },
      chainAccounts,
      {
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 100n,
        fetchedAt: Date.now(),
      },
    );
  }
  assert.equal((await releases.findChainSource(frozen.releaseId)).state, 'READY');

  const rpc = new ClaimRpcFixture(pool, members);

  for (const member of members) {
    let fixture = runtimeFixture(pool, rpc);
    const create = new CreateClaimAttemptUseCase(
      settings(), authenticator(pool), fixture.claims, fixture.runner,
    );
    const created = await create.execute(ORIGIN, member.token, seasonId);
    assert.equal(created.created, true);
    const attemptId = created.result.attemptId;

    await fixture.claimBuilder.build(attemptId, rpcScheduler());
    let get = new GetClaimAttemptUseCase(
      settings(), authenticator(pool), fixture.claims, fixture.runner,
    );
    const proof = await waitFor(
      () => get.execute(member.token, seasonId, attemptId),
      (value) =>
        value.state === 'AWAITING_SIGNATURE' &&
        value.step === 'ALLOWLIST_PROOF',
    );
    let submit = new SubmitClaimTransactionUseCase(
      settings(), authenticator(pool), fixture.nftTransactions, fixture.runner,
    );
    await submit.execute({
      origin: ORIGIN,
      token: member.token,
      seasonId,
      attemptId,
      transactionId: proof.transaction.transactionId,
      signedTransactionBase64: await signPrepared(
        member,
        proof.transaction.serializedTransactionBase64,
      ),
    });
    await fixture.runtime.scan(rpcScheduler());
    await waitFor(
      () => pool.query(
        'SELECT state FROM season_nft_transactions WHERE id = $1',
        [proof.transaction.transactionId],
      ),
      (value) => value.rows[0].state === 'SUBMITTED',
    );

    // Fresh runtime instances recover the same persisted proof after send and before reconciliation.
    await pool.query(
      `UPDATE season_nft_transactions
       SET next_check_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [proof.transaction.transactionId],
    );
    fixture = runtimeFixture(pool, rpc);
    await fixture.runtime.scan(rpcScheduler());
    await waitFor(
      () => pool.query(
        'SELECT state, step FROM season_nft_claim_attempts WHERE id = $1',
        [attemptId],
      ),
      (value) =>
        value.rows[0].state === 'QUEUED' && value.rows[0].step === 'MINT',
    );

    await fixture.runtime.scan(rpcScheduler());
    get = new GetClaimAttemptUseCase(
      settings(), authenticator(pool), fixture.claims, fixture.runner,
    );
    const mint = await waitFor(
      () => get.execute(member.token, seasonId, attemptId),
      (value) =>
        value.state === 'AWAITING_SIGNATURE' && value.step === 'MINT',
    );
    submit = new SubmitClaimTransactionUseCase(
      settings(), authenticator(pool), fixture.nftTransactions, fixture.runner,
    );
    await submit.execute({
      origin: ORIGIN,
      token: member.token,
      seasonId,
      attemptId,
      transactionId: mint.transaction.transactionId,
      signedTransactionBase64: await signPrepared(
        member,
        mint.transaction.serializedTransactionBase64,
      ),
    });
    await fixture.runtime.scan(rpcScheduler());
    await waitFor(
      () => pool.query(
        'SELECT state FROM season_nft_transactions WHERE id = $1',
        [mint.transaction.transactionId],
      ),
      (value) => value.rows[0].state === 'SUBMITTED',
    );
    await pool.query(
      `UPDATE season_nft_transactions
       SET next_check_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [mint.transaction.transactionId],
    );
    fixture = runtimeFixture(pool, rpc);
    await fixture.runtime.scan(rpcScheduler());
    await waitFor(
      () => pool.query(
        `SELECT state FROM season_nft_claims
         WHERE user_id = $1 AND release_id = $2`,
        [member.userId, frozen.releaseId],
      ),
      (value) => value.rows[0].state === 'CLAIMED',
    );
    await pool.query(
      `UPDATE season_nft_claims SET receipt_next_check_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND release_id = $2`,
      [member.userId, frozen.releaseId],
    );
    fixture = runtimeFixture(pool, rpc);
    await fixture.runtime.scan(rpcScheduler());
    await waitFor(
      () => pool.query(
        `SELECT receipt_state FROM season_nft_claims
         WHERE user_id = $1 AND release_id = $2`,
        [member.userId, frozen.releaseId],
      ),
      (value) => value.rows[0].receipt_state === 'VERIFIED',
    );

    const replay = await create.execute(ORIGIN, member.token, seasonId);
    assert.deepEqual(replay, {
      created: false,
      result: { attemptId: null, state: 'CLAIMED' },
    });
  }

  const final = (
    await pool.query(
      `SELECT
         (SELECT count(*)::int FROM season_nft_claims
          WHERE release_id = $1 AND state = 'CLAIMED'
            AND receipt_state = 'VERIFIED') AS claims,
         (SELECT count(*)::int FROM season_nft_claim_attempts a
          JOIN season_nft_claims c ON c.id = a.claim_id
          WHERE c.release_id = $1) AS attempts,
         (SELECT count(DISTINCT asset_address)::int FROM season_nft_claims
          WHERE release_id = $1) AS assets`,
      [frozen.releaseId],
    )
  ).rows[0];
  assert.deepEqual(final, { claims: 2, attempts: 2, assets: 2 });
  assert.deepEqual(rpc.sentKinds, [
    'USER_PROOF',
    'USER_MINT',
    'USER_PROOF',
    'USER_MINT',
  ]);
  const receiptSignatures = (
    await pool.query(
      `SELECT mint_signature FROM season_nft_claims
       WHERE release_id = $1 ORDER BY wallet_address`,
      [frozen.releaseId],
    )
  ).rows.map(({ mint_signature }) => mint_signature);
  assert.deepEqual(
    receiptSignatures.sort(),
    [...rpc.receiptTransactions.keys()].sort(),
  );
});
