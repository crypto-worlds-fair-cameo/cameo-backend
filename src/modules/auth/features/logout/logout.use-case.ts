import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../resources/auth-origin/auth-origin';
import {
  hashAuthSecret,
  isAuthSecret,
} from '../../resources/auth-secret/auth-secret';
import { SessionRepository } from '../../resources/session/session.repository';

@Injectable()
export class LogoutUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly sessions: SessionRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * 허용된 출처에서 제출한 정규 세션 토큰 하나를 폐기한다.
   * 토큰이 없거나 형식이 잘못됐으면 DB를 사용하지 않고 성공하며, DB 오류는 호출자에게 전파한다.
   */
  async execute(
    origin: string | undefined,
    token: string | undefined,
  ): Promise<void> {
    // 쿠키가 없거나 잘못됐어도 비허용 출처가 성공하지 않도록 출처를 먼저 검증한다.
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    if (!isAuthSecret(token)) return;
    const tokenHash = hashAuthSecret(token);

    // 저장소 변경과 커밋이 모두 성공한 뒤에만 컨트롤러가 쿠키를 삭제할 수 있다.
    await this.transactions.run(async (transaction) => {
      await this.sessions.revokeSubmitted(tokenHash, transaction);
    });
  }
}
