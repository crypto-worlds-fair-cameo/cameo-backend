import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { Transaction, TransactionMessage } from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';

const MAX_TRANSACTION_BYTES = 1232;
const MAX_BASE64_CHARACTERS = 1644;
/**
 * Phantom·Solflare가 mainnet 거래에 서명하기 전에 덧붙이는 Lighthouse 안전 확인 프로그램.
 * devnet 거래에는 붙지 않는다.
 */
const WALLET_GUARD_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const SIGNER = 1;
const WRITABLE = 2;
const umi = createUmi('http://127.0.0.1:8899');

export type ValidatedSignedClaimTransaction = Readonly<{
  signedBytes: Buffer;
  /** 지갑이 실제로 서명한 message의 hash. 지갑이 안전 확인을 덧붙였으면 준비 거래의 hash와 다르다. */
  messageHash: string;
  signature: string;
  /** 지갑이 덧붙인 안전 확인 instruction 수. */
  walletGuardCount: number;
}>;

type ResolvedInstruction = Readonly<{
  program: string;
  accounts: readonly string[];
  data: Uint8Array;
}>;

type MismatchCause =
  'signers' | 'blockhash' | 'payer' | 'roles' | 'instructions';

function invalid(reason: string): Error {
  return new Error(`Signed transaction ${reason}`);
}

/** 검증 실패 로그에 남길 고정 사유. 서명·거래 bytes와 인증 정보는 포함하지 않는다. */
export function signedTransactionRejection(error: unknown): string {
  return error instanceof Error &&
    error.message.startsWith('Signed transaction ')
    ? error.message
    : 'Transaction validation failed.';
}

function messageHashOf(serializedMessage: Uint8Array): string {
  return createHash('sha256').update(serializedMessage).digest('hex');
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

/** 달라진 program 목록, blockhash, 서명자 수만 기록하며 서명·거래 bytes는 노출하지 않는다. */
function mismatch(
  prepared: Transaction,
  submitted: Transaction,
  cause: MismatchCause,
): Error {
  const summarize = (transaction: Transaction) =>
    transaction.message.instructions.map((instruction) => ({
      program: String(transaction.message.accounts[instruction.programIndex]),
      dataLength: instruction.data.length,
    }));
  return invalid(
    `does not match the prepared transaction. ${JSON.stringify({
      cause,
      blockhashChanged:
        prepared.message.blockhash !== submitted.message.blockhash,
      signers: [
        prepared.message.header.numRequiredSignatures,
        submitted.message.header.numRequiredSignatures,
      ],
      prepared: summarize(prepared),
      submitted: summarize(submitted),
    })}`,
  );
}

/** 계정 주소별 서명·쓰기 권한. 깨진 header나 중복 주소는 거절한다. */
function accountRoles(message: TransactionMessage): Map<string, number> {
  const {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
  } = message.header;
  const total = message.accounts.length;
  if (
    numRequiredSignatures < 1 ||
    numReadonlySignedAccounts >= numRequiredSignatures ||
    numRequiredSignatures + numReadonlyUnsignedAccounts > total
  ) {
    throw invalid('has an invalid account header.');
  }
  const roles = new Map<string, number>();
  message.accounts.forEach((account, index) => {
    const signer = index < numRequiredSignatures;
    const writable = signer
      ? index < numRequiredSignatures - numReadonlySignedAccounts
      : index < total - numReadonlyUnsignedAccounts;
    roles.set(
      String(account),
      (signer ? SIGNER : 0) | (writable ? WRITABLE : 0),
    );
  });
  if (roles.size !== total) throw invalid('repeats an account.');
  return roles;
}

/** instruction의 계정 번호를 주소로 풀어, 계정 순서가 바뀐 message끼리도 비교할 수 있게 한다. */
function resolveInstructions(
  message: TransactionMessage,
): ResolvedInstruction[] {
  return message.instructions.map((instruction) => {
    const program = message.accounts[instruction.programIndex];
    const accounts = instruction.accountIndexes.map(
      (index) => message.accounts[index],
    );
    if (
      program === undefined ||
      accounts.some((account) => account === undefined)
    ) {
      throw invalid('references a missing account.');
    }
    return {
      program: String(program),
      accounts: accounts.map(String),
      data: instruction.data,
    };
  });
}

function sameInstruction(
  left: ResolvedInstruction,
  right: ResolvedInstruction,
): boolean {
  return (
    left.program === right.program &&
    left.accounts.length === right.accounts.length &&
    left.accounts.every(
      (account, index) => account === right.accounts[index],
    ) &&
    Buffer.from(left.data).equals(Buffer.from(right.data))
  );
}

/**
 * message가 달라졌을 때 지갑이 안전 확인 instruction만 덧붙였는지 검사하고 그 수를 반환한다.
 * 서명자가 지갑 하나뿐인 거래에서만 허용하므로 덧붙은 instruction이 쓸 수 있는 것은 서명한 본인 지갑뿐이다.
 * 준비한 instruction은 순서, program, 계정, data, 권한이 모두 그대로여야 한다.
 */
function countWalletGuards(
  prepared: Transaction,
  submitted: Transaction,
): number {
  const before = prepared.message;
  const after = submitted.message;
  if (
    before.header.numRequiredSignatures !== 1 ||
    after.header.numRequiredSignatures !== 1
  ) {
    throw mismatch(prepared, submitted, 'signers');
  }
  if (before.blockhash !== after.blockhash) {
    throw mismatch(prepared, submitted, 'blockhash');
  }
  if (String(before.accounts[0]) !== String(after.accounts[0])) {
    throw mismatch(prepared, submitted, 'payer');
  }
  const afterRoles = accountRoles(after);
  for (const [account, role] of accountRoles(before)) {
    if (afterRoles.get(account) !== role) {
      throw mismatch(prepared, submitted, 'roles');
    }
  }
  const expected = resolveInstructions(before);
  const kept = resolveInstructions(after).filter(
    (instruction) => instruction.program !== WALLET_GUARD_PROGRAM_ID,
  );
  if (
    kept.length !== expected.length ||
    !kept.every((instruction, index) =>
      sameInstruction(instruction, expected[index]),
    )
  ) {
    throw mismatch(prepared, submitted, 'instructions');
  }
  return after.instructions.length - kept.length;
}

/**
 * 제출 거래가 저장된 legacy 거래와 같은 일을 하고 모든 필수 서명을 보존했는지 검증한다.
 * message는 준비 거래와 정확히 같거나, 지갑 혼자 서명하는 거래에 지갑이 안전 확인만 덧붙인 것이어야 한다.
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

  // message가 byte 단위로 같지 않으면 지갑이 안전 확인만 덧붙인 경우에만 받는다.
  const walletGuardCount = Buffer.from(prepared.serializedMessage).equals(
    Buffer.from(submitted.serializedMessage),
  )
    ? 0
    : countWalletGuards(prepared, submitted);
  if (messageHashOf(prepared.serializedMessage) !== input.expectedMessageHash) {
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
    messageHash: messageHashOf(submitted.serializedMessage),
    signature: bs58.encode(submitted.signatures[0]),
    walletGuardCount,
  };
}
