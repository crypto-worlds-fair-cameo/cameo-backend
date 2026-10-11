import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { toSeasonNftView } from '../../resources/season-nft/season-nft-view';
import type { SeasonNftView } from '../../resources/season-nft/season-nft-view';
import { GetSeasonNftQuery } from './get-season-nft.query';

@Injectable()
export class GetSeasonNftUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly query: GetSeasonNftQuery,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증 사용자에게 현재 network의 DB 상태만으로 시즌 NFT 조회 결과를 반환한다. */
  async execute(
    token: string | undefined,
    seasonId: string,
  ): Promise<SeasonNftView> {
    return this.transactions.run(
      async (transaction) => {
        // 설정 오류나 시즌 존재 여부보다 세션 판정을 먼저 적용해 인증 경계를 유지한다.
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

        // network가 없으면 DB 행을 다른 network로 추론하지 않고 공개 설정 오류를 반환한다.
        const network = this.config.get('seasonNft.network', { infer: true });
        if (network !== 'devnet' && network !== 'mainnet-beta') {
          throw new BusinessError(ErrorCodes.NftServiceUnavailable);
        }
        const source = await this.query.find(
          seasonId,
          authentication.user.id,
          network,
          transaction,
        );
        if (!source) throw new BusinessError(ErrorCodes.SeasonNotFound);

        return toSeasonNftView(source, {
          enabled:
            this.config.get('seasonNft.enabled', { infer: true }) === true,
          network,
        });
      },
      { isolationLevel: 'read committed' },
    );
  }
}
