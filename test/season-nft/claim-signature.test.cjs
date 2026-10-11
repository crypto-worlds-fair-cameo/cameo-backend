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
  const signed = await candy
    .mintV1(umi, {
      candyMachine: machine,
      candyGuard: guard,
      payer: participant,
      minter: participant,
      owner: participant.publicKey,
      asset,
      collection,
      mintArgs: { allowList: { merkleRoot: root }, mintLimit: { id: 0 } },
    })
    .setVersion('legacy')
    .setBlockhash('11111111111111111111111111111111')
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
    messageHash: createHash('sha256').update(signed.serializedMessage).digest('hex'),
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
