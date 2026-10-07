import { Injectable } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import {
  toSeasonDetail,
  type SeasonDetail,
} from '../../resources/season/season';
import {
  SeasonRepository,
  type SeasonListStatus,
} from '../../resources/season/season.repository';

export type ListSeasonsInput = Readonly<{
  page: number;
  limit: number;
  status?: SeasonListStatus;
}>;

export type SeasonListPage = Readonly<{
  items: SeasonDetail[];
  page: number;
  limit: number;
  hasNext: boolean;
}>;

@Injectable()
export class ListSeasonsUseCase {
  constructor(
    private readonly authenticator: SessionAuthenticator,
    private readonly seasons: SeasonRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 공개 시즌을 안정된 최신순으로 페이지 조회하고 선택 세션의 참가 정보를 배치 반영한다. */
  async execute(
    token: string | undefined,
    input: ListSeasonsInput,
  ): Promise<SeasonListPage> {
    const offset = this.offset(input);

    return this.transactions.run(async (transaction) => {
      // 잘못되거나 사용할 수 없는 쿠키는 목록 조회를 막지 않으며 세션 활동도 갱신하지 않는다.
      const authentication = await this.authenticator.authenticate(
        token,
        transaction,
      );
      const userId =
        authentication.outcome === 'authenticated'
          ? authentication.user.id
          : undefined;

      // SQL 상태 필터와 모든 응답 item의 상태·동작 플래그에 같은 DB 시각을 사용한다.
      const time = await this.seasons.getCurrentTime(transaction);
      const records = await this.seasons.list(
        {
          now: time,
          status: input.status,
          limit: input.limit,
          offset,
        },
        transaction,
      );
      const pageRecords = records.slice(0, input.limit);
      const participatingIds = userId
        ? await this.seasons.findParticipatingIds(
            userId,
            pageRecords.map((season) => season.id),
            transaction,
          )
        : new Set<string>();

      return {
        items: pageRecords.map((season) =>
          toSeasonDetail(season, time, {
            userId,
            isParticipant: participatingIds.has(season.id),
          }),
        ),
        page: input.page,
        limit: input.limit,
        hasNext: records.length > input.limit,
      };
    });
  }

  private offset(input: ListSeasonsInput): number {
    const validStatus =
      input.status === undefined ||
      input.status === 'scheduled' ||
      input.status === 'active' ||
      input.status === 'ended';
    const offset = (input.page - 1) * input.limit;
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !validStatus ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(offset + input.limit + 1)
    ) {
      throw new BusinessError(ErrorCodes.BadRequest);
    }
    return offset;
  }
}
