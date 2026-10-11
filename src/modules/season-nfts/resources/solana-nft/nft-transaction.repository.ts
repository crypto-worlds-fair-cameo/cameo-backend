import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { withDbOnlyRetry } from '../nft-worker/db-only-retry';
import {
  NftDispatchRepository,
  type DispatchOutcome,
  type DispatchableNftTransaction,
} from './nft-transaction-dispatcher';
import type {
  SeasonNftNetwork,
  SeasonNftTransactionKind,
  SeasonNftTransactionState,
} from '../season-nft/season-nft';

type TransactionRow = {
  id: string;
  network: SeasonNftNetwork;
  release_id: string;
  attempt_id: string | null;
  operation_key: string;
  kind: SeasonNftTransactionKind;
  state: SeasonNftTransactionState;
  message_hash: string;
  serialized_transaction: Buffer;
  signature: string | null;
  recent_blockhash: string;
  last_valid_block_height: string;
  asset_address: string | null;
  next_check_at: Date;
  confirmation_check_count: number;
  retry_count: number;
  created_at: Date;
};

export type InsertPreparedTransactionInput = Readonly<{
  id?: string;
  network: SeasonNftNetwork;
  releaseId: string;
  attemptId?: string | null;
  operationKey: string;
  kind: SeasonNftTransactionKind;
  messageHash: string;
  serializedTransaction: Buffer;
  recentBlockhash: string;
  lastValidBlockHeight: bigint;
  assetAddress?: string;
  estimatedCostLamports?: bigint;
  estimatedAt?: Date;
  costBreakdown?: Readonly<Record<string, string>>;
}>;

export type PreparedTransactionResult = Readonly<{
  created: boolean;
  transactionId: string;
  state: SeasonNftTransactionState;
}>;

export type OwnedClaimTransaction = Readonly<{
  transactionId: string;
  network: SeasonNftNetwork;
  state: SeasonNftTransactionState;
  messageHash: string;
  serializedTransaction: Buffer;
  signature: string | null;
  walletAddress: string;
}>;

type ClaimTransactionActor = Readonly<{
  userId: string;
  walletAccountId: string;
  walletAddress: string;
}>;

const TRANSACTION_COLUMNS = `
  id, network, release_id, attempt_id, operation_key, kind, state,
  message_hash, serialized_transaction, signature, recent_blockhash,
  last_valid_block_height, asset_address, next_check_at,
  confirmation_check_count, retry_count, created_at`;

const EVIDENCE_TRANSITIONS: Readonly<
  Partial<
    Record<SeasonNftTransactionState, readonly SeasonNftTransactionState[]>
  >
> = {
  PREPARED: [
    'SUBMITTED',
    'CONFIRMED',
    'FINALIZED',
    'RECONCILED',
    'FAILED',
    'EXPIRED',
  ],
  SIGNED: [
    'SUBMITTED',
    'CONFIRMED',
    'FINALIZED',
    'RECONCILED',
    'FAILED',
    'EXPIRED',
  ],
  SUBMITTED: ['CONFIRMED', 'FINALIZED', 'RECONCILED', 'FAILED', 'EXPIRED'],
  CONFIRMED: ['FINALIZED', 'RECONCILED', 'FAILED'],
  RECONCILED: ['FINALIZED', 'FAILED'],
};

function expectedOperationKey(
  input: InsertPreparedTransactionInput,
): string | null {
  if (input.kind === 'USER_PROOF')
    return input.attemptId ? `claim:${input.attemptId}:ALLOWLIST_PROOF` : null;
  if (input.kind === 'USER_MINT')
    return input.attemptId ? `claim:${input.attemptId}:MINT` : null;
  return /^setup:[a-z][a-z0-9_-]*:[0-9]+$/.test(input.operationKey)
    ? input.operationKey
    : null;
}

