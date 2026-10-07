import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import {
  getSeasonStatus,
  toSeasonDetail,
  type SeasonDetail,
} from '../../resources/season/season';
import { SeasonRepository } from '../../resources/season/season.repository';

@Injectable()
export class JoinSeasonUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly seasons: SeasonRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 진행 중인 시즌에 사용자를 한 번 등록하고, 재요청에는 최신 참가 상태를 반환한다. */
  async execute(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
  ): Promise<SeasonDetail> {
    // 쿠키를 사용하는 쓰기 요청이므로 DB 작업 전에 허용된 브라우저 출처인지 확인한다.
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );

    return this.transactions.run(
      async (transaction) => {
        // 사용자·세션 잠금을 먼저 얻어 같은 사용자의 중복 참가 요청을 직렬화한다.
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

        // 시즌 행 잠금으로 서로 다른 사용자의 마지막 자리 경합도 직렬화한다.
        const season = await this.seasons.lockById(seasonId, transaction);
        if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);

        // 취소 사실은 개설자에게만 공개하며 참가 여부보다 먼저 검사한다.
        if (
          season.cancelledAt !== null &&
          season.creatorId !== authentication.user.id
        ) {
          throw new BusinessError(ErrorCodes.SeasonNotFound);
        }

        // 시즌 잠금 뒤 최신 참가자 수와 현재 사용자의 참가 여부를 별도 SQL로 읽는다.
        const participation = await this.seasons.readParticipation(
          season.id,
          authentication.user.id,
          transaction,
        );
        const time = await this.seasons.getCurrentTime(transaction);

        // 기존 참가자는 현재 상태나 정원과 관계없이 참가 기록을 추가하지 않고 성공한다.
        if (participation.isParticipant) {
          return toSeasonDetail(
            { ...season, participantCount: participation.participantCount },
            time,
            { userId: authentication.user.id, isParticipant: true },
          );
        }

        // 신규 참가자는 판정 시각에 진행 중이어야 하며 빈자리가 있어야 한다.
        if (getSeasonStatus(season, time) !== 'active') {
          throw new BusinessError(ErrorCodes.SeasonStateConflict);
        }
        if (participation.participantCount >= season.capacity) {
          throw new BusinessError(ErrorCodes.SeasonCapacityReached);
        }

        await this.seasons.addParticipant(
          season.id,
          authentication.user.id,
          time,
          transaction,
        );

        // INSERT 뒤 같은 트랜잭션에서 상세를 다시 읽어 최신 참가 인원을 응답에 넣는다.
        const joinedSeason = await this.seasons.findById(
          season.id,
          transaction,
        );
        if (!joinedSeason) throw new Error('Joined season is missing.');
        return toSeasonDetail(joinedSeason, time, {
          userId: authentication.user.id,
          isParticipant: true,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
}
