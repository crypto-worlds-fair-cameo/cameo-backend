import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { NftTransactionRepository } from '../../resources/solana-nft/nft-transaction.repository';
import { validateSignedClaimTransaction } from '../../resources/solana-nft/signed-transaction-validator';

export type SubmitClaimInput = Readonly<{
  origin: string | undefined;
  token: string | undefined;
  seasonId: string;
  attemptId: string;
  transactionId: string;
  signedTransactionBase64: string;
}>;

export type SubmitClaimResult = Readonly<{
  accepted: boolean;
  attemptId: string;
  state: string;
  signature: string;
}>;

@Injectable()
export class SubmitClaimTransactionUseCase {
  private readonly logger = new Logger(SubmitClaimTransactionUseCase.name);
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly nftTransactions: NftTransactionRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 소유한 준비 거래만 검증하고 signed bytes를 commit한 결과를 반환한다. 외부 전송은 worker가 맡는다. */
  async execute(input: SubmitClaimInput): Promise<SubmitClaimResult> {
    assertAuthOrigin(
      input.origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    const prepared = await this.transactions.run(async (transaction) => {
      const authentication = await this.authenticate(input.token, transaction);
      const actor = {
        userId: authentication.user.id,
        walletAccountId: authentication.walletAccountId,
        walletAddress: authentication.walletAddress,
      };
      const owned = await this.nftTransactions.findOwnedClaimTransaction(
        {
          seasonId: input.seasonId,
          attemptId: input.attemptId,
          transactionId: input.transactionId,
          actor,
        },
        transaction,
      );
      if (!owned) throw new BusinessError(ErrorCodes.NftClaimAttemptNotFound);
      const network = this.config.get('seasonNft.network', { infer: true });
      if (network !== 'devnet' && network !== 'mainnet-beta') {
        throw new BusinessError(ErrorCodes.NftServiceUnavailable);
      }
      if (owned.network !== network) {
        throw new BusinessError(ErrorCodes.NftClaimAttemptNotFound);
      }
      return { owned, actor };
    });

    let validated;
    try {
      validated = validateSignedClaimTransaction({
        preparedBytes: prepared.owned.serializedTransaction,
        submittedBase64: input.signedTransactionBase64,
        expectedPayer: prepared.actor.walletAddress,
        expectedMessageHash: prepared.owned.messageHash,
      });
    } catch (error: unknown) {
      // 서명 bytes와 인증 정보 없이 고정된 검증 실패 사유만 기록해 지갑 호환성을 진단한다.
      this.logger.warn({
        event: 'season_nft.signature_rejected',
        transactionId: input.transactionId,
        reason:
          error instanceof Error &&
          error.message.startsWith('Signed transaction ')
            ? error.message
            : 'Transaction validation failed.',
      });
      throw new BusinessError(ErrorCodes.NftTransactionInvalid);
    }

    // 서명 검사 뒤 새 트랜잭션에서 세션과 row lock 상태를 다시 확인해 stale 검사를 commit하지 않는다.
    const accepted = await this.transactions.run(async (transaction) => {
      const authentication = await this.authenticate(input.token, transaction);
      return this.nftTransactions.acceptOwnedSigned(
        {
          seasonId: input.seasonId,
          attemptId: input.attemptId,
          transactionId: input.transactionId,
          actor: {
            userId: authentication.user.id,
            walletAccountId: authentication.walletAccountId,
            walletAddress: authentication.walletAddress,
          },
          expectedMessageHash: validated.messageHash,
          signedBytes: validated.signedBytes,
          signature: validated.signature,
        },
        transaction,
      );
    });
    if (accepted.outcome === 'NOT_FOUND') {
      throw new BusinessError(ErrorCodes.NftClaimAttemptNotFound);
    }
    if (accepted.outcome === 'EXPIRED') {
      throw new BusinessError(ErrorCodes.NftTransactionExpired);
    }
    if (accepted.outcome === 'INVALID_STATE') {
      throw new BusinessError(ErrorCodes.NftTransactionInvalidState);
    }
    return {
      accepted: accepted.outcome === 'ACCEPTED',
      attemptId: input.attemptId,
      state: accepted.attemptState,
      signature: accepted.signature,
    };
  }

  private async authenticate(
    token: string | undefined,
    transaction: Parameters<SessionAuthenticator['authenticate']>[1],
  ) {
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
    return authentication;
  }
}
