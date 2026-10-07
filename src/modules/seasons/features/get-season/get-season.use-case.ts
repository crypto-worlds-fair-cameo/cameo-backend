import { Injectable } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import {
  toSeasonDetail,
  type SeasonDetail,
} from '../../resources/season/season';
import { SeasonRepository } from '../../resources/season/season.repository';

@Injectable()
export class GetSeasonUseCase {
  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly seasons: SeasonRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 공개 시즌을 조회하고, 유효한 선택 세션이 있으면 사용자별 권한 정보를 더한다. */
  async execute(
    token: string | undefined,
    seasonId: string,
  ): Promise<SeasonDetail> {
    return this.transactions.run(async (transaction) => {
      // 잘못되거나 사용할 수 없는 쿠키는 공개 조회를 막지 않으며 세션 활동도 갱신하지 않는다.
      const authentication = await this.authenticator.authenticate(
        token,
        transaction,
      );
      const userId =
        authentication.outcome === 'authenticated'
          ? authentication.user.id
          : undefined;

      const season = await this.seasons.findById(seasonId, transaction);
      if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
      // 취소 시즌은 개설자만 조회할 수 있고, 나머지 사용자에게는 존재도 공개하지 않는다.
      if (season.cancelledAt !== null && season.creatorId !== userId) {
        throw new BusinessError(ErrorCodes.SeasonNotFound);
      }

      // 하나의 DB 시각으로 상태와 가능한 동작을 함께 계산해 경계에서 응답이 엇갈리지 않게 한다.
      const time = await this.seasons.getCurrentTime(transaction);
      const isParticipant = userId
        ? (
            await this.seasons.findParticipatingIds(
              userId,
              [season.id],
              transaction,
            )
          ).has(season.id)
        : false;
      return toSeasonDetail(season, time, { userId, isParticipant });
    });
  }
}
