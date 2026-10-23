import { Injectable, Logger, Optional } from '@nestjs/common';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { PrepareSeasonNftUseCase } from '../../features/prepare-season-nft/prepare-season-nft.use-case';
import { SeasonNftCandidatesQuery } from '../../features/prepare-season-nft/season-nft-candidates.query';
import { ClaimRepository } from '../claim/claim.repository';
import { SeasonNftRepository } from '../season-nft/season-nft.repository';
import { NftTransactionRepository } from '../solana-nft/nft-transaction.repository';
import { NftTransactionDispatcher } from '../solana-nft/nft-transaction-dispatcher';
import { withDbOnlyRetry } from './db-only-retry';
import { NftWorkerQueue } from './nft-worker';
import { NftWorkerConfig } from './nft-worker-config';
import type { NftRpcJob, NftRpcScheduler } from './rpc-scheduler';

export abstract class NftReleaseChainOperationProvider {
  /** 06 provider는 한 job당 실제 RPC 호출 하나만 담은 다음 durable checkpoint 작업을 반환한다. */
  abstract next(releaseId: string): Promise<NftRpcJob<void> | null>;
}

export abstract class NftClaimBuildOperationProvider {
  /** 08 provider는 한 job당 실제 RPC 호출 하나만 담아 모든 호출이 shared limiter를 소비하게 한다. */
  abstract next(attemptId: string): Promise<NftRpcJob<void> | null>;

  /** 기존 단일-job provider를 유지하며 실제 provider는 여러 RPC를 각각 enqueue하도록 override한다. */
  async build(attemptId: string, scheduler: NftRpcScheduler): Promise<void> {
    const job = await this.next(attemptId);
    if (!job)
      throw new Error('Season NFT claim builder returned no operation.');
    await scheduler.enqueue({
      kind: 'USER_BUILD',
      rpcType: job.rpcType,
      run: job.run,
    });
  }
}

export type ReceiptLookupResult =
  | Readonly<{
      status: 'PENDING';
      retryAfterMs?: number;
      historyBefore?: string | null;
    }>
  | Readonly<{
      status: 'VERIFIED';
      assetAddress: string;
      mintSignature: string;
      claimedAt: Date;
    }>;

export type NftRetryReason =
  'TRANSIENT' | 'RATE_LIMITED' | 'SERVICE_BALANCE' | 'STORAGE_CREDITS';

/** 06/08 provider가 감지한 Retry-After와 운영 자금 상태를 runtime에 구조적으로 전달한다. */
export class NftOperationRetryError extends Error {
  constructor(
    message: string,
    readonly retry: Readonly<{
      reason: NftRetryReason;
      retryAfterMs?: number;
    }>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = NftOperationRetryError.name;
  }
}

/** deterministic provider 검증 실패를 release BLOCKED 또는 attempt FAILED로 영속화한다. */
export class NftOperationPermanentError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = NftOperationPermanentError.name;
  }
}

export abstract class NftClaimReceiptLookup {
  /** 08 provider는 counter가 이미 소진된 claim의 finalized receipt 조회 RPC 한 번만 수행한다. */
  abstract lookup(
    claimId: string,
    signal: AbortSignal,
  ): Promise<ReceiptLookupResult>;

  /** 기존 lookup을 한 READ request로 호환하며 실제 복구 provider는 요청마다 enqueue한다. */
  async resolve(
    claimId: string,
    scheduler: NftRpcScheduler,
  ): Promise<ReceiptLookupResult> {
    return scheduler.enqueue({
      kind: 'USER_CHECK',
      rpcType: 'READ',
      run: (signal) => this.lookup(claimId, signal),
    });
  }
}

export abstract class NftClaimReconciliation {
  abstract execute(
    transactionIds: readonly string[],
    scheduler: NftRpcScheduler,
  ): Promise<void>;
}

@Injectable()
export class UnavailableNftReleaseChainOperationProvider extends NftReleaseChainOperationProvider {
  async next(): Promise<never> {
    throw new Error('Season NFT release chain provider is unavailable.');
  }
}

@Injectable()
export class UnavailableNftClaimBuildOperationProvider extends NftClaimBuildOperationProvider {
  async next(): Promise<never> {
    throw new Error('Season NFT claim builder provider is unavailable.');
  }
}

@Injectable()
export class UnavailableNftClaimReceiptLookup extends NftClaimReceiptLookup {
  async lookup(): Promise<never> {
    throw new Error('Season NFT receipt lookup provider is unavailable.');
  }
}

const RETRY_BASE_MS = [5_000, 15_000, 60_000, 300_000, 900_000] as const;
const MAX_ACTIVE_STORAGE_WORK = 20;
const MAX_ACTIVE_USER_WORK = 100;

