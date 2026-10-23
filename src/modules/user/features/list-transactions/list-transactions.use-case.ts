import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';
import { TransactionsQuery } from './transactions.query';

export type TransactionItem = Readonly<{
  id: string;
  type: 'season_entry';
  direction: 'outgoing' | 'incoming';
  seasonId: string;
  seasonTitle: string;
  lamports: string;
  network: SeasonNftNetwork;
  signature: string;
  occurredAt: string;
}>;

export type TransactionsPage = Readonly<{
  items: TransactionItem[];
  total: number;
  limit: number;
  offset: number;
}>;

@Injectable()
export class ListTransactionsUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly query: TransactionsQuery,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증 사용자가 보내거나 받은 확정 SOL 거래를 최신순 offset page로 반환한다. */
  async execute(
    token: string | undefined,
    input: Readonly<{ limit: number; offset: number }>,
  ): Promise<TransactionsPage> {
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
        // 잔액과 같은 network의 거래만 보여 준다. network 설정이 없으면 저장된 기록을 모두 보여 준다.
        const network = this.config.get('seasonNft.network', { infer: true });
        const filter = {
          userId: authentication.user.id,
          network:
            network === 'devnet' || network === 'mainnet-beta' ? network : null,
        };
        const total = await this.query.count(filter, transaction);
        const records = await this.query.list(
          { ...filter, limit: input.limit, offset: input.offset },
          transaction,
        );
        return {
          items: records.map((record) => ({
            ...record,
            type: 'season_entry' as const,
            occurredAt: record.occurredAt.toISOString(),
          })),
          total,
          limit: input.limit,
          offset: input.offset,
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
