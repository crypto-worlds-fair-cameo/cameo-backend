import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';

const MAX_TRANSACTION_BYTES = 1232;
const MAX_BASE64_CHARACTERS = 1644;
const umi = createUmi('http://127.0.0.1:8899');

export type ValidatedSignedClaimTransaction = Readonly<{
  signedBytes: Buffer;
  messageHash: string;
  signature: string;
}>;

function invalid(reason: string): Error {
  return new Error(`Signed transaction ${reason}`);
}

function decodeCanonicalBase64(source: string): Buffer {
  if (
    source.length === 0 ||
    source.length > MAX_BASE64_CHARACTERS ||
    source.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      source,
    )
  ) {
    throw invalid('must use canonical padded Base64.');
  }
  const bytes = Buffer.from(source, 'base64');
  if (bytes.toString('base64') !== source) {
    throw invalid('must use canonical padded Base64.');
  }
  if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) {
    throw invalid('exceeds the legacy packet limit.');
  }
  return bytes;
}

function hasSignature(signature: Uint8Array): boolean {
  return signature.length === 64 && signature.some((byte) => byte !== 0);
}

/**
 * 제출 거래가 저장된 legacy message와 정확히 같고 모든 필수 서명을 보존했는지 검증한다.
 * 사용자 서명 외의 부분 서명은 byte 단위로 유지해야 하며 RPC 호출은 수행하지 않는다.
 */
export function validateSignedClaimTransaction(
  input: Readonly<{
    preparedBytes: Buffer;
    submittedBase64: string;
    expectedPayer: string;
    expectedMessageHash: string;
  }>,
): ValidatedSignedClaimTransaction {
  const signedBytes = decodeCanonicalBase64(input.submittedBase64);
  let prepared;
  let submitted;
  try {
    prepared = umi.transactions.deserialize(input.preparedBytes);
    submitted = umi.transactions.deserialize(signedBytes);
  } catch {
    throw invalid('does not contain a valid legacy transaction.');
  }
  if (
    prepared.message.version !== 'legacy' ||
    submitted.message.version !== 'legacy' ||
    submitted.message.header.numRequiredSignatures !==
      submitted.signatures.length
  ) {
    throw invalid('does not contain a valid legacy transaction.');
  }
  if (!Buffer.from(umi.transactions.serialize(submitted)).equals(signedBytes)) {
    throw invalid('does not use canonical legacy wire encoding.');
  }

  // 서명 배열을 제외한 message가 다르면 payer, blockhash, instruction 또는 계정이 바뀐 요청이다.
  if (
    !Buffer.from(prepared.serializedMessage).equals(
      Buffer.from(submitted.serializedMessage),
    )
  ) {
    // 변경된 program 목록과 blockhash 여부만 기록하며 서명·거래 bytes는 노출하지 않는다.
    const summarize = (transaction: typeof prepared) =>
      transaction.message.instructions.map((instruction) => ({
        program: String(transaction.message.accounts[instruction.programIndex]),
        dataLength: instruction.data.length,
      }));
    throw invalid(
      `does not match the prepared transaction. ${JSON.stringify({
        blockhashChanged:
          prepared.message.blockhash !== submitted.message.blockhash,
        prepared: summarize(prepared),
        submitted: summarize(submitted),
      })}`,
    );
  }
  const messageHash = createHash('sha256')
    .update(submitted.serializedMessage)
    .digest('hex');
  if (messageHash !== input.expectedMessageHash) {
    throw invalid('does not match the prepared transaction.');
  }
  if (String(submitted.message.accounts[0]) !== input.expectedPayer) {
    throw invalid('does not match the expected fee payer.');
  }
  if (prepared.signatures.length !== submitted.signatures.length) {
    throw invalid('does not match the prepared signer set.');
  }

  // 서버가 미리 추가한 asset 서명은 지갑이 바꿀 수 없다.
  for (let index = 0; index < prepared.signatures.length; index += 1) {
    const preparedSignature = prepared.signatures[index];
    if (
      hasSignature(preparedSignature) &&
      !Buffer.from(preparedSignature).equals(
        Buffer.from(submitted.signatures[index]),
      )
    ) {
      throw invalid('server signature changed.');
    }
  }

  // legacy message의 required signer 순서에 맞춰 모든 detached Ed25519 서명을 검증한다.
  for (let index = 0; index < submitted.signatures.length; index += 1) {
    const signature = submitted.signatures[index];
    const publicKey = submitted.message.accounts[index];
    if (
      !publicKey ||
      !hasSignature(signature) ||
      !umi.eddsa.verify(submitted.serializedMessage, signature, publicKey)
    ) {
      throw invalid('required signature is missing or invalid.');
    }
  }

  return {
    signedBytes,
    messageHash,
    signature: bs58.encode(submitted.signatures[0]),
  };
}