function nextRetryDelayMs(retryCount: number, retryAfterMs = 0): number {
  const base = RETRY_BASE_MS[Math.min(retryCount, RETRY_BASE_MS.length - 1)];
  const jitter = Math.floor(base * 0.2 * Math.random());
  return Math.max(base + jitter, retryAfterMs);
}

function retryAfter(error: unknown): number {
  if (!(error instanceof NftOperationRetryError)) return 0;
  const providerDelay = Math.max(0, error.retry.retryAfterMs ?? 0);
  return error.retry.reason === 'SERVICE_BALANCE' ||
    error.retry.reason === 'STORAGE_CREDITS'
    ? Math.max(300_000, providerDelay)
    : providerDelay;
}

/** due rows를 먼저 durable reschedule한 뒤 storage와 shared RPC lane에 bounded job으로 전달한다. */
@Injectable()
export class NftRuntimeQueue extends NftWorkerQueue {
  private readonly logger = new Logger(NftRuntimeQueue.name);
  private readonly activeReleases = new Set<string>();
  private readonly activeAttempts = new Set<string>();
  private readonly activeTransactions = new Set<string>();
  private readonly activeReceipts = new Set<string>();
  private readonly activeCandidates = new Set<string>();
  private reservedStorageWork = 0;
  private reservedUserWork = 0;

  constructor(
    private readonly config: NftWorkerConfig,
    private readonly releases: SeasonNftRepository,
    private readonly claims: ClaimRepository,
    private readonly nftTransactions: NftTransactionRepository,
    private readonly preparation: PrepareSeasonNftUseCase,
    private readonly candidates: SeasonNftCandidatesQuery,
    private readonly dispatcher: NftTransactionDispatcher,
    private readonly releaseChain: NftReleaseChainOperationProvider,
    private readonly claimBuilder: NftClaimBuildOperationProvider,
    private readonly receiptLookup: NftClaimReceiptLookup,
    private readonly transactions: TransactionRunner,
    @Optional()
    private readonly reconciliation?: NftClaimReconciliation,
  ) {
    super();
  }

