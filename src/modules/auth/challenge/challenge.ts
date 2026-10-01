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
