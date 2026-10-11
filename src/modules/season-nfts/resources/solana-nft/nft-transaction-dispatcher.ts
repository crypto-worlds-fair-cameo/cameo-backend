import { Injectable, Logger } from '@nestjs/common';
import type { SeasonNftTransactionState } from '../season-nft/season-nft';
import type { SeasonNftTransactionKind } from '../season-nft/season-nft';
import type { NftRpcJob, NftRpcScheduler } from '../nft-worker/rpc-scheduler';

export type ExpiryEvidence = Readonly<{
  finalizedHeight: bigint;
  lastValidBlockHeight: bigint;
  signature: 'ABSENT' | 'CONFIRMED' | 'FINALIZED' | 'FAILED';
  accountEvidence: 'ABSENT' | 'SUCCESS' | 'UNKNOWN';
  allQueriesSucceeded: boolean;
}>;

export function canExpire(evidence: ExpiryEvidence): boolean {
  return (
    evidence.allQueriesSucceeded &&
    evidence.finalizedHeight > evidence.lastValidBlockHeight &&
    evidence.signature === 'ABSENT' &&
    evidence.accountEvidence === 'ABSENT'
  );
}

const TRANSIENT_RETRY_BASE_MS = [
  5_000, 15_000, 60_000, 300_000, 900_000,
] as const;

export function confirmationDelayMs(checkCount: number): number {
  return [10_000, 15_000, 15_000][Math.min(Math.max(checkCount, 0), 2)];
}

function providerRetryAfterMs(error: unknown): number {
  if (!error || typeof error !== 'object' || !('retry' in error)) return 0;
  const retry = error.retry;
  if (!retry || typeof retry !== 'object') return 0;
  const retryAfter =
    'retryAfterMs' in retry && typeof retry.retryAfterMs === 'number'
      ? Math.max(0, retry.retryAfterMs)
      : 0;
  const reason = 'reason' in retry ? retry.reason : undefined;
  return reason === 'SERVICE_BALANCE' || reason === 'STORAGE_CREDITS'
    ? Math.max(300_000, retryAfter)
    : retryAfter;
}

function transientRetryDelayMs(retryCount: number, error?: unknown): number {
  const base =
    TRANSIENT_RETRY_BASE_MS[
      Math.min(Math.max(retryCount, 0), TRANSIENT_RETRY_BASE_MS.length - 1)
    ];
  return Math.max(
    base + Math.floor(base * 0.2 * Math.random()),
    providerRetryAfterMs(error),
  );
}

export type DispatchableNftTransaction = Readonly<{
  id: string;
  network?: 'devnet' | 'mainnet-beta';
  releaseId?: string;
  attemptId?: string | null;
  operationKey?: string;
  kind?: SeasonNftTransactionKind;
  state: SeasonNftTransactionState;
  signature: string | null;
  serializedTransaction: Buffer;
  lastValidBlockHeight: bigint;
  assetAddress?: string | null;
  confirmationCheckCount?: number;
  retryCount?: number;
}>;

export type NftTransactionInspection = Readonly<{
  transactionId: string;
  signature: ExpiryEvidence['signature'];
  accountEvidence: ExpiryEvidence['accountEvidence'];
  allQueriesSucceeded: boolean;
  finalizedHeight: bigint;
  reconciliationEvidence?: Readonly<Record<string, unknown>>;
  errorCode?: string;
}>;

export type DispatchOutcome = Readonly<{
  transactionId: string;
  expectedState: SeasonNftTransactionState;
  state: SeasonNftTransactionState;
  errorCode?: string;
  reconciliationEvidence?: Readonly<Record<string, unknown>>;
  nextCheckDelayMs?: number;
  incrementConfirmationCheck?: boolean;
  retryDisposition?: 'INCREMENT' | 'RESET';
}>;

export type NftCheckDecision = Readonly<{
  transactionId: string;
  resendSigned: boolean;
}>;

