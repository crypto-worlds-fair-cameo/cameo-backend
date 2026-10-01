import type { SiwsSignInInput } from '../siws/siws';

export const AUTH_CHALLENGE_TTL_SECONDS = 300;

/** 지원하는 인증 방식과 그 방식의 검증용 데이터를 함께 묶는다. */
export type ChallengeVerification = Readonly<{
  authMethod: 'siws';
  verificationPayload: SiwsSignInInput;
}>;

export type NewChallenge = Readonly<{
  id: string;
  nonce: string;
  browserBindingHash: string;
  createdAt: Date;
  expiresAt: Date;
}> &
  ChallengeVerification;

/** 저장 데이터를 읽을 때는 인증 방식과 payload를 신뢰하지 않고 런타임에 검증한다. */
export type StoredChallenge = Readonly<{
  id: string;
  authMethod: string;
  nonce: string;
  verificationPayload: unknown;
  browserBindingHash: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  usable: boolean;
}>;
