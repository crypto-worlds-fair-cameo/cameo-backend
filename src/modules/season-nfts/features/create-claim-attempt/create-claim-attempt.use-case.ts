import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { ClaimRepository } from '../../resources/claim/claim.repository';
import type { SeasonNftAttemptState } from '../../resources/season-nft/season-nft';

export type CreateClaimResult = Readonly<{
  attemptId: string | null;
  state: SeasonNftAttemptState | 'CLAIMED';
}>;

@Injectable()
export class CreateClaimAttemptUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly claims: ClaimRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증 세션의 고정 지갑 claim을 잠그고 하나의 활성 attempt만 생성하거나 재사용한다. */
  async execute(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
  ): Promise<Readonly<{ created: boolean; result: CreateClaimResult }>> {
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
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

        // 세션 이외의 actor 입력은 받지 않고 두 지갑 식별자까지 고정 claim과 비교한다.
        const network = this.config.get('seasonNft.network', { infer: true });
        if (network !== 'devnet' && network !== 'mainnet-beta') {
          throw new BusinessError(ErrorCodes.NftServiceUnavailable);
        }
        const actor = {
          userId: authentication.user.id,
          walletAccountId: authentication.walletAccountId,
          walletAddress: authentication.walletAddress,
        };
        const scope = await this.claims.findCreateScope(
          seasonId,
          network,
          actor,
          transaction,
        );
        if (!scope.seasonExists)
          throw new BusinessError(ErrorCodes.SeasonNotFound);
        if (scope.cancelled) {
          throw new BusinessError(ErrorCodes.NftSeasonUnavailable);
        }
        if (!scope.participant) {
          throw new BusinessError(ErrorCodes.NftNotEligible);
        }
        if (
          scope.participantWalletAccountId !== actor.walletAccountId ||
          scope.participantWalletAddress !== actor.walletAddress
        ) {
          throw new BusinessError(ErrorCodes.NftWalletMismatch);
        }
        if (
          scope.claimId &&
          (scope.claimWalletAccountId !== actor.walletAccountId ||
            scope.claimWalletAddress !== actor.walletAddress)
        ) {
          throw new BusinessError(ErrorCodes.NftWalletMismatch);
        }
        if (!scope.hasUsage) {
          throw new BusinessError(ErrorCodes.NftNotEligible);
        }
        // 완료와 기존 활성 시도는 기능 중지보다 먼저 반환해 재민팅과 상태 유실을 막는다.
        if (scope.claimState === 'CLAIMED') {
          return {
            created: false,
            result: { attemptId: null, state: 'CLAIMED' },
          };
        }
        if (scope.activeAttemptId && scope.activeAttemptState) {
          return {
            created: false,
            result: {
              attemptId: scope.activeAttemptId,
              state: scope.activeAttemptState,
            },
          };
        }
        if (this.config.get('seasonNft.enabled', { infer: true }) !== true) {
          throw new BusinessError(ErrorCodes.NftServiceUnavailable);
        }
        if (!scope.ended || scope.releaseState !== 'READY') {
          throw new BusinessError(ErrorCodes.NftNotReady);
        }
        if (!scope.claimId) {
          throw new BusinessError(ErrorCodes.NftNotEligible);
        }

        // getOrCreateAttempt가 claim row를 잠가 동시 요청도 같은 attempt로 수렴시킨다.
        const attempt = await this.claims.getOrCreateAttempt(
          { claimId: scope.claimId },
          transaction,
        );
        return {
          created: attempt.created,
          result:
            attempt.claimState === 'CLAIMED'
              ? { attemptId: null, state: 'CLAIMED' }
              : {
                  attemptId: attempt.attemptId,
                  state: attempt.attemptState!,
                },
        };
      },
      { isolationLevel: 'read committed' },
    );
  }
}