export abstract class NftChainRpc {
  abstract sendSignedTransaction(
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<string>;
  abstract inspectTransactions(
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ): Promise<readonly NftTransactionInspection[]>;
  inspectSignatures?: (
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ) => Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'signature' | 'errorCode'
    >[]
  >;
  inspectAccountEffects?: (
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ) => Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'accountEvidence' | 'reconciliationEvidence'
    >[]
  >;
  getFinalizedBlockHeight?: (signal: AbortSignal) => Promise<bigint>;
}

export abstract class NftClaimEffectRpc {
  abstract inspect(
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ): Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'accountEvidence' | 'reconciliationEvidence'
    >[]
  >;
}

export abstract class NftDispatchRepository {
  abstract findDispatchable(
    transactionId: string,
  ): Promise<DispatchableNftTransaction | null>;
  abstract recordDispatchOutcome(outcome: DispatchOutcome): Promise<void>;
}

/** 06/08 specific provider가 연결되기 전에는 RPC 성공을 꾸며내지 않고 명시적으로 중단한다. */
@Injectable()
export class UnavailableNftChainRpc extends NftChainRpc {
  async sendSignedTransaction(): Promise<never> {
    throw new Error('Season NFT chain RPC provider is unavailable.');
  }

  async inspectTransactions(): Promise<never> {
    throw new Error('Season NFT chain RPC provider is unavailable.');
  }
}

/** 저장된 exact signed bytes 전송과 finalized/효과 증거 수렴만 담당한다. */
@Injectable()
export class NftTransactionDispatcher {
  private readonly logger = new Logger(NftTransactionDispatcher.name);

  constructor(
    private readonly repository: NftDispatchRepository,
    private readonly chain: NftChainRpc,
  ) {}

  /** SIGNED row만 전송하며 ambiguous 오류에서는 identity를 바꾸지 않고 다음 확인을 예약한다. */
  async dispatch(
    transactionId: string,
    signal: AbortSignal = AbortSignal.timeout(10_000),
  ): Promise<void> {
    const transaction = await this.repository.findDispatchable(transactionId);
    if (!transaction || transaction.state !== 'SIGNED') return;
    if (
      !transaction.signature ||
      transaction.serializedTransaction.length === 0
    )
      throw new Error('Season NFT signed transaction evidence is incomplete.');
    try {
      const signature = await this.chain.sendSignedTransaction(
        transaction.serializedTransaction,
        signal,
      );
      if (signature !== transaction.signature)
        throw new Error(
          'Season NFT RPC signature does not match persisted signature.',
        );
      await this.repository.recordDispatchOutcome({
        transactionId,
        expectedState: 'SIGNED',
        state: 'SUBMITTED',
        nextCheckDelayMs: 5_000,
        retryDisposition: 'RESET',
      });
    } catch (error: unknown) {
      // mismatch는 provider 계약 위반이므로 retry 상태로 덮지 않고 호출자에게 전파한다.
      if (error instanceof Error && error.message.includes('does not match'))
        throw error;
      await this.repository.recordDispatchOutcome({
        transactionId,
        expectedState: 'SIGNED',
        state: 'SIGNED',
        errorCode: 'NFT_RPC_AMBIGUOUS',
        nextCheckDelayMs: transientRetryDelayMs(
          transaction.retryCount ?? 0,
          error,
        ),
        retryDisposition: 'INCREMENT',
      });
    }
  }

