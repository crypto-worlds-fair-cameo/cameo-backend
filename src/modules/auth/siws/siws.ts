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
    statement: 'Sign in to Cameo.',
    uri: `${input.origin}/`,
    version: '1',
    chainId: 'mainnet',
    nonce: input.nonce,
    issuedAt: input.createdAt.toISOString(),
    expirationTime: input.expiresAt.toISOString(),
    requestId: input.challengeId,
  };
}
