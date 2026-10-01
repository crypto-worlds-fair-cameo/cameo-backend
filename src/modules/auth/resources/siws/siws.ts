import {
  createSignInMessage,
  verifySignIn,
} from '@solana/wallet-standard-util';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';

/** 서버가 발급하고 이후 서명 검증의 기준으로 사용할 Solana SIWS 입력이다. */
export type SiwsSignInInput = Readonly<{
  domain: string;
  statement: string;
  uri: string;
  version: '1';
  chainId: 'mainnet';
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  requestId: string;
}>;

/** 서명 검증을 마친 뒤 계정 처리에 전달할 지갑 식별 정보다. */
export type VerifiedWalletIdentity = Readonly<{
  chainNamespace: 'solana';
  address: string;
  addressKey: string;
}>;

const SIWS_INPUT_KEYS = [
  'domain',
  'statement',
  'uri',
  'version',
  'chainId',
  'nonce',
  'issuedAt',
  'expirationTime',
  'requestId',
] as const;
const SIWS_STATEMENT = 'Sign in to Cameo.';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function isCanonicalIsoUtc(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

/**
 * Solana 주소를 Base58 공개키로 디코딩한다.
 * 공백이나 다른 표현으로 정규화하지 않으며 정확히 32바이트인 주소만 반환한다.
 */
export function decodeSolanaAddress(address: string): Uint8Array | undefined {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return undefined;
  const publicKey = bs58.decode(address);
  return publicKey.length === 32 ? publicKey : undefined;
}

/**
 * 저장된 값이 서버가 발급하는 SIWS 입력 전체 계약을 따르는지 확인한다.
 * 타입뿐 아니라 고정 정책, 출처 URI, 5분 만료 관계도 함께 검증한다.
 */
export function isSiwsSignInInput(value: unknown): value is SiwsSignInInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== SIWS_INPUT_KEYS.length ||
    !SIWS_INPUT_KEYS.every(
      (key) => Object.hasOwn(input, key) && typeof input[key] === 'string',
    )
  ) {
    return false;
  }

  if (
    input.statement !== SIWS_STATEMENT ||
    input.version !== '1' ||
    input.chainId !== 'mainnet' ||
    !/^[0-9a-f]{64}$/.test(input.nonce as string) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.requestId as string,
    ) ||
    !isCanonicalIsoUtc(input.issuedAt as string) ||
    !isCanonicalIsoUtc(input.expirationTime as string) ||
    Date.parse(input.expirationTime as string) -
      Date.parse(input.issuedAt as string) !==
      CHALLENGE_TTL_MS
  ) {
    return false;
  }

  // 발급 URI는 HTTP(S) 출처의 루트이며, domain은 같은 URI의 포트 포함 호스트다.
  const uri = URL.parse(input.uri as string);
  if (!uri) return false;
  return (
    (uri.protocol === 'http:' || uri.protocol === 'https:') &&
    uri.username === '' &&
    uri.password === '' &&
    uri.search === '' &&
    uri.hash === '' &&
    uri.origin !== 'null' &&
    `${uri.origin}/` === input.uri &&
    uri.host === input.domain
  );
}

/**
 * 서버에서 준비한 값으로 Solana SIWS 입력을 구성한다.
 * 호출자가 출처 허용 여부를 확인하고, DB 시각으로 생성·만료 시각을 정해야 한다.
 * 전달받은 nonce·시각을 그대로 사용해 응답과 저장 데이터의 기준을 일치시킨다.
 */
export function createSiwsSignInInput(
  input: Readonly<{
    origin: string;
    challengeId: string;
    nonce: string;
    createdAt: Date;
    expiresAt: Date;
  }>,
): SiwsSignInInput {
  return {
    domain: new URL(input.origin).host,
    statement: SIWS_STATEMENT,
    uri: `${input.origin}/`,
    version: '1',
    chainId: 'mainnet',
    nonce: input.nonce,
    issuedAt: input.createdAt.toISOString(),
    expirationTime: input.expiresAt.toISOString(),
    requestId: input.challengeId,
  };
}

/**
 * 서버 발급 SIWS 입력과 제출 주소로 원본 메시지 및 Ed25519 서명을 검증한다.
 * 형식 또는 증명이 맞지 않으면 undefined를 반환하며, 내부 예외는 호출자에게 전달한다.
 */
export function verifySiwsSignIn(
  input: SiwsSignInInput,
  address: string,
  signedMessage: Uint8Array,
  signature: Uint8Array,
): VerifiedWalletIdentity | undefined {
  const publicKey = decodeSolanaAddress(address);
  if (!publicKey || signature.length !== 64) return undefined;

  // 주소를 기대 입력에 포함해 메시지의 주소와 서명 공개키를 같은 값에 묶는다.
  const expectedInput = { ...input, address };
  const expectedMessage = createSignInMessage(expectedInput);
  if (!bytesEqual(expectedMessage, signedMessage)) return undefined;

  // 표준 유틸의 ZIP215 기본값은 개인키 없이 통과하는 small-order 공개키도 허용한다.
  // 웹 로그인은 지갑 소유 증명이므로 엄격한 검증으로 약한 공개키·비정규 점 표현을 거절한다.
  if (!ed25519.verify(signature, signedMessage, publicKey, { zip215: false })) {
    return undefined;
  }

  const verified = verifySignIn(expectedInput, {
    account: {
      address,
      publicKey,
      chains: ['solana:mainnet'],
      features: ['solana:signIn'],
    },
    signedMessage,
    signature,
  });
  if (!verified) return undefined;

  return { chainNamespace: 'solana', address, addressKey: address };
}
