import { Injectable } from '@nestjs/common';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { hashAuthSecret, isAuthSecret } from '../auth-secret/auth-secret';
import { WalletAccountRepository } from '../wallet-account/wallet-account.repository';
import { SessionRepository } from './session.repository';

export type SessionAuthenticationResult =
  | Readonly<{ outcome: 'invalid' | 'unavailable' }>
  | Readonly<{
      outcome: 'authenticated';
      token: string;
      sessionId: string;
      time: Date;
      user: Readonly<{
        id: string;
        displayName: string | null;
        avatarUrl: string | null;
      }>;
    }>;

/** AuthModule이 공개하는 세션 인증 기능. 호출자의 트랜잭션 동안 인증한 행 잠금을 유지한다. */
@Injectable()
export class SessionAuthenticator {
  constructor(
    private readonly accounts: WalletAccountRepository,
    private readonly sessions: SessionRepository,
  ) {}

  /** 세션 소유자와 유효성을 확인한다. 활동 만료를 연장하거나 쿠키를 변경하지 않는다. */
  async authenticate(
    token: string | undefined,
    transaction: TransactionContext,
  ): Promise<SessionAuthenticationResult> {
    // 예비 조회는 사용자 잠금을 얻는 데만 사용하며, 토큰 형식 오류는 DB에 보내지 않는다.
    if (!isAuthSecret(token)) return { outcome: 'invalid' };
    const tokenHash = hashAuthSecret(token);
    const userId = await this.sessions.findOwner(tokenHash, transaction);
    if (!userId) return { outcome: 'invalid' };

    // 로그인과 같은 사용자 후 세션 순서를 지켜 잠금 대기의 순환을 피한다.
    const account = await this.accounts.lockUserById(userId, transaction);
    if (!account) return { outcome: 'invalid' };
    const sessionId = await this.sessions.lockForAuthentication(
      tokenHash,
      userId,
      transaction,
    );
    if (!sessionId) return { outcome: 'invalid' };

    // 잠금을 모두 얻은 뒤 만료·폐기·계정 상태를 판정해 기다리는 동안의 변경도 반영한다.
    const state = await this.sessions.inspectAtCurrentTime(
      sessionId,
      transaction,
    );
    if (!state?.usable) return { outcome: 'invalid' };
    if (account.status !== 'active') return { outcome: 'unavailable' };

    return {
      outcome: 'authenticated',
      token,
      sessionId,
      time: state.time,
      user: {
        id: account.id,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
      },
    };
  }
}
