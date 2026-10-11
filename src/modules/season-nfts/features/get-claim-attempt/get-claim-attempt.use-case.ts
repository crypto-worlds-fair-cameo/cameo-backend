import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { ClaimRepository } from '../../resources/claim/claim.repository';

const RETRYABLE_ERRORS = new Set([
  'NFT_INSUFFICIENT_FUNDS',
  'NFT_TRANSACTION_FAILED',
  'NFT_TRANSACTION_EXPIRED',
]);
const PUBLIC_ATTEMPT_ERRORS = new Set([
  ...RETRYABLE_ERRORS,
  'NFT_CHAIN_CONFIGURATION_INVALID',
]);

export type ClaimAttemptView = Readonly<{
  attemptId: string;
  state: string;
  step: string;
  walletAddress: string;
  network: 'devnet' | 'mainnet-beta';
  transaction: null | Readonly<{
    transactionId: string;
    serializedTransactionBase64: string;
    lastValidBlockHeight: string;
    estimatedCostLamports: string;
    estimatedAt: string;
  }>;
  errorCode: string | null;
  retryable: boolean;
}>;

@Injectable()
export class GetClaimAttemptUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly claims: ClaimRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증 actor가 소유한 시도만 반환하고 유효한 PREPARED 거래 외의 bytes는 숨긴다. */
  async execute(
    token: string | undefined,
    seasonId: string,
    attemptId: string,
  ): Promise<ClaimAttemptView> {
    return this.transactions.run(async (transaction) => {
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
      const attempt = await this.claims.findOwnAttempt(
        seasonId,
        attemptId,
        {
          userId: authentication.user.id,
          walletAccountId: authentication.walletAccountId,
          walletAddress: authentication.walletAddress,
        },
        transaction,
      );
      if (!attempt) throw new BusinessError(ErrorCodes.NftClaimAttemptNotFound);
      const network = this.config.get('seasonNft.network', { infer: true });
      if (network !== 'devnet' && network !== 'mainnet-beta') {
        throw new BusinessError(ErrorCodes.NftServiceUnavailable);
      }
      // 다른 network의 존재도 wrong-season과 같은 404로 감춰 거래 자료를 노출하지 않는다.
      if (attempt.network !== network) {
        throw new BusinessError(ErrorCodes.NftClaimAttemptNotFound);
      }
      const terminal =
        attempt.state === 'FAILED' || attempt.state === 'EXPIRED';
      const publicState =
        attempt.state === 'AWAITING_SIGNATURE' && !attempt.transaction
          ? 'CONFIRMING'
          : attempt.state;
      const errorCode = terminal
        ? attempt.state === 'EXPIRED'
          ? 'NFT_TRANSACTION_EXPIRED'
          : attempt.errorCode && PUBLIC_ATTEMPT_ERRORS.has(attempt.errorCode)
            ? attempt.errorCode
            : 'NFT_CHAIN_CONFIGURATION_INVALID'
        : null;
      return {
        attemptId: attempt.attemptId,
        state: publicState,
        step: attempt.step,
        walletAddress: attempt.walletAddress,
        network: attempt.network,
        transaction: attempt.transaction
          ? {
              transactionId: attempt.transaction.transactionId,
              serializedTransactionBase64:
                attempt.transaction.serializedTransaction.toString('base64'),
              lastValidBlockHeight:
                attempt.transaction.lastValidBlockHeight.toString(),
              estimatedCostLamports:
                attempt.transaction.estimatedCostLamports.toString(),
              estimatedAt: attempt.transaction.estimatedAt.toISOString(),
            }
          : null,
        errorCode,
        retryable:
          terminal && errorCode !== null && RETRYABLE_ERRORS.has(errorCode),
      };
    });
  }
}
