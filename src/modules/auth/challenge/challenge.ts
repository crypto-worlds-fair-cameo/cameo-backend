export const AUTH_CHALLENGE_TTL_SECONDS = 300;

/** 서버가 발급하고 이후 서명 검증의 기준으로 사용할 SIWS 입력이다. */
export type SignInInput = Readonly<{
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

export type NewChallenge = Readonly<{
  id: string;
  nonce: string;
  signInInput: SignInInput;
  browserBindingHash: string;
  createdAt: Date;
  expiresAt: Date;
}>;
