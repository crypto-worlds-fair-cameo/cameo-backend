const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { test } = require('node:test');
const core = require('@metaplex-foundation/mpl-core');
const candy = require('@metaplex-foundation/mpl-core-candy-machine');
const umiModule = require('@metaplex-foundation/umi');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');

const {
  deriveAssetSigner,
} = require('../../dist/modules/season-nfts/resources/solana-nft/asset-signer');
const {
  NftServerCosigner,
} = require('../../dist/modules/season-nfts/resources/solana-nft/server-cosigner');
const {
  SeasonReleaseChain,
  buildReleaseLock,
} = require('../../dist/modules/season-nfts/resources/solana-nft/season-release-chain');
const {
  validateWalletSignedTransaction,
} = require('../../dist/modules/season-nfts/resources/solana-nft/signed-transaction-validator');

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const BLOCKHASH = '11111111111111111111111111111111';

function prepared(umi, transaction) {
  return {
    bytes: Buffer.from(umi.transactions.serialize(transaction)),
    messageHash: createHash('sha256')
      .update(transaction.serializedMessage)
      .digest('hex'),
  };
}

/** 개설자가 비용을 내는 발행 하나와, 그 발행의 서버 열쇠를 가진 서명 도우미. */
function fixture() {
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const service = umiModule.generateSigner(umi);
  umi.use(umiModule.signerIdentity(service));
  const wallet = umiModule.generateSigner(umi);
  const collection = umiModule.generateSigner(umi);
  const machine = umiModule.generateSigner(umi);
  const guard = candy.findCandyGuardPda(umi, { base: machine.publicKey });
  const lock = umi.eddsa.findPda(umiModule.publicKey(SYSTEM_PROGRAM), [
    Buffer.from('cameo-nft-lock-v1'),
  ])[0];
  const releaseId = randomUUID();
  const loads = { service: 0, keys: [] };
  const cosigner = new NftServerCosigner(
    {
      create: async () => {
        loads.service += 1;
        return { umi, service };
      },
    },
    {
      loadOrCreate: async (input) => {
        loads.keys.push(input.kind);
        const signer = input.kind === 'collection' ? collection : machine;
        // 발행에 기록된 주소의 열쇠만 꺼낸다.
        assert.equal(input.expectedPublicKey, String(signer.publicKey));
        assert.equal(input.releaseId, releaseId);
        return { publicKey: String(signer.publicKey), signer };
      },
    },
  );
  const source = (stage) => ({
    releaseId,
    network: 'devnet',
    state: 'PREPARING',
    stage,
    version: 1n,
    name: 'Cameo Cosign',
    metadataUri: 'https://arweave.net/cosign-metadata',
    eligibleCount: 1,
    supply: 2n,
    creatorWalletAddress: String(wallet.publicKey),
    creatorMintedCount: 0n,
    claimGroup: 'claim',
    merkleRoot: Buffer.alloc(32, 7),
    collectionAddress: String(collection.publicKey),
    candyMachineAddress: String(machine.publicKey),
    candyGuardAddress: String(guard[0]),
    preparationKeys: {},
  });
  /** 지갑이 서명한 제출본을 서버가 완성하게 한다. shown은 지갑이 고쳐서 서명한 거래다. */
  const submit = async (
    stored,
    operationKey,
    shown = umi.transactions.deserialize(stored.bytes),
  ) => {
    const walletSigned = validateWalletSignedTransaction({
      preparedBytes: stored.bytes,
      submittedBase64: Buffer.from(
        umi.transactions.serialize(await wallet.signTransaction(shown)),
      ).toString('base64'),
      expectedPayer: String(wallet.publicKey),
      expectedMessageHash: stored.messageHash,
    });
    const completed = await cosigner.complete({
      network: 'devnet',
      releaseId,
      operationKey,
      collectionAddress: String(collection.publicKey),
      candyMachineAddress: String(machine.publicKey),
      validated: walletSigned,
    });
    return { walletSigned, completed };
  };
  return {
    umi,
    service,
    wallet,
    collection,
    machine,
    guard,
    lock,
    releaseId,
    loads,
    cosigner,
    source,
    submit,
  };
}

function signerNames(context, transaction) {
  const names = new Map([
    [String(context.wallet.publicKey), 'wallet'],
    [String(context.service.publicKey), 'service'],
    [String(context.collection.publicKey), 'collection'],
    [String(context.machine.publicKey), 'machine'],
  ]);
  return transaction.message.accounts
    .slice(0, transaction.message.header.numRequiredSignatures)
    .map((account) => names.get(String(account)) ?? 'asset');
}

