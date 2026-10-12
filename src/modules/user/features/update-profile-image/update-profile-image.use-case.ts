import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { LoggerService } from '../../../../logging/logger.service';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { inspectProfileImage } from '../../resources/profile-image/profile-image-format';
import {
  ProfileImageStorage,
  type StoredProfileImage,
} from '../../resources/profile-image/profile-image.storage';
import { ProfileRepository } from '../../resources/profile/profile.repository';

@Injectable()
export class UpdateProfileImageUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly profiles: ProfileRepository,
    private readonly storage: ProfileImageStorage,
    private readonly transactions: TransactionRunner,
    private readonly logger: LoggerService,
  ) {}

  /**
   * 현재 세션 사용자의 프로필 사진을 바꾼다. 매번 새 파일 이름을 써서 공개 주소를 오래 캐시할 수 있게 하고,
   * DB 변경이 끝난 뒤에만 이전 파일을 지워 실패한 변경이 기존 사진을 잃지 않게 한다.
   */
  async execute(
    origin: string | undefined,
    token: string | undefined,
    contentType: string | undefined,
    body: unknown,
  ): Promise<Readonly<{ id: string; avatarUrl: string }>> {
    // 쿠키를 사용하는 쓰기 요청이므로 출처를 확인하고, 저장소와 파일 형식을 DB 작업 전에 검사한다.
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    if (!this.storage.available)
      throw new BusinessError(ErrorCodes.UserProfileImageUnavailable);
    const bytes = Buffer.isBuffer(body) ? body : undefined;
    const format = bytes ? inspectProfileImage(bytes, contentType) : null;
    if (!bytes || !format)
      throw new BusinessError(ErrorCodes.UserProfileImageInvalid);

    const written: StoredProfileImage[] = [];
    let result: Readonly<{
      profile: Readonly<{ id: string; avatarUrl: string }>;
      replaced: StoredProfileImage | null;
    }>;
    try {
      result = await this.transactions.run(async (transaction) => {
        // 인증으로 잠근 사용자 행을 기준으로 파일을 쓰고 주소를 바꿔 동시 변경의 순서를 맞춘다.
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
        const userId = authentication.user.id;
        const saved = await this.storage.save(
          userId,
          randomUUID(),
          format,
          bytes,
        );
        written.push(saved);
        const profile = await this.profiles.updateAvatarUrl(
          userId,
          saved.url,
          authentication.time,
          transaction,
        );
        return {
          profile,
          replaced: this.storage.storedImage(
            userId,
            authentication.user.avatarUrl,
          ),
        };
      });
    } catch (error) {
      // DB에 반영하지 못한 새 파일은 남기지 않는다.
      for (const image of written) await this.removeQuietly(image);
      throw error;
    }
    if (result.replaced) await this.removeQuietly(result.replaced);
    return result.profile;
  }

  /** 파일 정리 실패는 이미 끝난 응답을 바꾸지 않고 운영 로그로만 남긴다. */
  private async removeQuietly(image: StoredProfileImage): Promise<void> {
    try {
      await this.storage.remove(image);
    } catch (error) {
      this.logger.warn('Profile image cleanup failed', {
        event: 'user.profile_image.cleanup_failed',
        url: image.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
