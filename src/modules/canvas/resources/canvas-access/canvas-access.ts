import { Injectable } from '@nestjs/common';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { isAuthSecret } from '../../../auth/resources/auth-secret/auth-secret';
import {
  authCookies,
  readAuthCookie,
} from '../../../auth/resources/auth-cookie/auth-http';
import { ConfigService } from '@nestjs/config';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { CanvasStrokeError } from '../canvas-stroke/canvas-stroke';

/** 소켓 handshake 쿠키를 기존 AuthModule의 세션 규칙으로 인증한다. */
@Injectable()
export class CanvasAccess {
  private readonly cookieName: string;
  constructor(
    config: ConfigService,
    private readonly authenticator: SessionAuthenticator,
    private readonly transactions: TransactionRunner,
  ) {
    this.cookieName = authCookies(config.getOrThrow('app.nodeEnv')).sessionName;
  }

  token(cookieHeader: string | undefined): string | undefined {
    return readAuthCookie(cookieHeader, this.cookieName);
  }

  /** 접속 상태는 안내 값이며, 실제 획의 시작과 완료에서 세션을 다시 확인한다. */
  async viewer(cookieHeader: string | undefined): Promise<{
    viewer:
      | { status: 'guest'; userId: null }
      | { status: 'authenticated'; userId: string };
    canDraw: boolean;
  }> {
    const token = this.token(cookieHeader);
    if (!isAuthSecret(token))
      return { viewer: { status: 'guest', userId: null }, canDraw: false };
    return this.transactions.run(async (transaction) => {
      const result = await this.authenticator.authenticate(token, transaction);
      // 유효하지 않은 쿠키는 관람 접속을 막지 않는다.
      if (result.outcome !== 'authenticated')
        return { viewer: { status: 'guest', userId: null }, canDraw: false };
      return {
        viewer: { status: 'authenticated', userId: result.user.id },
        canDraw: true,
      };
    });
  }

  /** 시작과 완료 전송에서만 기존 세션을 다시 확인하고 인증된 사용자 ID를 반환한다. */
  async authenticate(
    token: string | undefined,
    transaction?: TransactionContext,
  ): Promise<string> {
    // 쿠키가 없거나 형식이 틀리면 DB 트랜잭션을 열지 않고 거절한다.
    if (!isAuthSecret(token))
      throw new CanvasStrokeError(
        'AUTH_REQUIRED',
        'Authentication is required.',
      );
    const authenticate = async (
      context: TransactionContext,
    ): Promise<string> => {
      const result = await this.authenticator.authenticate(token, context);
      if (result.outcome !== 'authenticated')
        throw new CanvasStrokeError(
          result.outcome === 'unavailable'
            ? 'USER_UNAVAILABLE'
            : 'AUTH_REQUIRED',
          result.outcome === 'unavailable'
            ? 'User is unavailable.'
            : 'Authentication is required.',
        );
      return result.user.id;
    };
    // 첫 좌표의 인증과 획 차감은 같은 사용자 잠금을 유지하며 함께 커밋한다.
    return transaction
      ? authenticate(transaction)
      : this.transactions.run(authenticate);
  }
}