  async scan(scheduler: NftRpcScheduler): Promise<void> {
    const runtime = this.config.read();
    if (!runtime.enabled || !runtime.network) return;
    const claimDurationMs = 15_000;
    // async DB 조회 전에 slot을 동기 예약해 1초/60초 scan이 겹쳐도 queue 상한을 넘지 않는다.
    const releaseCapacity = this.reserveStorageWork(MAX_ACTIVE_STORAGE_WORK);
    const userCapacity = this.reserveUserWork(MAX_ACTIVE_USER_WORK);
    const attemptLimit = Math.min(20, userCapacity);
    const receiptLimit = Math.min(20, userCapacity - attemptLimit);
    const transactionLimit = userCapacity - attemptLimit - receiptLimit;
    // 각 owner가 due time을 commit한 뒤 callback을 구성하므로 재시작은 DB에서 같은 identity를 복구한다.
    let releases;
    let attempts;
    let transactions;
    let receipts;
    let reconciliations;
    try {
      [releases, attempts, transactions, receipts] = await Promise.all([
        this.releases.claimDue({
          network: runtime.network,
          limit: releaseCapacity,
          claimDurationMs,
        }),
        this.claims.claimDueAttempts({
          network: runtime.network,
          limit: attemptLimit,
          claimDurationMs,
        }),
        this.nftTransactions.claimDue({
          network: runtime.network,
          limit: transactionLimit,
          claimDurationMs,
        }),
        this.claims.claimDueReceipts({
          network: runtime.network,
          limit: receiptLimit,
          claimDurationMs,
        }),
      ]);
      const reconciliationCapacity =
        userCapacity - attempts.length - transactions.length - receipts.length;
      reconciliations =
        reconciliationCapacity > 0 &&
        typeof this.claims.findPendingReconciliationTransactionIds ===
          'function'
          ? await this.claims.findPendingReconciliationTransactionIds(
              runtime.network,
              reconciliationCapacity,
            )
          : [];
    } catch (error: unknown) {
      this.releaseStorageWork(releaseCapacity);
      this.releaseUserWork(userCapacity);
      throw error;
    }
    this.releaseStorageWork(releaseCapacity - releases.length);
    this.releaseUserWork(
      userCapacity -
        attempts.length -
        transactions.length -
        receipts.length -
        reconciliations.length,
    );
    const work: Promise<unknown>[] = [];
    for (const release of releases) {
      if (this.activeReleases.has(release.releaseId)) {
        this.releaseStorageWork(1);
        continue;
      }
      this.activeReleases.add(release.releaseId);
      if (
        release.state === 'WAITING_SNAPSHOT' ||
        release.stage === 'FROZEN' ||
        release.stage === 'IMAGE'
      ) {
        work.push(
          scheduler
            .enqueueStorage(async (io) => {
              if (release.state === 'WAITING_SNAPSHOT')
                await this.preparation.execute(release.seasonId);
              else await this.preparation.prepareMedia(release.releaseId, io);
            })
            .catch((error: unknown) =>
              this.persistReleaseFailure(release, error),
            )
            .finally(() => {
              this.activeReleases.delete(release.releaseId);
              this.releaseStorageWork(1);
            }),
        );
      } else {
        work.push(
          this.enqueueReleaseChain(scheduler, release).finally(() => {
            this.activeReleases.delete(release.releaseId);
            this.releaseStorageWork(1);
          }),
        );
      }
    }
    for (const attempt of attempts) {
      if (this.activeAttempts.has(attempt.attemptId)) {
        this.releaseUserWork(1);
        continue;
      }
      this.activeAttempts.add(attempt.attemptId);
      work.push(
        this.enqueueClaimBuild(scheduler, attempt).finally(() => {
          this.activeAttempts.delete(attempt.attemptId);
          this.releaseUserWork(1);
        }),
      );
    }

    const terminalReconciliations = reconciliations.filter((id) => {
      if (this.activeTransactions.has(id)) {
        this.releaseUserWork(1);
        return false;
      }
      this.activeTransactions.add(id);
      return true;
    });
    if (terminalReconciliations.length > 0) {
      const recovered = this.reconciliation
        ? this.reconciliation.execute(terminalReconciliations, scheduler)
        : Promise.resolve();
      work.push(
        recovered.finally(() => {
          for (const id of terminalReconciliations)
            this.activeTransactions.delete(id);
          this.releaseUserWork(terminalReconciliations.length);
        }),
      );
    }

    for (const receipt of receipts) {
      if (this.activeReceipts.has(receipt.claimId)) {
        this.releaseUserWork(1);
        continue;
      }
      this.activeReceipts.add(receipt.claimId);
      work.push(
        this.resolveReceipt(
          receipt.claimId,
          receipt.retryCount,
          scheduler,
        ).finally(() => {
          this.activeReceipts.delete(receipt.claimId);
          this.releaseUserWork(1);
        }),
      );
    }

    const claimedTransactions = transactions.filter(({ id }) => {
      if (this.activeTransactions.has(id)) {
        this.releaseUserWork(1);
        return false;
      }
      this.activeTransactions.add(id);
      return true;
    });
    const checks = claimedTransactions.map(({ id }) => id);
    if (checks.length > 0) {
      // Dispatcher schedules every underlying status/effect/height request; wrapping it would deadlock.
      const checked = this.dispatcher.check(checks, scheduler);
      const reconciled = checked.then(async (decisions) => {
        await this.reconciliation?.execute(checks, scheduler);
        return decisions;
      });
      for (const transaction of claimedTransactions.filter(
        ({ state }) => state !== 'SIGNED',
      )) {
        work.push(
          reconciled.finally(() => {
            this.activeTransactions.delete(transaction.id);
            this.releaseUserWork(1);
          }),
        );
      }
      // ambiguous/new SIGNED rows are inspected first; only a still-SIGNED row reuses exact bytes.
      for (const transaction of claimedTransactions.filter(
        ({ state }) => state === 'SIGNED',
      )) {
        work.push(
          reconciled
            .then(async (decisions) => {
              if (
                !decisions.some(
                  (decision) =>
                    decision.transactionId === transaction.id &&
                    decision.resendSigned,
                )
              )
                return;
              const current = await this.nftTransactions.findDispatchable(
                transaction.id,
              );
              if (current?.state !== 'SIGNED') return;
              await scheduler.enqueue({
                kind: transaction.kind?.startsWith('SETUP_')
                  ? 'RELEASE_PREPARE'
                  : 'USER_SEND',
                rpcType: 'SEND',
                run: (signal) =>
                  this.dispatcher.dispatch(transaction.id, signal),
              });
            })
            .finally(() => {
              this.activeTransactions.delete(transaction.id);
              this.releaseUserWork(1);
            }),
        );
      }
    }
    // External work continues in bounded scheduler lanes; later ticks may discover newer user work meanwhile.
    for (const pending of work) void pending.catch(() => undefined);
  }

  async scanCandidates(): Promise<void> {
    // 끝난 시즌도 개설자가 발행을 요청하기 전에는 release를 만들지 않는다.
  }

  private async enqueueReleaseChain(
    scheduler: NftRpcScheduler,
    release: Readonly<{
      releaseId: string;
      version: bigint;
      retryCount: number;
    }>,
  ): Promise<void> {
    try {
      const job = await this.releaseChain.next(release.releaseId);
      if (!job)
        throw new Error('Season NFT release provider returned no operation.');
      await scheduler.enqueue({
        kind: 'RELEASE_PREPARE',
        rpcType: job.rpcType,
        run: job.run,
      });
    } catch (error: unknown) {
      await this.persistReleaseFailure(release, error);
    }
  }

