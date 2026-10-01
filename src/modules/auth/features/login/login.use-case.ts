import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../resources/auth-origin/auth-origin';
import {
  hashAuthSecret,
  isAuthSecret,
} from '../../resources/auth-secret/auth-secret';
import type { StoredChallenge } from '../../resources/challenge/challenge';
import { ChallengeRepository } from '../../resources/challenge/challenge.repository';
import { isSiwsSignInInput, verifySiwsSignIn } from '../../resources/siws/siws';
import { WalletAccountRepository } from '../../resources/wallet-account/wallet-account.repository';
import { SessionRepository } from '../../resources/session/session.repository';

export type LoginResult =
  | Readonly<{ outcome: 'unavailable' }>
  | Readonly<{
      outcome: 'authenticated';
      token: string;
      sessionExpiryDeadline: number;
      user: Readonly<{
        id: string;
        displayName: string | null;
        avatarUrl: string | null;
        wallets: ReadonlyArray<
          Readonly<{ chainNamespace: string; address: string }>
        >;
      }>;
      session: Readonly<{ expiresAt: Date; absoluteExpiresAt: Date }>;
    }>;

/** 검증한 스냅샷과 잠근 행이 다르면 이전 데이터로 소비하거나 로그인하지 않는다. */
function sameChallenge(left: StoredChallenge, right: StoredChallenge): boolean {
  return (
    left.authMethod === right.authMethod &&
    left.nonce === right.nonce &&
    left.browserBindingHash === right.browserBindingHash &&
    left.createdAt.getTime() === right.createdAt.getTime() &&
    left.expiresAt.getTime() === right.expiresAt.getTime() &&
    JSON.stringify(left.verificationPayload) ===
      JSON.stringify(right.verificationPayload)
  );
}

@Injectable()
export class LoginUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly challenges: ChallengeRepository,
    private readonly accounts: WalletAccountRepository,
    private readonly sessions: SessionRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * 저장된 챌린지로 증명을 검증하고 소비·자동 가입·세션 교체를 원자적으로 확정한다.
   * 비활성 계정은 소비만 커밋한 결과를 반환하며, HTTP 쿠키는 커밋 후 컨트롤러가 처리한다.
   */
  async execute(
    input: Readonly<{
      challengeId: string;
      address: string;
      signedMessage: Uint8Array;
      signature: Uint8Array;
      origin: string | undefined;
      browserBinding: string | undefined;
      previousToken: string | undefined;
    }>,
  ): Promise<LoginResult> {
    // 출처·연결 쿠키를 확인한 후 서버에 저장한 미사용 챌린지만 검증 기준으로 읽는다.
    assertAuthOrigin(
      input.origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    if (!isAuthSecret(input.browserBinding))
      throw new BusinessError(ErrorCodes.AuthChallengeInvalid);
    const bindingHash = hashAuthSecret(input.browserBinding);
    const challenge = await this.challenges.findById(input.challengeId);
    if (
      !challenge ||
      challenge.authMethod !== 'siws' ||
      !challenge.usable ||
      challenge.browserBindingHash !== bindingHash
    )
      throw new BusinessError(ErrorCodes.AuthChallengeInvalid);

    // DB의 검증 기준이 손상됐으면 클라이언트 입력으로 보완하지 않고 내부 실패로 처리한다.
    const payload = challenge.verificationPayload;
    if (
      !isSiwsSignInInput(payload) ||
      payload.nonce !== challenge.nonce ||
      payload.requestId !== challenge.id ||
      payload.issuedAt !== challenge.createdAt.toISOString() ||
      payload.expirationTime !== challenge.expiresAt.toISOString()
    ) {
      throw new Error('Stored authentication challenge is invalid');
    }
    assertAuthOrigin(input.origin, [new URL(payload.uri).origin]);
    const identity = verifySiwsSignIn(
      payload,
      input.address,
      input.signedMessage,
      input.signature,
    );
    if (!identity) throw new BusinessError(ErrorCodes.AuthSignatureInvalid);
    const previousHash = isAuthSecret(input.previousToken)
      ? hashAuthSecret(input.previousToken)
      : undefined;

    return this.transactions.run(async (transaction): Promise<LoginResult> => {
      // 존재하지 않는 지갑의 가입 경합도 잠금으로 직렬화하고, 잠금 이후 데이터를 재조회한다.
      await this.accounts.lockIdentity(identity, transaction);
      const locked = await this.challenges.lockById(challenge.id, transaction);
      if (!locked || !sameChallenge(challenge, locked))
        throw new BusinessError(ErrorCodes.AuthChallengeInvalid);
      let account = await this.accounts.findAndLock(identity, transaction);

      // 사용자 상태 잠금을 기다린 시간까지 반영해 최종 소비 시점의 만료를 판정한다.
      const time = await this.challenges.consume(challenge.id, transaction);
      if (!time) throw new BusinessError(ErrorCodes.AuthChallengeInvalid);
      // 비활성 계정은 예외를 던지지 않아 소비만 커밋하고, 기존 세션과 활동 시각은 유지한다.
      if (account && account.status !== 'active')
        return { outcome: 'unavailable' };
      // 처음 증명된 지갑은 자동 가입하며, 기존 쿠키의 사용자를 계정 연결에 사용하지 않는다.
      account ??= await this.accounts.create(identity, time, transaction);
      await this.accounts.recordLogin(account, time, transaction);
      // 독립 세션을 발급하고 제출된 이전 토큰만 폐기한다. 어느 쓰기든 실패하면 모두 롤백한다.
      const token = randomBytes(32).toString('base64url');
      const session = await this.sessions.create(
        account.id,
        hashAuthSecret(token),
        time,
        transaction,
      );
      if (previousHash)
        await this.sessions.revokeSubmitted(previousHash, transaction);
      const wallets = await this.accounts.listWallets(account.id, transaction);
      const sessionExpiryDeadline = await this.sessions.sessionExpiryDeadline(
        session.expiresAt,
        transaction,
      );
      return {
        outcome: 'authenticated',
        token,
        sessionExpiryDeadline,
        user: {
          id: account.id,
          displayName: account.displayName,
          avatarUrl: account.avatarUrl,
          wallets,
        },
        session,
      };
    });
  }
}
