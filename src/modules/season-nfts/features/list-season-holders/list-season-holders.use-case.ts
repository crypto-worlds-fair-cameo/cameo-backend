import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import type { SeasonNftNetwork } from '../../resources/season-nft/season-nft';
import { ListSeasonHoldersQuery } from './list-season-holders.query';

export const MAX_SEASON_HOLDERS_LIMIT = 50;
export const MAX_SEASON_HOLDERS_SEARCH_LENGTH = 50;

export type ListSeasonHoldersInput = Readonly<{
  seasonId: string;
  page: number;
  limit: number;
  search?: string;
}>;

export type SeasonHoldersPage = Readonly<{
  items: Readonly<{
    displayName: string | null;
    walletAddress: string;
    amount: number | null;
  }>[];
  page: number;
  limit: number;
  total: number;
  collection: Readonly<{ network: SeasonNftNetwork; address: string }> | null;
}>;

/** LIKE 특수문자를 글자 그대로 비교하도록 이스케이프해 부분 일치 패턴을 만든다. */
function toSearchPattern(search: string | undefined): string | null {
  const trimmed = search?.trim() ?? '';
  if (!trimmed) return null;
  return `%${trimmed.replace(/[\\%_]/g, '\\$&')}%`;
}

@Injectable()
export class ListSeasonHoldersUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly query: ListSeasonHoldersQuery,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 시즌을 볼 수 있는 사용자에게 목록 대상 참가자와 현재 network의 NFT 수령 수량을 반환한다. */
  async execute(
    token: string | undefined,
    input: ListSeasonHoldersInput,
  ): Promise<SeasonHoldersPage> {
    // HTTP 외 호출도 같은 범위를 벗어나면 DB 조회 전에 거절한다.
    if (
      !Number.isSafeInteger(input.page) ||
      input.page < 1 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_SEASON_HOLDERS_LIMIT ||
      (input.search?.length ?? 0) > MAX_SEASON_HOLDERS_SEARCH_LENGTH
    ) {
      throw new BusinessError(ErrorCodes.BadRequest);
    }
    // network가 설정되지 않은 환경은 수령 기록을 다른 network로 추론하지 않고 모두 미발급으로 본다.
    const configured = this.config.get('seasonNft.network', { infer: true });
    const network =
      configured === 'devnet' || configured === 'mainnet-beta'
        ? configured
        : null;

    return this.transactions.run(
      async (transaction) => {
        // 잘못되거나 사용할 수 없는 쿠키는 공개 조회를 막지 않는다.
        const authentication = await this.authenticator.authenticate(
          token,
          transaction,
        );
        const source = await this.query.find(
          {
            seasonId: input.seasonId,
            userId:
              authentication.outcome === 'authenticated'
                ? authentication.user.id
                : undefined,
            network,
            searchPattern: toSearchPattern(input.search),
            limit: input.limit,
            offset: (input.page - 1) * input.limit,
          },
          transaction,
        );
        // 없거나 볼 수 없는 시즌은 같은 404로 존재를 숨긴다.
        if (!source) throw new BusinessError(ErrorCodes.SeasonNotFound);

        return {
          items: source.records.map((record) => ({
            displayName: record.displayName,
            walletAddress: record.walletAddress,
            // 시즌 NFT는 참가자당 하나만 발급한다.
            amount: record.claimed ? 1 : null,
          })),
          page: input.page,
          limit: input.limit,
          total: source.total,
          collection:
            network && source.collectionAddress
              ? { network, address: source.collectionAddress }
              : null,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