  private async enqueueClaimBuild(
    scheduler: NftRpcScheduler,
    attempt: Readonly<{
      attemptId: string;
      claimId: string;
      retryCount: number;
    }>,
  ): Promise<void> {
    try {
      await this.claimBuilder.build(attempt.attemptId, scheduler);
    } catch (error: unknown) {
      if (error instanceof NftOperationPermanentError) {
        await withDbOnlyRetry(() =>
          this.transactions.run((transaction) =>
            this.claims.failAttempt(
              {
                attemptId: attempt.attemptId,
                claimId: attempt.claimId,
                expectedState: 'QUEUED',
                state: 'FAILED',
                errorCode: error.errorCode,
              },
              transaction,
            ),
          ),
        );
        return;
      }
      await this.claims.rescheduleAttempt({
        attemptId: attempt.attemptId,
        claimId: attempt.claimId,
        retryDelayMs: nextRetryDelayMs(attempt.retryCount, retryAfter(error)),
        errorCode: error instanceof Error ? error.name : 'NFT_BUILD_RETRY',
      });
    }
  }

  private async resolveReceipt(
    claimId: string,
    retryCount: number,
    scheduler: NftRpcScheduler,
  ): Promise<void> {
    try {
      // 오래된 test/provider 객체도 request-level READ 경계를 거쳐 lookup 하나만 실행한다.
      const result =
        typeof this.receiptLookup.resolve === 'function'
          ? await this.receiptLookup.resolve(claimId, scheduler)
          : await scheduler.enqueue({
              kind: 'USER_CHECK',
              rpcType: 'READ',
              run: (signal) => this.receiptLookup.lookup(claimId, signal),
            });
      if (result.status === 'PENDING') {
        await this.claims.rescheduleReceipt({
          claimId,
          retryDelayMs: nextRetryDelayMs(retryCount, result.retryAfterMs),
          ...(Object.hasOwn(result, 'historyBefore')
            ? { historyBefore: result.historyBefore ?? null }
            : {}),
        });
        this.logger.warn({
          event: 'season_nft.claim_resolving',
          claimId,
          network: this.config.read().network,
          state: 'RESOLVING',
          retryCount: retryCount + 1,
          errorCode: 'NFT_RECEIPT_PENDING',
        });
        return;
      }
      await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.claims.completeClaim(
            {
              claimId,
              receiptState: 'VERIFIED',
              assetAddress: result.assetAddress,
              mintSignature: result.mintSignature,
              claimedAt: result.claimedAt,
            },
            transaction,
          ),
        ),
      );
    } catch (error: unknown) {
      await this.claims.rescheduleReceipt({
        claimId,
        retryDelayMs: nextRetryDelayMs(retryCount, retryAfter(error)),
      });
    }
  }

  private async persistReleaseFailure(
    release: Readonly<{
      releaseId: string;
      version: bigint;
      retryCount: number;
      state?: string;
      stage?: string;
    }>,
    error: unknown,
  ): Promise<void> {
    if (error instanceof NftOperationPermanentError) {
      // Provider identity persistence may have advanced version after claimDue; re-read before BLOCKED CAS.
      const current =
        release.state === 'PREPARING' &&
        ['METADATA', 'COLLECTION', 'MACHINE'].includes(release.stage ?? '')
          ? await this.releases.findChainSource(release.releaseId)
          : null;
      await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.releases.block(
            {
              releaseId: release.releaseId,
              expectedVersion: current?.version ?? release.version,
              errorCode: error.errorCode,
              errorMessage: error.message,
              nextAttemptAt: new Date(),
            },
            transaction,
          ),
        ),
      );
      this.logger.warn({
        event: 'season_nft.release_blocked',
        releaseId: release.releaseId,
        network: this.config.read().network,
        state: 'BLOCKED',
        retryCount: release.retryCount,
        errorCode: error.errorCode,
      });
      return;
    }
    await this.releases.rescheduleDue({
      releaseId: release.releaseId,
      retryDelayMs: nextRetryDelayMs(release.retryCount, retryAfter(error)),
      errorCode: error instanceof Error ? error.name : 'NFT_CHAIN_RETRY',
    });
  }

  private reserveStorageWork(maximum: number): number {
    const reserved = Math.max(0, maximum - this.reservedStorageWork);
    this.reservedStorageWork += reserved;
    return reserved;
  }

  private releaseStorageWork(count: number): void {
    this.reservedStorageWork = Math.max(0, this.reservedStorageWork - count);
  }

  private reserveUserWork(maximum: number): number {
    const reserved = Math.max(0, maximum - this.reservedUserWork);
    this.reservedUserWork += reserved;
    return reserved;
  }

  private releaseUserWork(count: number): void {
    this.reservedUserWork = Math.max(0, this.reservedUserWork - count);
  }
}
