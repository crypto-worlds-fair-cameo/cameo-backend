import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { toSeasonNftView } from '../../../season-nfts/resources/season-nft/season-nft-view';
import type {
  SeasonNftClaimView,
  SeasonNftView,
} from '../../../season-nfts/resources/season-nft/season-nft-view';
import { getSeasonStatus } from '../../resources/season/season-state';
import type { SeasonStatus } from '../../resources/season/season-state';
import {
  ParticipatedSeasonsQuery,
  type ParticipatedSeasonRecord,
} from './participated-seasons.query';

export type ListParticipatedSeasonsInput = Readonly<{
  limit: number;
  offset: number;
}>;

export type ParticipatedSeasonItem = Readonly<{
  seasonId: string;
  title: string;
  lifecycleStatus: SeasonStatus;
  startsAt: string;
  endsAt: string;
  joinedAt: string;
  ownStrokeCount: number;
  finalImageUrl: string | null;
  nft: Readonly<
    Pick<SeasonNftView, 'network' | 'availability' | 'reason'> & {
      claim: SeasonNftClaimView;
    }
  >;
}>;

export type ParticipatedSeasonsPage = Readonly<{
  items: ParticipatedSeasonItem[];
  total: number;
  limit: number;
  offset: number;
}>;

@Injectable()
export class ListParticipatedSeasonsUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly query: ParticipatedSeasonsQuery,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증 사용자의 모든 시즌 참가 기록을 실제 total과 안정된 offset page로 반환한다. */
  async execute(
    token: string | undefined,
    input: ListParticipatedSeasonsInput,
  ): Promise<ParticipatedSeasonsPage> {
    return this.transactions.run(
      async (transaction) => {
        // 인증을 먼저 확정해 타인의 참가·wallet·claim을 조회 조건에 넣지 않는다.
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
        const network = this.config.get('seasonNft.network', { infer: true });
        if (network !== 'devnet' && network !== 'mainnet-beta') {
          throw new BusinessError(ErrorCodes.NftServiceUnavailable);
        }

        // count와 page는 같은 READ COMMITTED 트랜잭션에서 같은 사용자 조건으로 읽는다.
        const total = await this.query.count(
          authentication.user.id,
          transaction,
        );
        const records = await this.query.list(
          {
            userId: authentication.user.id,
            network,
            limit: input.limit,
            offset: input.offset,
          },
          transaction,
        );
        const enabled =
          this.config.get('seasonNft.enabled', { infer: true }) === true;
        const publicBaseUrl = this.config.get('canvasSnapshot.publicBaseUrl', {
          infer: true,
        });
        return {
          items: records.map((record) =>
            toItem(record, { enabled, network, publicBaseUrl }),
          ),
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
  record: ParticipatedSeasonRecord,
  options: Readonly<{
    enabled: boolean;
    network: 'devnet' | 'mainnet-beta';
    publicBaseUrl: string | undefined;
  }>,
): ParticipatedSeasonItem {
  const view = toSeasonNftView(record.nftSource, options);
  return {
    seasonId: record.seasonId,
    title: record.title,
    lifecycleStatus: getSeasonStatus(record, record.observedAt),
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    joinedAt: record.joinedAt.toISOString(),
    ownStrokeCount: record.ownStrokeCount,
    finalImageUrl:
      record.finalImageKey !== null && options.publicBaseUrl
        ? `${options.publicBaseUrl.replace(/\/+$/, '')}/${record.finalImageKey}`
        : null,
    nft: {
      network: view.network,
      availability: view.availability,
      reason: view.reason,
      claim: view.claim,
    },
  };
}