function assertFullySigned(umi, bytes) {
  const transaction = umi.transactions.deserialize(bytes);
  assert.equal(
    transaction.signatures.length,
    transaction.message.header.numRequiredSignatures,
  );
  transaction.signatures.forEach((signature, index) => {
    assert.equal(
      umi.eddsa.verify(
        transaction.serializedMessage,
        signature,
        transaction.message.accounts[index],
      ),
      true,
      `signature ${index}`,
    );
  });
  return transaction;
}

/** 준비 단계 하나를 돌려, 지갑에 보여 주려고 저장하는 준비 거래를 모은다. */
async function prepareStage(context, stage) {
  const stored = [];
  const chain = new SeasonReleaseChain(
    {},
    {},
    {
      findByOperation: async () => null,
      listInFlightCreatorMints: async () => [],
      insertPrepared: async (input) => {
        stored.push(input);
        return { transactionId: `prepared-${stored.length}` };
      },
      findDispatchable: async (id) => ({ id, state: 'PREPARED' }),
    },
    { run: async (work) => work({}) },
    {},
    {},
    {},
  );
  await chain.progress(
    {
      source: context.source(stage),
      umi: context.umi,
      service: context.service,
      collection: context.collection,
      machine: context.machine,
      guard: context.guard,
      lock: context.lock,
    },
    { slot: 1n, collection: null, machine: null, guard: null },
    {
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 100n,
      fetchedAt: Date.now(),
      rentLamports: 1_000_000n,
    },
  );
  return stored;
}

test('creator-paid setup transactions reach the wallet unsigned and the server signs after the wallet', async () => {
  const context = fixture();
  const stages = [
    ['METADATA', 'SETUP_COLLECTION', ['wallet', 'collection']],
    ['COLLECTION', 'SETUP_MACHINE', ['wallet', 'machine', 'service']],
    ['MACHINE', 'SETUP_CREATOR_MINT', ['wallet', 'asset']],
  ];
  const assets = new Set();
  for (const [stage, kind, signers] of stages) {
    const stored = await prepareStage(context, stage);
    // 개설자 몫 2개는 확인 한 번에 서명하도록 함께 준비된다.
    assert.equal(stored.length, kind === 'SETUP_CREATOR_MINT' ? 2 : 1, stage);
    for (const row of stored) {
      assert.equal(row.kind, kind);
      const shown = context.umi.transactions.deserialize(
        row.serializedTransaction,
      );
      // 서버가 먼저 서명해 두면 Phantom이 위험한 요청으로 막는다.
      assert.equal(
        shown.signatures.every((signature) =>
          signature.every((byte) => byte === 0),
        ),
        true,
        `${kind} is stored with a signature`,
      );
      assert.equal(signerNames(context, shown)[0], 'wallet');
      assert.deepEqual(signerNames(context, shown).sort(), [...signers].sort());

      const { walletSigned, completed } = await context.submit(
        { bytes: row.serializedTransaction, messageHash: row.messageHash },
        row.operationKey,
      );
      assert.equal(walletSigned.missingSigners.length, signers.length - 1);
      assertFullySigned(context.umi, completed.signedBytes);
      assert.equal(completed.messageHash, row.messageHash);
      if (kind === 'SETUP_CREATOR_MINT') {
        // 저장한 NFT 주소의 열쇠를 접수할 때 다시 만들어 서명한다.
        assert.deepEqual(walletSigned.missingSigners, [row.assetAddress]);
        assets.add(row.assetAddress);
      }
    }
  }
  assert.equal(assets.size, 2);
  assert.deepEqual(context.loads.keys.sort(), ['collection', 'machine']);
});

