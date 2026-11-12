const { createHash, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const core = require('@metaplex-foundation/mpl-core');
const candy = require('@metaplex-foundation/mpl-core-candy-machine');
const umiModule = require('@metaplex-foundation/umi');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');

const {
  validateSignedClaimTransaction,
} = require('../../dist/modules/season-nfts/resources/solana-nft/signed-transaction-validator');

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const BLOCKHASH = '11111111111111111111111111111111';

function item(programId, keys, data, signers = []) {
  return {
    instruction: {
      programId: umiModule.publicKey(programId),
      keys,
      data: Uint8Array.from(data),
    },
    signers,
    bytesCreatedOnChain: 0,
  };
}

/** mainnet 지갑이 서명 전에 덧붙이는 안전 확인 instruction. */
function walletGuard(account) {
  return item(
    LIGHTHOUSE_PROGRAM,
    [{ pubkey: account, isSigner: false, isWritable: false }],
    [4, 1, 2, 3],
  );
}

async function signedMintFixture() {
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const participant = umiModule.generateSigner(umi);
  const asset = umiModule.generateSigner(umi);
  const machine = umiModule.generateSigner(umi).publicKey;
  const guard = umiModule.generateSigner(umi).publicKey;
  const collection = umiModule.generateSigner(umi).publicKey;
  const root = candy.getMerkleRoot([participant.publicKey]);
  umi.use(umiModule.signerIdentity(participant));
  const mint = () =>
    candy.mintV1(umi, {
      candyMachine: machine,
      candyGuard: guard,
      payer: participant,
      minter: participant,
      owner: participant.publicKey,
      asset,
      collection,
      mintArgs: { allowList: { merkleRoot: root }, mintLimit: { id: 0 } },
    });
  const signed = await mint()
    .setVersion('legacy')
    .setBlockhash(BLOCKHASH)
    .buildAndSign(umi);
  // 참가자와 asset이 모두 다시 서명해 서명 자체는 유효한, 안전 확인이 덧붙은 거래.
  const guarded = await mint()
    .add(walletGuard(participant.publicKey))
    .setVersion('legacy')
    .setBlockhash(BLOCKHASH)
    .buildAndSign(umi);
  const prepared = {
    ...signed,
    signatures: signed.signatures.map((signature, index) =>
      index === 0 ? new Uint8Array(64) : signature,
    ),
  };
  return {
    umi,
    participant,
    asset,
    preparedBytes: Buffer.from(umi.transactions.serialize(prepared)),
    signedBytes: Buffer.from(umi.transactions.serialize(signed)),
    guardedBytes: Buffer.from(umi.transactions.serialize(guarded)),
    messageHash: createHash('sha256').update(signed.serializedMessage).digest('hex'),
  };
}

/** 지갑 혼자 서명하는 SOL 전송 거래와, 지갑이 바꿔서 서명한 제출본을 만드는 도구. */
async function transferFixture() {
  const umi = createUmi('http://127.0.0.1:8899');
  const payer = umiModule.generateSigner(umi);
  const recipient = umiModule.generateSigner(umi).publicKey;
  const unsigned = umiModule.createNoopSigner(payer.publicKey);
  const limit = item(COMPUTE_BUDGET_PROGRAM, [], [2, 0x20, 0x4e, 0, 0]);
  const price = item(COMPUTE_BUDGET_PROGRAM, [], [3, 0, 0, 0, 0, 0, 0, 0, 0]);
  const transfer = (signer, lamports = 1_000_000n, writable = true) =>
    item(
      SYSTEM_PROGRAM,
      [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: writable },
      ],
      [
        2, 0, 0, 0,
        ...Array.from({ length: 8 }, (_, index) =>
          Number((lamports >> BigInt(index * 8)) & 0xffn),
        ),
      ],
      [signer],
    );
  const build = async (items, signer, blockhash = BLOCKHASH) => {
    const transaction = await umiModule
      .transactionBuilder()
      .add(items)
      .setFeePayer(signer)
      .setVersion('legacy')
      .setBlockhash(blockhash)
      .buildAndSign(umi);
    return {
      bytes: Buffer.from(umi.transactions.serialize(transaction)),
      messageHash: createHash('sha256')
        .update(transaction.serializedMessage)
        .digest('hex'),
    };
  };
  const prepared = await build([limit, price, transfer(unsigned)], unsigned);
  return {
    payer,
    limit,
    price,
    transfer,
    guard: walletGuard(payer.publicKey),
    prepared,
    /** 지갑이 items로 다시 만든 거래에 서명한 결과를 검증기에 넣는다. */
    submit: async (items, blockhash) =>
      validateSignedClaimTransaction({
        preparedBytes: prepared.bytes,
        submittedBase64: (await build(items, payer, blockhash)).bytes.toString(
          'base64',
        ),
        expectedPayer: String(payer.publicKey),
        expectedMessageHash: prepared.messageHash,
      }),
  };
}