/** DB 기록 전 외부 전송을 막고 operation별 단일 거래와 복구 증거를 소유한다. */
@Injectable()
export class NftTransactionRepository extends NftDispatchRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly transactions: TransactionRunner,
  ) {
    super();
  }

  /** due transaction을 순서대로 잠그고 외부 I/O 전에 next_check_at을 영속 reschedule한다. */
  async claimDue(
    input: Readonly<{
      network: SeasonNftNetwork;
      limit: number;
      claimDurationMs: number;
    }>,
  ): Promise<readonly DispatchableNftTransaction[]> {
    return withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const executor = getPgExecutor(this.pool, transaction);
        const candidates = await executor.query<{ id: string }>(
          `SELECT id FROM season_nft_transactions
           WHERE network = $1
             AND state IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED')
             AND next_check_at <= statement_timestamp()
           ORDER BY next_check_at ASC, created_at ASC, id ASC
           LIMIT $2`,
          [input.network, input.limit],
        );
        const claimed: DispatchableNftTransaction[] = [];
        for (const candidate of candidates.rows) {
          const row = await this.lockTransaction(candidate.id, transaction);
          // stale 후보는 다른 tick의 reschedule 결과를 덮지 않는다.
          if (
            row.network !== input.network ||
            !['PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED'].includes(
              row.state,
            )
          ) {
            continue;
          }
          const updated = await executor.query(
            `UPDATE season_nft_transactions
             SET next_check_at = statement_timestamp() +
                   ($2::double precision * interval '1 millisecond'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND state = $3
               AND next_check_at <= statement_timestamp()
             RETURNING id`,
            [row.id, input.claimDurationMs, row.state],
          );
          // 잠금 대기 중 다른 선점이 due 시각을 바꿨으면 stale 후보를 건너뛴다.
          if (updated.rows.length === 0) continue;
          claimed.push(this.dispatchable(row));
        }
        return claimed;
      }),
    );
  }

  /** 외부 호출 전후의 짧은 read에서 exact signed bytes와 expiry identity를 다시 읽는다. */
  async findDispatchable(
    transactionId: string,
  ): Promise<DispatchableNftTransaction | null> {
    const result = await this.pool.query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS}
       FROM season_nft_transactions WHERE id = $1`,
      [transactionId],
    );
    return result.rows[0] ? this.dispatchable(result.rows[0]) : null;
  }

  /** Release orchestration resumes the one durable row for an operation before building a replacement. */
  async findByOperation(
    input: Readonly<{
      network: SeasonNftNetwork;
      releaseId: string;
      operationKey: string;
    }>,
  ): Promise<DispatchableNftTransaction | null> {
    const result = await this.pool.query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS}
       FROM season_nft_transactions
       WHERE network = $1 AND release_id = $2 AND operation_key = $3
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.network, input.releaseId, input.operationKey],
    );
    return result.rows[0] ? this.dispatchable(result.rows[0]) : null;
  }

  /** actor·season·attempt가 모두 맞는 사용자 거래만 검증용 bytes와 함께 반환한다. */
  async findOwnedClaimTransaction(
    input: Readonly<{
      seasonId: string;
      attemptId: string;
      transactionId: string;
      actor: ClaimTransactionActor;
    }>,
    transaction: TransactionContext,
  ): Promise<OwnedClaimTransaction | null> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
      network: SeasonNftNetwork;
      state: SeasonNftTransactionState;
      message_hash: string;
      serialized_transaction: Buffer;
      signature: string | null;
      wallet_address: string;
    }>(
      `SELECT t.id, t.network, t.state, t.message_hash, t.serialized_transaction,
              t.signature, c.wallet_address
       FROM season_nft_transactions t
       JOIN season_nft_claim_attempts a ON a.id = t.attempt_id
       JOIN season_nft_claims c ON c.id = a.claim_id
       JOIN season_nft_releases r ON r.id = c.release_id
       WHERE t.id = $1 AND a.id = $2 AND r.season_id = $3
         AND c.user_id = $4 AND c.wallet_account_id = $5
         AND c.wallet_address = $6
         AND t.kind IN ('USER_PROOF', 'USER_MINT')`,
      [
        input.transactionId,
        input.attemptId,
        input.seasonId,
        input.actor.userId,
        input.actor.walletAccountId,
        input.actor.walletAddress,
      ],
    );
    const row = result.rows[0];
    return row
      ? {
          transactionId: row.id,
          network: row.network,
          state: row.state,
          messageHash: row.message_hash,
          serializedTransaction: row.serialized_transaction,
          signature: row.signature,
          walletAddress: row.wallet_address,
        }
      : null;
  }

  /** 소유권과 현재 attempt를 row lock 아래 재확인하고 SIGNED bytes를 attempt 전이와 함께 commit한다. */
  async acceptOwnedSigned(
    input: Readonly<{
      seasonId: string;
      attemptId: string;
      transactionId: string;
      actor: ClaimTransactionActor;
      expectedMessageHash: string;
      signedBytes: Buffer;
      signature: string;
    }>,
    transaction: TransactionContext,
  ): Promise<
    | Readonly<{ outcome: 'ACCEPTED'; attemptState: string; signature: string }>
    | Readonly<{ outcome: 'REPLAY'; attemptState: string; signature: string }>
    | Readonly<{ outcome: 'NOT_FOUND' }>
    | Readonly<{ outcome: 'EXPIRED' }>
    | Readonly<{ outcome: 'INVALID_STATE' }>
  > {
    let row: TransactionRow;
    try {
      row = await this.lockTransaction(input.transactionId, transaction);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('was not found')) {
        return { outcome: 'NOT_FOUND' };
      }
      throw error;
    }
    const executor = getPgExecutor(this.pool, transaction);
    const scope = await executor.query<{
      attempt_state: string;
      attempt_step: string;
    }>(
      `SELECT a.state AS attempt_state, a.step AS attempt_step
       FROM season_nft_claim_attempts a
       JOIN season_nft_claims c ON c.id = a.claim_id
       JOIN season_nft_releases r ON r.id = c.release_id
       WHERE a.id = $1 AND r.season_id = $2
         AND c.user_id = $3 AND c.wallet_account_id = $4
         AND c.wallet_address = $5 AND r.id = $6`,
      [
        input.attemptId,
        input.seasonId,
        input.actor.userId,
        input.actor.walletAccountId,
        input.actor.walletAddress,
        row.release_id,
      ],
    );
    const owned = scope.rows[0];
    if (!owned || row.attempt_id !== input.attemptId) {
      return { outcome: 'NOT_FOUND' };
    }
    if (row.message_hash !== input.expectedMessageHash) {
      return { outcome: 'INVALID_STATE' };
    }
    // 과거 거래의 exact bytes replay는 현재 attempt step이 진행됐어도 기존 signature를 반환한다.
    if (
      row.signature === input.signature &&
      row.serialized_transaction.equals(input.signedBytes)
    ) {
      return {
        outcome: 'REPLAY',
        attemptState: owned.attempt_state,
        signature: input.signature,
      };
    }
    if (row.state === 'EXPIRED') return { outcome: 'EXPIRED' };
    const expectedKind =
      owned.attempt_step === 'ALLOWLIST_PROOF' ? 'USER_PROOF' : 'USER_MINT';
    if (
      row.state !== 'PREPARED' ||
      owned.attempt_state !== 'AWAITING_SIGNATURE' ||
      row.kind !== expectedKind
    ) {
      return { outcome: 'INVALID_STATE' };
    }
    const updated = await executor.query<TransactionRow>(
      `UPDATE season_nft_transactions
       SET serialized_transaction = $2, signature = $3, state = 'SIGNED',
           next_check_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'PREPARED'
       RETURNING ${TRANSACTION_COLUMNS}`,
      [input.transactionId, input.signedBytes, input.signature],
    );
    if (!updated.rows[0]) return { outcome: 'INVALID_STATE' };
    await executor.query(
      `UPDATE season_nft_claim_attempts
       SET state = 'SUBMITTING', last_error_code = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'AWAITING_SIGNATURE'`,
      [input.attemptId],
    );
    return {
      outcome: 'ACCEPTED',
      attemptState: 'SUBMITTING',
      signature: input.signature,
    };
  }

  /** RPC 결과만 DB-only transaction에 기록하며 같은 상태 결과는 due/error만 갱신한다. */
  async recordDispatchOutcome(outcome: DispatchOutcome): Promise<void> {
    await withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        if (outcome.state === outcome.expectedState) {
          const row = await this.lockTransaction(
            outcome.transactionId,
            transaction,
          );
          if (row.state !== outcome.expectedState) return;
          await getPgExecutor(this.pool, transaction).query(
            `UPDATE season_nft_transactions
             SET last_error_code = $3,
                 next_check_at = CASE
                   WHEN $4::double precision IS NULL THEN next_check_at
                   ELSE statement_timestamp() +
                     ($4::double precision * interval '1 millisecond')
                 END,
                 confirmation_check_count = confirmation_check_count +
                   CASE WHEN $5 THEN 1 ELSE 0 END,
                 retry_count = CASE
                   WHEN $6 = 'INCREMENT' THEN retry_count + 1
                   WHEN $6 = 'RESET' THEN 0
                   ELSE retry_count
                 END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND state = $2`,
            [
              outcome.transactionId,
              outcome.expectedState,
              outcome.errorCode ?? null,
              outcome.nextCheckDelayMs ?? null,
              outcome.incrementConfirmationCheck ?? false,
              outcome.retryDisposition ?? null,
            ],
          );
          return;
        }
        if (outcome.state === 'PREPARED' || outcome.state === 'SIGNED') return;
        await this.recordEvidence(
          {
            transactionId: outcome.transactionId,
            expectedState: outcome.expectedState,
            state: outcome.state,
            reconciliationEvidence: outcome.reconciliationEvidence,
            errorCode: outcome.errorCode,
            nextCheckDelayMs: outcome.nextCheckDelayMs,
            incrementConfirmationCheck: outcome.incrementConfirmationCheck,
            retryDisposition: outcome.retryDisposition,
          },
          transaction,
        );
      }),
    );
  }

  /** release와 attempt 관계를 잠금 아래 확인한 뒤 전송 전 PREPARED 거래를 한 번만 저장한다. */
  async insertPrepared(
    input: InsertPreparedTransactionInput,
    transaction: TransactionContext,
  ): Promise<PreparedTransactionResult> {
    if (expectedOperationKey(input) !== input.operationKey) {
      throw new Error('Season NFT transaction operation key is invalid.');
    }
    const executor = getPgExecutor(this.pool, transaction);
    await this.lockHierarchy(
      input.releaseId,
      input.attemptId ?? null,
      transaction,
    );
    const existing = await executor.query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS}
       FROM season_nft_transactions
       WHERE network = $1 AND release_id = $2 AND operation_key = $3
         AND state IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED',
                       'FINALIZED', 'RECONCILED')
       FOR UPDATE`,
      [input.network, input.releaseId, input.operationKey],
    );
    if (existing.rows[0]) return this.preparedResult(existing.rows[0], false);

    const id = input.id ?? randomUUID();
    const inserted = await executor.query<TransactionRow>(
      `INSERT INTO season_nft_transactions
         (id, network, release_id, attempt_id, operation_key, kind, state,
          message_hash, serialized_transaction, recent_blockhash,
          last_valid_block_height, asset_address, estimated_cost_lamports,
          estimated_at, cost_breakdown)
       VALUES ($1, $2, $3, $4, $5, $6, 'PREPARED', $7, $8, $9, $10,
               $11, $12, $13, $14)
       RETURNING ${TRANSACTION_COLUMNS}`,
      [
        id,
        input.network,
        input.releaseId,
        input.attemptId ?? null,
        input.operationKey,
        input.kind,
        input.messageHash,
        input.serializedTransaction,
        input.recentBlockhash,
        input.lastValidBlockHeight.toString(),
        input.assetAddress ?? null,
        input.estimatedCostLamports?.toString() ?? null,
        input.estimatedAt ?? null,
        input.costBreakdown ? JSON.stringify(input.costBreakdown) : null,
      ],
    );
    return this.preparedResult(inserted.rows[0], true);
  }

  /** 지정 거래의 message hash를 재확인하고 완전 서명 bytes와 signature를 원자적으로 접수한다. */
  async acceptSigned(
    input: Readonly<{
      transactionId: string;
      expectedMessageHash: string;
      signedBytes: Buffer;
      signature: string;
    }>,
    transaction: TransactionContext,
  ): Promise<
    Readonly<{
      accepted: boolean;
      currentTransactionState: SeasonNftTransactionState;
      signature: string;
    }>
  > {
    const row = await this.lockTransaction(input.transactionId, transaction);
    if (row.message_hash !== input.expectedMessageHash) {
      throw new Error('Season NFT transaction message hash does not match.');
    }
    const executor = getPgExecutor(this.pool, transaction);
    if (row.state === 'PREPARED') {
      const updated = await executor.query<TransactionRow>(
        `UPDATE season_nft_transactions
         SET serialized_transaction = $2, signature = $3, state = 'SIGNED',
             next_check_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state = 'PREPARED'
         RETURNING ${TRANSACTION_COLUMNS}`,
        [input.transactionId, input.signedBytes, input.signature],
      );
      return {
        accepted: true,
        currentTransactionState: updated.rows[0].state,
        signature: updated.rows[0].signature!,
      };
    }
    // 이미 접수한 같은 bytes와 signature는 현재 상태를 유지하는 idempotent 성공이다.
    if (
      row.signature === input.signature &&
      row.serialized_transaction.equals(input.signedBytes)
    ) {
      return {
        accepted: false,
        currentTransactionState: row.state,
        signature: input.signature,
      };
    }
    throw new Error(
      'Season NFT transaction already has different signed bytes.',
    );
  }

  /** 예상 상태가 유지될 때만 확인 증거를 기록하며 RECONCILED는 실제 계정 증거를 필수로 한다. */
  async recordEvidence(
    input: Readonly<{
      transactionId: string;
      expectedState: SeasonNftTransactionState;
      state: Exclude<SeasonNftTransactionState, 'PREPARED' | 'SIGNED'>;
      reconciliationEvidence?: Readonly<Record<string, unknown>>;
      assetAddress?: string;
      errorCode?: string;
      nextCheckDelayMs?: number;
      incrementConfirmationCheck?: boolean;
      retryDisposition?: 'INCREMENT' | 'RESET';
    }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    if (input.state === 'RECONCILED' && !input.reconciliationEvidence) {
      throw new Error(
        'Reconciled season NFT transaction evidence is required.',
      );
    }
    const current = await this.lockTransaction(
      input.transactionId,
      transaction,
    );
    // 다른 worker가 먼저 전이했거나 terminal/backward 전이면 기존 성공 보호 상태를 유지한다.
    if (
      current.state !== input.expectedState ||
      !EVIDENCE_TRANSITIONS[current.state]?.includes(input.state)
    ) {
      return { updated: false };
    }
    const result = await getPgExecutor(this.pool, transaction).query(
      `UPDATE season_nft_transactions
       SET state = $3, reconciliation_evidence = $4,
           asset_address = COALESCE($5, asset_address),
           last_error_code = $6,
           next_check_at = CASE
             WHEN $7::double precision IS NULL THEN next_check_at
             ELSE statement_timestamp() +
               ($7::double precision * interval '1 millisecond')
           END,
           confirmation_check_count = confirmation_check_count +
             CASE WHEN $8 THEN 1 ELSE 0 END,
           retry_count = CASE
             WHEN $9 = 'INCREMENT' THEN retry_count + 1
             WHEN $9 = 'RESET' THEN 0
             ELSE retry_count
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = $2
       RETURNING id`,
      [
        input.transactionId,
        input.expectedState,
        input.state,
        input.reconciliationEvidence
          ? JSON.stringify(input.reconciliationEvidence)
          : null,
        input.assetAddress ?? null,
        input.errorCode ?? null,
        input.nextCheckDelayMs ?? null,
        input.incrementConfirmationCheck ?? false,
        input.retryDisposition ?? null,
      ],
    );
    return { updated: result.rows.length === 1 };
  }

  /** FAILED 또는 EXPIRED 거래만 같은 operation_key의 새 PREPARED 거래로 교체한다. */
  async replaceExpired(
    input: Readonly<{
      transactionId: string;
      replacement: InsertPreparedTransactionInput;
    }>,
    transaction: TransactionContext,
  ): Promise<PreparedTransactionResult> {
    const previous = await this.lockTransaction(
      input.transactionId,
      transaction,
    );
    if (previous.state !== 'FAILED' && previous.state !== 'EXPIRED') {
      return this.preparedResult(previous, false);
    }
    if (
      previous.network !== input.replacement.network ||
      previous.release_id !== input.replacement.releaseId ||
      previous.attempt_id !== (input.replacement.attemptId ?? null) ||
      previous.operation_key !== input.replacement.operationKey ||
      previous.kind !== input.replacement.kind
    ) {
      throw new Error(
        'Season NFT replacement does not match the expired operation.',
      );
    }
    return this.insertPrepared(input.replacement, transaction);
  }

  private preparedResult(
    row: TransactionRow,
    created: boolean,
  ): PreparedTransactionResult {
    return { created, transactionId: row.id, state: row.state };
  }

  private dispatchable(row: TransactionRow): DispatchableNftTransaction {
    return {
      id: row.id,
      network: row.network,
      releaseId: row.release_id,
      attemptId: row.attempt_id,
      operationKey: row.operation_key,
      kind: row.kind,
      state: row.state,
      signature: row.signature,
      serializedTransaction: row.serialized_transaction,
      lastValidBlockHeight: BigInt(row.last_valid_block_height),
      assetAddress: row.asset_address,
      confirmationCheckCount: row.confirmation_check_count,
      retryCount: row.retry_count,
    };
  }

  /** season, release, claim, attempt 순서로 잠그고 attempt가 같은 release의 claim인지 확인한다. */
  private async lockHierarchy(
    releaseId: string,
    attemptId: string | null,
    transaction: TransactionContext,
  ): Promise<void> {
    const executor = getPgExecutor(this.pool, transaction);
    const release = await executor.query<{ season_id: string }>(
      `SELECT season_id FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    );
    if (!release.rows[0]) throw new Error('Season NFT release was not found.');
    await executor.query(
      `SELECT canvas_id FROM seasons WHERE canvas_id = $1 FOR UPDATE`,
      [release.rows[0].season_id],
    );
    await executor.query(
      `SELECT id FROM season_nft_releases WHERE id = $1 FOR UPDATE`,
      [releaseId],
    );
    if (!attemptId) return;
    const identity = await executor.query<{
      claim_id: string;
      release_id: string;
    }>(
      `SELECT a.claim_id, c.release_id
       FROM season_nft_claim_attempts a
       JOIN season_nft_claims c ON c.id = a.claim_id
       WHERE a.id = $1`,
      [attemptId],
    );
    if (!identity.rows[0] || identity.rows[0].release_id !== releaseId) {
      throw new Error('Season NFT attempt does not belong to the release.');
    }
    await executor.query(
      `SELECT id FROM season_nft_claims WHERE id = $1 FOR UPDATE`,
      [identity.rows[0].claim_id],
    );
    await executor.query(
      `SELECT id FROM season_nft_claim_attempts WHERE id = $1 FOR UPDATE`,
      [attemptId],
    );
  }

  /** 거래 ID에서 계층을 해석해 상위 행부터 잠근 뒤 지정 transaction을 마지막에 잠근다. */
  private async lockTransaction(
    transactionId: string,
    transaction: TransactionContext,
  ): Promise<TransactionRow> {
    const executor = getPgExecutor(this.pool, transaction);
    const identity = await executor.query<{
      release_id: string;
      attempt_id: string | null;
    }>(
      `SELECT release_id, attempt_id
       FROM season_nft_transactions WHERE id = $1`,
      [transactionId],
    );
    if (!identity.rows[0])
      throw new Error('Season NFT transaction was not found.');
    await this.lockHierarchy(
      identity.rows[0].release_id,
      identity.rows[0].attempt_id,
      transaction,
    );
    const locked = await executor.query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS}
       FROM season_nft_transactions WHERE id = $1 FOR UPDATE`,
      [transactionId],
    );
    return locked.rows[0];
  }
}
