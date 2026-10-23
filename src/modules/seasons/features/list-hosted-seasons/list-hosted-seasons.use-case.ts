import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { getSeasonStatus } from '../../resources/season/season-state';
import type { SeasonStatus } from '../../resources/season/season-state';
import {
  HostedSeasonsQuery,
  type HostedSeasonRecord,
} from './hosted-seasons.query';

export type ListHostedSeasonsInput = Readonly<{
  limit: number;
  offset: number;
}>;

export type HostedSeasonItem = Readonly<{
  seasonId: string;
  title: string;
  lifecycleStatus: SeasonStatus;
  startsAt: string;
  endsAt: string;
  participantCount: number;
  finalImageUrl: string | null;
}>;

export type HostedSeasonsPage = Readonly<{
  items: HostedSeasonItem[];
  total: number;
  limit: number;
  offset: number;
}>;

@Injectable()
export class ListHostedSeasonsUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly query: HostedSeasonsQuery,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증 사용자가 개설한 시즌을 실제 total과 안정된 offset page로 반환한다. */
  async execute(
    token: string | undefined,
    input: ListHostedSeasonsInput,
  ): Promise<HostedSeasonsPage> {
    return this.transactions.run(
      async (transaction) => {
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
        if (
          !Number.isSafeInteger(input.limit) ||
          input.limit < 1 ||
          input.limit > 50 ||
          !Number.isSafeInteger(input.offset) ||
          input.offset < 0 ||
          !Number.isSafeInteger(input.offset + input.limit)
        ) {
          throw new BusinessError(ErrorCodes.BadRequest);
        }

        // count와 page는 같은 READ COMMITTED 트랜잭션에서 같은 개설자 조건으로 읽는다.
        const total = await this.query.count(
          authentication.user.id,
          transaction,
        );
        const records = await this.query.list(
          {
            userId: authentication.user.id,
            limit: input.limit,
            offset: input.offset,
          },
          transaction,
        );
        const publicBaseUrl = this.config.get('canvasSnapshot.publicBaseUrl', {
          infer: true,
        });
        return {
          items: records.map((record) => toItem(record, publicBaseUrl)),
          total,
          limit: input.limit,
          offset: input.offset,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}

function toItem(
  record: HostedSeasonRecord,
  publicBaseUrl: string | undefined,
): HostedSeasonItem {
  return {
    seasonId: record.seasonId,
    title: record.title,
    lifecycleStatus: getSeasonStatus(record, record.observedAt),
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    participantCount: record.participantCount,
    finalImageUrl:
      record.finalImageKey !== null && publicBaseUrl
        ? `${publicBaseUrl.replace(/\/+$/, '')}/${record.finalImageKey}`
        : null,
  };
}