  /** 최대 100개 row를 한 RPC batch로 확인하고 finalized 실패·효과·만료를 구분한다. */
  async check(
    transactionIds: readonly string[],
    signalOrScheduler:
      AbortSignal | Pick<NftRpcScheduler, 'enqueue'> = AbortSignal.timeout(
      10_000,
    ),
  ): Promise<readonly NftCheckDecision[]> {
    const startedAt = performance.now();
    if (transactionIds.length > 100)
      throw new Error(
        'Season NFT confirmation batch cannot exceed 100 transactions.',
      );
    const transactions = (
      await Promise.all(
        transactionIds.map((id) => this.repository.findDispatchable(id)),
      )
    ).filter((value): value is DispatchableNftTransaction => value !== null);
    if (transactions.length === 0) return [];
    let inspections: readonly NftTransactionInspection[];
    try {
      inspections =
        'enqueue' in signalOrScheduler &&
        this.chain.inspectSignatures &&
        this.chain.inspectAccountEffects &&
        this.chain.getFinalizedBlockHeight
          ? await this.inspectWithScheduledRequests(
              transactions,
              signalOrScheduler,
            )
          : await this.chain.inspectTransactions(
              transactions,
              signalOrScheduler as AbortSignal,
            );
    } catch (error: unknown) {
      await Promise.all(
        transactions.map((transaction) =>
          this.persistTransientFailure(transaction, 'NFT_RPC_RETRY', error),
        ),
      );
      return transactions.map(({ id }) => ({
        transactionId: id,
        resendSigned: false,
      }));
    }
    const byId = new Map(
      inspections.map((inspection) => [inspection.transactionId, inspection]),
    );
    const decisions: NftCheckDecision[] = [];
    for (const transaction of transactions) {
      const inspection = byId.get(transaction.id);
      if (!inspection) {
        await this.persistTransientFailure(
          transaction,
          'NFT_RPC_INSPECTION_MISSING',
        );
        decisions.push({
          transactionId: transaction.id,
          resendSigned: false,
        });
        continue;
      }
      decisions.push({
        transactionId: transaction.id,
        resendSigned: await this.persistInspection(
          transaction,
          inspection,
          performance.now() - startedAt,
        ),
      });
    }
    return decisions;
  }

  /** Production inspection exposes status, effects, and height as separately budgeted requests. */
  private async inspectWithScheduledRequests(
    transactions: readonly DispatchableNftTransaction[],
    scheduler: Pick<NftRpcScheduler, 'enqueue'>,
  ): Promise<readonly NftTransactionInspection[]> {
    const enqueue = <T>(run: NftRpcJob<T>['run']): Promise<T> =>
      scheduler.enqueue({ kind: 'USER_CHECK', rpcType: 'READ', run });
    const signatures = await enqueue((signal) =>
      this.chain.inspectSignatures!(transactions, signal),
    );
    const signatureById = new Map(
      signatures.map((item) => [item.transactionId, item]),
    );
    const unresolved = transactions.filter((transaction) => {
      const status = signatureById.get(transaction.id)?.signature;
      return status !== 'FINALIZED' && status !== 'FAILED';
    });
    const effects: Pick<
      NftTransactionInspection,
      'transactionId' | 'accountEvidence' | 'reconciliationEvidence'
    >[] = [];
    for (const group of [
      unresolved.filter(({ kind }) => !kind || kind.startsWith('SETUP_')),
      unresolved.filter(({ kind }) => kind?.startsWith('USER_')),
    ]) {
      // setup can contribute three accounts, so 33 keeps each RPC at 99 or fewer.
      for (let offset = 0; offset < group.length; offset += 33) {
        const batch = group.slice(offset, offset + 33);
        effects.push(
          ...(await enqueue((signal) =>
            this.chain.inspectAccountEffects!(batch, signal),
          )),
        );
      }
    }
    const effectById = new Map(
      effects.map((item) => [item.transactionId, item]),
    );
    const needsHeight = unresolved.some(
      ({ id }) => effectById.get(id)?.accountEvidence === 'ABSENT',
    );
    const finalizedHeight = needsHeight
      ? await enqueue((signal) => this.chain.getFinalizedBlockHeight!(signal))
      : 0n;
    return transactions.map((transaction) => {
      const signature = signatureById.get(transaction.id);
      const effect = effectById.get(transaction.id);
      return {
        transactionId: transaction.id,
        signature: signature?.signature ?? 'ABSENT',
        accountEvidence: effect?.accountEvidence ?? 'UNKNOWN',
        allQueriesSucceeded:
          signature !== undefined &&
          (signature.signature === 'FINALIZED' ||
            signature.signature === 'FAILED' ||
            effect !== undefined),
        finalizedHeight,
        reconciliationEvidence: effect?.reconciliationEvidence,
        errorCode: signature?.errorCode,
      };
    });
  }

