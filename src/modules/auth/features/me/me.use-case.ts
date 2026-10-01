import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../resources/session/session-authenticator';
import { isAuthSecret } from '../../resources/auth-secret/auth-secret';
import {
  SessionRepository,
  type SessionLifetime,
} from '../../resources/session/session.repository';
import { WalletAccountRepository } from '../../resources/wallet-account/wallet-account.repository';

export type MeResult =
  | Readonly<{ outcome: 'invalid' | 'unavailable' }>
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
      session: SessionLifetime;
    }>;

@Injectable()
export class MeUseCase {
  constructor(
    private readonly accounts: WalletAccountRepository,
    private readonly sessions: SessionRepository,
    private readonly transactions: TransactionRunner,
    private readonly authenticator: SessionAuthenticator,
  ) {}

  /**
   * 현재 세션의 사용자를 조회하고 유효한 세션의 활동 만료만 연장한다.
   * HTTP 쿠키 변경은 확정된 업무 결과를 받은 컨트롤러가 처리한다.
   */
  async execute(token: string | undefined): Promise<MeResult> {
    // 형식이 틀리거나 토큰이 없는 요청은 DB 연결을 얻지 않고 기존 세션 오류 결과를 반환한다.
    if (!isAuthSecret(token)) return { outcome: 'invalid' };
    return this.transactions.run(async (transaction): Promise<MeResult> => {
      // 다른 세션 인증 기능과 같은 잠금·만료·계정 상태 판정을 적용한다.
      const authentication = await this.authenticator.authenticate(
        token,
        transaction,
      );
      if (authentication.outcome !== 'authenticated') return authentication;

      // 판정한 DB 시각으로만 연장하고, 뒤의 조회·커밋 실패는 이번 갱신을 함께 롤백한다.
      const session = await this.sessions.renew(
        authentication.sessionId,
        authentication.time,
        transaction,
      );
      if (!session) return { outcome: 'invalid' };
      const wallets = await this.accounts.listWallets(
        authentication.user.id,
        transaction,
      );
      const sessionExpiryDeadline = await this.sessions.sessionExpiryDeadline(
        session.expiresAt,
        transaction,
      );
      return {
        outcome: 'authenticated',
        token: authentication.token,
        sessionExpiryDeadline,
        user: {
          ...authentication.user,
          wallets,
        },
        session,
      };
    });
  }
}
