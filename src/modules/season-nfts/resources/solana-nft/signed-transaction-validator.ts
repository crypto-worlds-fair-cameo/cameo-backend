import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type {
  Signer,
  Transaction,
  TransactionMessage,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';

const MAX_TRANSACTION_BYTES = 1232;
const MAX_BASE64_CHARACTERS = 1644;
/**
 * Phantom·Solflare가 mainnet 거래에 서명하기 전에 덧붙이는 Lighthouse 안전 확인 프로그램.
 * devnet 거래에는 붙지 않는다. 업그레이드 권한이 없어 동작이 바뀌지 않는다.
 */
const WALLET_GUARD_PROGRAM_ID = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
/** Lighthouse instruction 0·1번(MemoryWrite·MemoryClose)만 서명자의 돈을 옮긴다. 2번부터는 계정을 읽기만 하는 확인이다. */
const WALLET_GUARD_FIRST_READ_ONLY_CHECK = 2;
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

/** 지갑 서명까지 확인한 제출 거래. 서버가 서명할 칸은 아직 비어 있을 수 있다. */
export type WalletSignedTransaction = Readonly<{
  transaction: Transaction;
  messageHash: string;
  /** 수수료를 내는 지갑의 서명. 체인에서 이 거래를 가리키는 값이다. */
  signature: string;
  walletGuardCount: number;
  /** 유효한 서명이 없어 서버가 채워야 하는 서명자 주소. */
  missingSigners: readonly string[];
}>;

type ResolvedInstruction = Readonly<{
  program: string;
  accounts: readonly string[];
  data: Uint8Array;
}>;

type MismatchCause =
  'signers' | 'blockhash' | 'payer' | 'roles' | 'instructions' | 'guards';

function invalid(reason: string): Error {
  return new Error(`Signed transaction ${reason}`);
}

/** 제출한 거래가 틀려서 난 거절인지 가린다. 서버 열쇠를 읽지 못한 것 같은 서버 쪽 실패와 구분한다. */
export function isSignedTransactionRejection(error: unknown): error is Error {
  return (
    error instanceof Error && error.message.startsWith('Signed transaction ')
  );
}

/** 검증 실패 로그에 남길 고정 사유. 서명·거래 bytes와 인증 정보는 포함하지 않는다. */
export function signedTransactionRejection(error: unknown): string {
  return isSignedTransactionRejection(error)
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
 * 준비한 instruction은 순서, program, 계정, data, 권한이 모두 그대로여야 하고 서명자 구성도 같아야 한다.
 * 덧붙은 instruction 가운데 돈을 옮길 수 있는 것은 지갑 자신만 서명자로 쓸 수 있다.
 * 서버 서명자를 건드릴 수 있는 것은 계정을 읽기만 하는 확인뿐이다.
 */
function countWalletGuards(
  prepared: Transaction,
  submitted: Transaction,
): number {
  const before = prepared.message;
  const after = submitted.message;
  if (
    before.header.numRequiredSignatures !== after.header.numRequiredSignatures
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
  const resolved = resolveInstructions(after);
  const kept = resolved.filter(
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
  const wallet = String(after.accounts[0]);
  for (const guard of resolved) {
    if (guard.program !== WALLET_GUARD_PROGRAM_ID) continue;
    const readOnlyCheck =
      guard.data.length > 0 &&
      guard.data[0] >= WALLET_GUARD_FIRST_READ_ONLY_CHECK;
    if (
      !readOnlyCheck &&
      guard.accounts.some(
        (account) =>
          account !== wallet && ((afterRoles.get(account) ?? 0) & SIGNER) !== 0,
      )
    ) {
      throw mismatch(prepared, submitted, 'guards');
    }
  }
  return resolved.length - kept.length;
}

function validSignature(transaction: Transaction, index: number): boolean {
  const signature = transaction.signatures[index];
  const publicKey = transaction.message.accounts[index];
  return (
    Boolean(publicKey) &&
    hasSignature(signature) &&
    umi.eddsa.verify(transaction.serializedMessage, signature, publicKey)
  );
}

/**
 * 풀어 낸 message를 다시 묶으면 서명 대상 bytes와 같은지 본다.
 * 끝에 남는 byte처럼 검사에서 읽지 않은 내용이 있으면 서버가 확인하지 않은 bytes에 서명하게 된다.
 */
function readsWholeMessage(transaction: Transaction): boolean {
  try {
    return Buffer.from(
      umi.transactions.serializeMessage(transaction.message),
    ).equals(Buffer.from(transaction.serializedMessage));
  } catch {
    return false;
  }
}

type SignedTransactionInput = Readonly<{
  preparedBytes: Buffer;
  submittedBase64: string;
  expectedPayer: string;
  expectedMessageHash: string;
}>;

/**
 * 제출 거래가 저장된 legacy 거래와 같은 일을 하고 지갑이 서명했는지 검증한다.
 * message는 준비 거래와 정확히 같거나, 지갑이 안전 확인만 덧붙인 것이어야 한다.
 * 지갑 외 서명자의 칸은 유효한 서명이 있으면 그대로 두고, 없으면 서버가 채울 대상으로 알려 준다.
 * RPC 호출은 수행하지 않는다.
 */
export function validateWalletSignedTransaction(
  input: SignedTransactionInput,
): WalletSignedTransaction {
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
  if (
    !Buffer.from(umi.transactions.serialize(submitted)).equals(signedBytes) ||
    !readsWholeMessage(submitted)
  ) {
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

  // 수수료를 내는 지갑의 서명은 반드시 있어야 한다. 나머지 칸은 서버가 채울 수 있다.
  if (!validSignature(submitted, 0)) {
    throw invalid('required signature is missing or invalid.');
  }
  const missingSigners: string[] = [];
  for (let index = 1; index < submitted.signatures.length; index += 1) {
    if (!validSignature(submitted, index)) {
      missingSigners.push(String(submitted.message.accounts[index]));
    }
  }

  return {
    transaction: submitted,
    messageHash: messageHashOf(submitted.serializedMessage),
    signature: bs58.encode(submitted.signatures[0]),
    walletGuardCount,
    missingSigners,
  };
}

/**
 * 지갑이 먼저 서명한 거래의 비어 있는 칸을 서버 서명자로 채우고, 모든 필수 서명을 다시 검증한다.
 * 채울 서명자가 없는 칸이 남으면 거절한다.
 */
export async function completeSignedTransaction(
  validated: WalletSignedTransaction,
  signers: readonly Signer[],
): Promise<ValidatedSignedClaimTransaction> {
  let transaction = validated.transaction;
  for (const address of validated.missingSigners) {
    const signer = signers.find(
      (candidate) => String(candidate.publicKey) === address,
    );
    if (!signer) throw invalid('required signature is missing or invalid.');
    transaction = await signer.signTransaction(transaction);
  }
  if (
    !Buffer.from(transaction.serializedMessage).equals(
      Buffer.from(validated.transaction.serializedMessage),
    )
  ) {
    throw invalid('changed while the server was signing.');
  }
  return fullySigned(validated, transaction);
}

/** 서버가 서명을 보태지 않는 거래용. 제출본에 모든 필수 서명이 이미 있어야 한다. */
export function validateSignedClaimTransaction(
  input: SignedTransactionInput,
): ValidatedSignedClaimTransaction {
  const validated = validateWalletSignedTransaction(input);
  return fullySigned(validated, validated.transaction);
}

/** legacy message의 required signer 순서에 맞춰 모든 detached Ed25519 서명을 검증한 완성본을 만든다. */
function fullySigned(
  validated: WalletSignedTransaction,
  transaction: Transaction,
): ValidatedSignedClaimTransaction {
  for (let index = 0; index < transaction.signatures.length; index += 1) {
    if (!validSignature(transaction, index)) {
      throw invalid('required signature is missing or invalid.');
    }
  }
  return {
    signedBytes: Buffer.from(umi.transactions.serialize(transaction)),
    messageHash: validated.messageHash,
    signature: validated.signature,
    walletGuardCount: validated.walletGuardCount,
  };
}
