import { Injectable } from '@nestjs/common';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { publicKey } from '@metaplex-foundation/umi';
import * as candy from '@metaplex-foundation/mpl-core-candy-machine';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { ClaimRepository } from '../../resources/claim/claim.repository';
import { withDbOnlyRetry } from '../../resources/nft-worker/db-only-retry';
import type { NftRpcScheduler } from '../../resources/nft-worker/rpc-scheduler';
import { NftClaimReconciliation } from '../../resources/nft-worker/nft-runtime-queue';
import { SeasonNftRpcTransport } from '../../resources/solana-nft/season-release-chain';

const CANDY_GUARD_PROGRAM_ID = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';

/** dispatcher 상태와 finalized PDA 효과를 결합해 attempt/claim을 단조 진행한다. */
@Injectable()
export class ReconcileNftTransactionsUseCase extends NftClaimReconciliation {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly claims: ClaimRepository,
    private readonly transport: SeasonNftRpcTransport,
    private readonly transactions: TransactionRunner,
  ) {
    super();
  }

  async execute(
    transactionIds: readonly string[],
    scheduler: NftRpcScheduler,
  ): Promise<void> {
    const sources = await this.claims.findReconciliationSources(transactionIds);
    const endpoint =
      this.config.get('seasonNft.rpcUrl', { infer: true }) ??
      'http://127.0.0.1:8899';
    const umi = createUmi(endpoint).use(candy.mplCandyMachine());
    for (const source of sources) {
      if (
        source.transactionState === 'SIGNED' ||
        source.transactionState === 'SUBMITTED' ||
        source.transactionState === 'CONFIRMED'
      ) {
        await withDbOnlyRetry(() =>
          this.transactions.run((transaction) =>
            this.claims.markAttemptConfirming(
              { claimId: source.claimId, attemptId: source.attemptId },
              transaction,
            ),
          ),
        );
        continue;
      }
      if (
        source.transactionState === 'FAILED' ||
        source.transactionState === 'EXPIRED'
      ) {
        await withDbOnlyRetry(() =>
          this.transactions.run((transaction) =>
            this.claims.failAttempt(
              {
                claimId: source.claimId,
                attemptId: source.attemptId,
                expectedState: source.attemptState,
                state:
                  source.transactionState === 'EXPIRED' ? 'EXPIRED' : 'FAILED',
                errorCode:
                  source.transactionState === 'EXPIRED'
                    ? 'NFT_TRANSACTION_EXPIRED'
                    : 'NFT_TRANSACTION_FAILED',
              },
              transaction,
            ),
          ),
        );
        continue;
      }
      if (
        source.transactionState !== 'FINALIZED' &&
        source.transactionState !== 'RECONCILED'
      ) {
        continue;
      }
      const user = publicKey(source.walletAddress);
      const candyGuard = publicKey(source.candyGuardAddress);
      const candyMachine = publicKey(source.candyMachineAddress);
      const address =
        source.kind === 'USER_PROOF'
          ? String(
              candy.findAllowListProofPda(umi, {
                merkleRoot: source.merkleRoot,
                user,
                candyGuard,
                candyMachine,
              })[0],
            )
          : String(
              candy.findMintCounterPda(umi, {
                id: 0,
                user,
                candyGuard,
                candyMachine,
              })[0],
            );
      const observed = await scheduler.enqueue({
        kind: 'USER_CHECK',
        rpcType: 'READ',
        run: (signal) => this.transport.getAccounts([address], signal),
      });
      const account = observed.accounts[0];
      if (!account.exists || String(account.owner) !== CANDY_GUARD_PROGRAM_ID) {
        continue;
      }
      if (source.kind === 'USER_PROOF') {
        candy.deserializeAllowListProof(account);
        await withDbOnlyRetry(() =>
          this.transactions.run((transaction) =>
            this.claims.advanceAttemptToMint(
              { claimId: source.claimId, attemptId: source.attemptId },
              transaction,
            ),
          ),
        );
        continue;
      }
      if (candy.deserializeMintCounter(account).count < 1) continue;
      await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.claims.completeClaim(
            {
              claimId: source.claimId,
              attemptId: source.attemptId,
              receiptState: 'RESOLVING',
              ...(source.assetAddress
                ? { assetAddress: source.assetAddress }
                : {}),
            },
            transaction,
          ),
        ),
      );
    }
  }
}
