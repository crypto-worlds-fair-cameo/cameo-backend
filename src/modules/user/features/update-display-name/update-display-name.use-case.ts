import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { ProfileRepository } from '../../resources/profile/profile.repository';

export const DISPLAY_NAME_MAX_LENGTH = 20;

@Injectable()
export class UpdateDisplayNameUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly profiles: ProfileRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 현재 세션 사용자의 닉네임을 설정·변경한다. 계정 ID는 클라이언트 입력으로 받지 않는다. */
  async execute(
    origin: string | undefined,
    token: string | undefined,
    displayName: string,
  ): Promise<Readonly<{ id: string; displayName: string }>> {
    // 쿠키를 사용하는 쓰기 요청이므로 출처를 확인하고, 공백 정리 후 길이 규칙을 적용한다.
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    const name = displayName.trim();
    const length = Array.from(name).length;
    // NUL 문자는 PostgreSQL 문자열에 저장할 수 없으므로 DB 오류 대신 입력 오류로 처리한다.
    if (length < 1 || length > DISPLAY_NAME_MAX_LENGTH || name.includes('\0'))
      throw new BusinessError(ErrorCodes.UserDisplayNameInvalid);

    return this.transactions.run(async (transaction) => {
      // 인증과 저장을 같은 트랜잭션에서 실행해 계정·세션 상태 변경과 순서를 맞춘다.
      const authentication = await this.authenticator.authenticate(
        token,
        transaction,
      );
      if (authentication.outcome !== 'authenticated') {
        throw new BusinessError(
          authentication.outcome === 'invalid'
            ? ErrorCodes.AuthSessionInvalid
            : ErrorCodes.AuthUserUnavailable,
        );
      }

      // 인증한 사용자만 갱신한다. 활동 만료와 로그인 시각은 닉네임 변경으로 갱신하지 않는다.
      return this.profiles.updateDisplayName(
        authentication.user.id,
        name,
        authentication.time,
        transaction,
      );
    });
  }
}
