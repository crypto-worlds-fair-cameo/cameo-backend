import { Injectable } from '@nestjs/common';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import {
  hashAuthSecret,
  isAuthSecret,
} from '../../resources/auth-secret/auth-secret';
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
  ) {}

  /**
   * 현재 세션의 사용자를 조회하고 유효한 세션의 활동 만료만 연장한다.
   * HTTP 쿠키 변경은 확정된 업무 결과를 받은 컨트롤러가 처리한다.
   */
  async execute(token: string | undefined): Promise<MeResult> {
    // 형식이 틀린 값은 DB에 보내지 않는다. 예비 조회는 잠금 순서를 정하는 데만 쓴다.
    if (!isAuthSecret(token)) return { outcome: 'invalid' };
    const tokenHash = hashAuthSecret(token);
    const userId = await this.sessions.findOwner(tokenHash);
    if (!userId) return { outcome: 'invalid' };

    return this.transactions.run(async (transaction): Promise<MeResult> => {
      // 로그인과 같은 사용자 후 세션 순서를 지켜 두 요청이 반대 순서로 기다리지 않게 한다.
      const account = await this.accounts.lockUserById(userId, transaction);
      if (!account) return { outcome: 'invalid' };
      const sessionId = await this.sessions.lockForAuthentication(
        tokenHash,
        userId,
        transaction,
      );
      if (!sessionId) return { outcome: 'invalid' };

      // 잠금 대기 중 만료·폐기·정지된 상태를 다시 확인한다. 실패하면 어떤 행도 바꾸지 않는다.
      const state = await this.sessions.inspectAtCurrentTime(
        sessionId,
        transaction,
      );
      if (!state?.usable) return { outcome: 'invalid' };
      if (account.status !== 'active') return { outcome: 'unavailable' };

      // 판정한 DB 시각으로만 연장하고, 뒤의 조회·커밋 실패는 이번 갱신을 함께 롤백한다.
      const session = await this.sessions.renew(
        sessionId,
        state.time,
        transaction,
      );
      if (!session) return { outcome: 'invalid' };
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