test('the server signs the lock after the wallet adds its safety checks', async () => {
  const context = fixture();
  const { umi, wallet, service } = context;
  const payer = umiModule.createNoopSigner(wallet.publicKey);
  // Phantom은 mainnet에서 거래가 바꾸는 계정과 지갑을 확인하는 instruction을 덧붙인다.
  const check = (account) => ({
    instruction: {
      programId: umiModule.publicKey(LIGHTHOUSE_PROGRAM),
      keys: [{ pubkey: account, isSigner: false, isWritable: false }],
      data: Uint8Array.from([6, 4, 0]),
    },
    signers: [],
    bytesCreatedOnChain: 0,
  });
  const build = (extra = []) =>
    buildReleaseLock({
      umi,
      authority: service,
      payer,
      collection: context.collection.publicKey,
      candyMachine: context.machine.publicKey,
      candyGuard: context.guard,
      lockAuthority: context.lock,
      creator: {
        wallet: wallet.publicKey,
        allocation: 2,
        merkleRoot: Buffer.alloc(32, 7),
      },
      merkleRoot: Buffer.alloc(32, 7),
    })
      .add(extra)
      .setFeePayer(payer)
      .setVersion('legacy')
      .setBlockhash(BLOCKHASH)
      .build(umi);
  const stored = prepared(umi, build());
  assert.deepEqual(
    signerNames(context, umi.transactions.deserialize(stored.bytes)),
    ['wallet', 'service'],
  );

  const { walletSigned, completed } = await context.submit(
    stored,
    'setup:lock:0',
    build([check(context.collection.publicKey), check(wallet.publicKey)]),
  );
  assert.equal(walletSigned.walletGuardCount, 2);
  assert.deepEqual(walletSigned.missingSigners, [String(service.publicKey)]);
  assertFullySigned(umi, completed.signedBytes);
  assert.notEqual(completed.messageHash, stored.messageHash);
  // 잠금 거래는 서비스 열쇠만 필요하므로 컬렉션·발행 장치 열쇠 파일은 읽지 않는다.
  assert.deepEqual(context.loads.keys, []);
});

/** 지갑과 other가 함께 서명하는 SOL 전송 거래. */
function transfer(umi, wallet, other, otherSigns) {
  return umiModule
    .transactionBuilder()
    .add({
      instruction: {
        programId: umiModule.publicKey(SYSTEM_PROGRAM),
        keys: [
          { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
          { pubkey: other, isSigner: otherSigns, isWritable: true },
        ],
        data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      },
      signers: [],
      bytesCreatedOnChain: 0,
    })
    .setFeePayer(umiModule.createNoopSigner(wallet.publicKey))
    .setVersion('legacy')
    .setBlockhash(BLOCKHASH)
    .build(umi);
}

test('a transaction only the wallet signs never reads a server key', async () => {
  const umi = createUmi('http://127.0.0.1:8899');
  const wallet = umiModule.generateSigner(umi);
  const unsigned = transfer(
    umi,
    wallet,
    umiModule.generateSigner(umi).publicKey,
    false,
  );
  const stored = prepared(umi, unsigned);
  const cosigner = new NftServerCosigner(
    { create: async () => assert.fail('the service key was read') },
    { loadOrCreate: async () => assert.fail('a preparation key was read') },
  );
  const completed = await cosigner.complete({
    network: 'devnet',
    releaseId: randomUUID(),
    operationKey: 'setup:storage-fund:0',
    collectionAddress: null,
    candyMachineAddress: null,
    validated: validateWalletSignedTransaction({
      preparedBytes: stored.bytes,
      submittedBase64: Buffer.from(
        umi.transactions.serialize(await wallet.signTransaction(unsigned)),
      ).toString('base64'),
      expectedPayer: String(wallet.publicKey),
      expectedMessageHash: stored.messageHash,
    }),
  });
  assertFullySigned(umi, completed.signedBytes);
});

test('the server does not sign for an address it holds no key for', async () => {
  const context = fixture();
  const stranger = umiModule.generateSigner(context.umi);
  const unsigned = transfer(
    context.umi,
    context.wallet,
    stranger.publicKey,
    true,
  );
  await assert.rejects(
    context.submit(prepared(context.umi, unsigned), 'setup:collection:0'),
    /required signature is missing or invalid/u,
  );
});

test('the NFT address key is rebuilt only for the same prepared transaction', async () => {
  const context = fixture();
  const scope = {
    network: 'devnet',
    releaseId: context.releaseId,
    operationKey: 'setup:creator-mint:0',
    blockhash: BLOCKHASH,
  };
  const address = (override = {}, service = context.service) =>
    String(
      deriveAssetSigner(context.umi, service, { ...scope, ...override })
        .publicKey,
    );
  assert.equal(address(), address());
  assert.equal(
    String((await context.cosigner.assetSigner(scope)).publicKey),
    address(),
  );
  const others = [
    address({ operationKey: 'setup:creator-mint:1' }),
    address({ blockhash: '11111111111111111111111111111112' }),
    address({ releaseId: randomUUID() }),
    address({ network: 'mainnet-beta' }),
    address({}, umiModule.generateSigner(context.umi)),
  ];
  assert.equal(new Set([address(), ...others]).size, others.length + 1);
});
