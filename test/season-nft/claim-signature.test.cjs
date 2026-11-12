const { createHash, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const core = require('@metaplex-foundation/mpl-core');
const candy = require('@metaplex-foundation/mpl-core-candy-machine');
const umiModule = require('@metaplex-foundation/umi');
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');

const {
  completeSignedTransaction,
  validateSignedClaimTransaction,
  validateWalletSignedTransaction,
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
  const bytes = (transaction) =>
    Buffer.from(umi.transactions.serialize(transaction));
  /** 지갑이 extra를 덧붙여 다시 만든 거래. 서명 칸은 모두 비어 있다. */
  const unsignedWith = (...extra) =>
    mint().add(extra).setVersion('legacy').setBlockhash(BLOCKHASH).build(umi);
  const signed = await mint()
    .setVersion('legacy')
    .setBlockhash(BLOCKHASH)
    .buildAndSign(umi);
  const safetyCheck = walletGuard(participant.publicKey);
  // 참가자와 asset이 모두 서명한, 안전 확인이 덧붙은 거래.
  const guarded = await asset.signTransaction(
    await participant.signTransaction(unsignedWith(safetyCheck)),
  );
  // 서버가 asset 서명을 미리 넣어 두던 예전 준비 거래.
  const prepared = {
    ...signed,
    signatures: signed.signatures.map((signature, index) =>
      index === 0 ? new Uint8Array(64) : signature,
    ),
  };
  const input = (preparedBytes, submitted) => ({
    preparedBytes,
    submittedBase64: bytes(submitted).toString('base64'),
    expectedPayer: String(participant.publicKey),
    expectedMessageHash: createHash('sha256')
      .update(signed.serializedMessage)
      .digest('hex'),
  });
  return {
    umi,
    participant,
    asset,
    safetyCheck,
    unsignedWith,
    input,
    preparedBytes: bytes(prepared),
    // 서명 칸을 모두 비운 지금의 준비 거래.
    unsignedBytes: bytes(unsignedWith()),
    signedBytes: bytes(signed),
    guardedBytes: bytes(guarded),
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

  // 서버 서명 칸에 다른 값을 넣은 제출본은 서버가 다시 서명해 주지 않는 한 완성본이 아니다.
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
    /required signature is missing or invalid/u,
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

test('the wallet signs first and the server fills its own signature afterward', async () => {
  const fixture = await signedMintFixture();
  const { participant, asset } = fixture;
  const walletOnly = await participant.signTransaction(fixture.unsignedWith());
  const input = fixture.input(fixture.unsignedBytes, walletOnly);

  // 서버 서명이 빠진 제출본은 그대로는 완성본이 아니다.
  assert.throws(
    () => validateSignedClaimTransaction(input),
    /required signature is missing or invalid/u,
  );
  const walletSigned = validateWalletSignedTransaction(input);
  assert.deepEqual(walletSigned.missingSigners, [String(asset.publicKey)]);
  assert.equal(walletSigned.walletGuardCount, 0);

  // 그 주소의 열쇠가 없으면 채우지 못한다.
  await assert.rejects(
    completeSignedTransaction(walletSigned, []),
    /required signature is missing or invalid/u,
  );
  await assert.rejects(
    completeSignedTransaction(walletSigned, [
      umiModule.generateSigner(fixture.umi),
    ]),
    /required signature is missing or invalid/u,
  );

  const completed = await completeSignedTransaction(walletSigned, [asset]);
  assert.deepEqual(completed.signedBytes, fixture.signedBytes);
  assert.equal(completed.messageHash, fixture.messageHash);
  assert.equal(completed.signature, walletSigned.signature);

  // 접수 뒤에는 완성본이 저장된다. 같은 제출을 다시 보내도 같은 완성본이 나온다.
  const replay = await completeSignedTransaction(
    validateWalletSignedTransaction(
      fixture.input(completed.signedBytes, walletOnly),
    ),
    [asset],
  );
  assert.deepEqual(replay.signedBytes, completed.signedBytes);

  // 지갑 서명이 없으면 서버 서명을 채우는 단계로 가지 못한다.
  assert.throws(
    () =>
      validateWalletSignedTransaction(
        fixture.input(fixture.unsignedBytes, fixture.unsignedWith()),
      ),
    /required signature is missing or invalid/u,
  );

  // 지갑이 끝에 byte를 붙인 message에 서명해 와도, 서버는 읽지 않은 bytes에 서명하지 않는다.
  const unsigned = fixture.unsignedWith();
  const padded = Buffer.concat([
    Buffer.from(unsigned.serializedMessage),
    Buffer.from([0]),
  ]);
  assert.throws(
    () =>
      validateWalletSignedTransaction(
        fixture.input(fixture.unsignedBytes, {
          ...unsigned,
          serializedMessage: padded,
          signatures: [
            fixture.umi.eddsa.sign(padded, participant),
            new Uint8Array(64),
          ],
        }),
      ),
    /canonical legacy wire encoding/u,
  );
});

test('the server signs after the wallet adds safety checks to a transaction both sign', async () => {
  const fixture = await signedMintFixture();
  const { participant, asset, safetyCheck } = fixture;
  const walletOnly = await participant.signTransaction(
    fixture.unsignedWith(safetyCheck),
  );
  const walletSigned = validateWalletSignedTransaction(
    fixture.input(fixture.unsignedBytes, walletOnly),
  );
  assert.equal(walletSigned.walletGuardCount, 1);
  assert.deepEqual(walletSigned.missingSigners, [String(asset.publicKey)]);
  const completed = await completeSignedTransaction(walletSigned, [asset]);
  assert.deepEqual(completed.signedBytes, fixture.guardedBytes);
  assert.notEqual(completed.messageHash, fixture.messageHash);

  // 서버가 서명을 미리 넣어 둔 예전 준비 거래도, 모든 서명이 새 message에 맞으면 받는다.
  const legacy = validateSignedClaimTransaction({
    preparedBytes: fixture.preparedBytes,
    submittedBase64: fixture.guardedBytes.toString('base64'),
    expectedPayer: String(participant.publicKey),
    expectedMessageHash: fixture.messageHash,
  });
  assert.equal(legacy.walletGuardCount, 1);
  assert.deepEqual(legacy.signedBytes, fixture.guardedBytes);

  // 계정을 읽기만 하는 확인은 서버 서명자를 가리켜도 된다.
  const readOnlyCheck = item(
    LIGHTHOUSE_PROGRAM,
    [{ pubkey: asset.publicKey, isSigner: false, isWritable: false }],
    [6, 4, 0],
  );
  assert.equal(
    validateWalletSignedTransaction(
      fixture.input(
        fixture.unsignedBytes,
        await participant.signTransaction(fixture.unsignedWith(readOnlyCheck)),
      ),
    ).walletGuardCount,
    1,
  );
});

test('added instructions cannot spend from a signer the server signs for', async () => {
  const fixture = await signedMintFixture();
  const { participant, asset } = fixture;
  /** Lighthouse MemoryWrite(0)·MemoryClose(1)는 payer 서명자의 돈을 옮긴다. */
  const memory = (payer, data) =>
    item(
      LIGHTHOUSE_PROGRAM,
      [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data,
      [payer],
    );
  const submit = async (extra) =>
    validateWalletSignedTransaction(
      fixture.input(
        fixture.unsignedBytes,
        await participant.signTransaction(fixture.unsignedWith(extra)),
      ),
    );

  for (const data of [[0, 0, 0], [1, 0, 0], []]) {
    await assert.rejects(
      submit(memory(asset, data)),
      /does not match the prepared transaction.*"cause":"guards"/u,
    );
  }
  // 지갑이 자기 돈으로 하는 것은 지갑 자신의 서명이므로 받는다.
  assert.equal((await submit(memory(participant, [0, 0, 0]))).walletGuardCount, 1);
  // 다른 프로그램은 어떤 경우에도 덧붙일 수 없다.
  await assert.rejects(
    submit(item(MEMO_PROGRAM, [], [1])),
    /does not match the prepared transaction.*"cause":"instructions"/u,
  );
  // 서명자를 늘리거나 바꿀 수 없다.
  const stranger = umiModule.generateSigner(fixture.umi);
  await assert.rejects(
    submit(memory(stranger, [6, 4, 0])),
    /does not match the prepared transaction.*"cause":"signers"/u,
  );
});