test('validator accepts the exact message with payer and server signatures intact', async () => {
  const fixture = await signedMintFixture();
  const result = validateSignedClaimTransaction({
    preparedBytes: fixture.preparedBytes,
    submittedBase64: fixture.signedBytes.toString('base64'),
    expectedPayer: String(fixture.participant.publicKey),
    expectedMessageHash: fixture.messageHash,
  });

  assert.equal(result.messageHash, fixture.messageHash);
  assert.equal(result.signature.length > 80, true);
  assert.deepEqual(result.signedBytes, fixture.signedBytes);
});

test('validator rejects message tampering, missing payer signature, and changed server signature', async () => {
  const fixture = await signedMintFixture();
  const signed = fixture.umi.transactions.deserialize(fixture.signedBytes);
  const tamperedMessage = Buffer.from(fixture.signedBytes);
  tamperedMessage[tamperedMessage.length - 1] ^= 1;
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: tamperedMessage.toString('base64'),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /does not (?:contain a valid legacy transaction|match the prepared transaction)/u,
  );

  const missingPayer = {
    ...signed,
    signatures: signed.signatures.map((signature, index) =>
      index === 0 ? new Uint8Array(64) : signature,
    ),
  };
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: Buffer.from(
          fixture.umi.transactions.serialize(missingPayer),
        ).toString('base64'),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /required signature is missing or invalid/u,
  );

  const changedServer = {
    ...signed,
    signatures: signed.signatures.map((signature, index) =>
      index === 1 ? randomBytes(64) : signature,
    ),
  };
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: Buffer.from(
          fixture.umi.transactions.serialize(changedServer),
        ).toString('base64'),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /server signature changed/u,
  );
});

test('validator requires canonical padded Base64 within the legacy packet limit', async () => {
  const fixture = await signedMintFixture();
  const canonical = fixture.signedBytes.toString('base64');
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: Buffer.from([1]).toString('base64').replace(/=+$/u, ''),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /canonical padded Base64/u,
  );
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: Buffer.alloc(1233).toString('base64'),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /legacy packet limit/u,
  );
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: Buffer.concat([
          fixture.signedBytes,
          Buffer.from([0]),
        ]).toString('base64'),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /(?:canonical legacy wire encoding|does not match the prepared transaction)/u,
  );
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: canonical,
        expectedPayer: String(umiModule.generateSigner(fixture.umi).publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /expected fee payer/u,
  );
});

test('validator accepts wallet safety checks added to a wallet-only transaction', async () => {
  const fixture = await transferFixture();
  const { limit, price, transfer, guard, payer } = fixture;

  // Phantom은 mainnet에서 안전 확인을 끝에 하나 덧붙인다.
  const appended = await fixture.submit([limit, price, transfer(payer), guard]);
  assert.equal(appended.walletGuardCount, 1);
  assert.notEqual(appended.messageHash, fixture.prepared.messageHash);
  assert.equal(appended.signature.length > 80, true);

  // 앞이나 중간에 여러 개가 끼어 계정 순서가 달라져도 준비한 instruction이 그대로면 받는다.
  const interleaved = await fixture.submit([
    guard,
    limit,
    price,
    guard,
    transfer(payer),
  ]);
  assert.equal(interleaved.walletGuardCount, 2);

  // 접수 뒤에는 서명된 bytes와 그 hash가 저장되므로 같은 bytes의 재전송도 통과한다.
  const replay = validateSignedClaimTransaction({
    preparedBytes: appended.signedBytes,
    submittedBase64: appended.signedBytes.toString('base64'),
    expectedPayer: String(payer.publicKey),
    expectedMessageHash: appended.messageHash,
  });
  assert.equal(replay.walletGuardCount, 0);
  assert.equal(replay.signature, appended.signature);
});

test('validator rejects every other change even when a wallet safety check is present', async () => {
  const fixture = await transferFixture();
  const { limit, price, transfer, guard, payer } = fixture;
  const rejected = (items, cause, blockhash) =>
    assert.rejects(
      fixture.submit(items, blockhash),
      new RegExp(`does not match the prepared transaction.*"cause":"${cause}"`, 'u'),
    );

  // 다른 프로그램의 instruction은 안전 확인이 아니다.
  await rejected(
    [limit, price, transfer(payer), guard, item(MEMO_PROGRAM, [], [1])],
    'instructions',
  );
  // 금액, 빠진 instruction, 순서 변경.
  await rejected([limit, price, transfer(payer, 1n), guard], 'instructions');
  await rejected([limit, transfer(payer), guard], 'instructions');
  await rejected([price, limit, transfer(payer), guard], 'instructions');
  // 받는 계정의 쓰기 권한 변경.
  await rejected(
    [limit, price, transfer(payer, 1_000_000n, false), guard],
    'roles',
  );
  // 만료 추적에 쓰는 blockhash 변경.
  await rejected(
    [limit, price, transfer(payer), guard],
    'blockhash',
    '11111111111111111111111111111112',
  );
});

test('validator rejects wallet safety checks on a transaction the server also signs', async () => {
  const fixture = await signedMintFixture();
  assert.throws(
    () =>
      validateSignedClaimTransaction({
        preparedBytes: fixture.preparedBytes,
        submittedBase64: fixture.guardedBytes.toString('base64'),
        expectedPayer: String(fixture.participant.publicKey),
        expectedMessageHash: fixture.messageHash,
      }),
    /does not match the prepared transaction.*"cause":"signers"/u,
  );
});