  private async persistInspection(
    transaction: DispatchableNftTransaction,
    inspection: NftTransactionInspection,
    durationMs: number,
  ): Promise<boolean> {
    // 정확한 signature의 finalized 결과가 있으면 효과 조회보다 강한 거래 증거로 기록한다.
    if (inspection.signature === 'FINALIZED') {
      await this.repository.recordDispatchOutcome({
        transactionId: transaction.id,
        expectedState: transaction.state,
        state: inspection.errorCode ? 'FAILED' : 'FINALIZED',
        errorCode: inspection.errorCode,
      });
      this.logger.log({
        event: 'season_nft.transaction_finalized',
        transactionId: transaction.id,
        network: transaction.network,
        state: inspection.errorCode ? 'FAILED' : 'FINALIZED',
        durationMs,
        errorCode: inspection.errorCode,
      });
      return false;
    }
    if (inspection.signature === 'FAILED' && inspection.allQueriesSucceeded) {
      await this.repository.recordDispatchOutcome({
        transactionId: transaction.id,
        expectedState: transaction.state,
        state: 'FAILED',
        errorCode: inspection.errorCode ?? 'NFT_TRANSACTION_FAILED',
      });
      return false;
    }
    if (
      inspection.accountEvidence === 'SUCCESS' &&
      inspection.reconciliationEvidence
    ) {
      await this.repository.recordDispatchOutcome({
        transactionId: transaction.id,
        expectedState: transaction.state,
        state: 'RECONCILED',
        reconciliationEvidence: inspection.reconciliationEvidence,
      });
      return false;
    }
    if (
      canExpire({
        finalizedHeight: inspection.finalizedHeight,
        lastValidBlockHeight: transaction.lastValidBlockHeight,
        signature: inspection.signature,
        accountEvidence: inspection.accountEvidence,
        allQueriesSucceeded: inspection.allQueriesSucceeded,
      })
    ) {
      await this.repository.recordDispatchOutcome({
        transactionId: transaction.id,
        expectedState: transaction.state,
        state: 'EXPIRED',
      });
      return false;
    }
    const state =
      inspection.signature === 'CONFIRMED'
        ? 'CONFIRMED'
        : transaction.state === 'SIGNED'
          ? 'SIGNED'
          : transaction.state;
    await this.repository.recordDispatchOutcome({
      transactionId: transaction.id,
      expectedState: transaction.state,
      state,
      nextCheckDelayMs: confirmationDelayMs(
        transaction.confirmationCheckCount ?? 0,
      ),
      incrementConfirmationCheck: true,
      retryDisposition: 'RESET',
    });
    return (
      transaction.state === 'SIGNED' &&
      inspection.allQueriesSucceeded &&
      inspection.signature === 'ABSENT' &&
      inspection.accountEvidence === 'ABSENT'
    );
  }

  private async persistTransientFailure(
    transaction: DispatchableNftTransaction,
    errorCode: string,
    error?: unknown,
  ): Promise<void> {
    await this.repository.recordDispatchOutcome({
      transactionId: transaction.id,
      expectedState: transaction.state,
      state: transaction.state,
      errorCode,
      nextCheckDelayMs: transientRetryDelayMs(
        transaction.retryCount ?? 0,
        error,
      ),
      retryDisposition: 'INCREMENT',
    });
    this.logger.warn({
      event: 'season_nft.rpc_retry',
      transactionId: transaction.id,
      network: transaction.network,
      state: transaction.state,
      retryCount: (transaction.retryCount ?? 0) + 1,
      errorCode,
    });
  }
}
