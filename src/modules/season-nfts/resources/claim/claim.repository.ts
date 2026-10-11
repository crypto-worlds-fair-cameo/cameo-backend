import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { withDbOnlyRetry } from '../nft-worker/db-only-retry';
import type {
  SeasonNftNetwork,
  SeasonNftAttemptState,
  SeasonNftAttemptStep,
  SeasonNftClaimState,
  SeasonNftReceiptState,
  SeasonNftTransactionKind,
  SeasonNftTransactionState,
} from '../season-nft/season-nft';

type ClaimRow = {
  id: string;
  release_id: string;
  network: SeasonNftNetwork;
  state: SeasonNftClaimState;
  receipt_state: SeasonNftReceiptState;
  user_id: string;
  wallet_account_id: string;
  wallet_address: string;
  receipt_next_check_at: Date | null;
  receipt_retry_count: number;
  created_at: Date;
};

type AttemptRow = {
  id: string;
  claim_id: string;
  state: SeasonNftAttemptState;
  step: SeasonNftAttemptStep;
  next_attempt_at: Date;
  created_at: Date;
  retry_count: number;
};

export type GetOrCreateAttemptResult = Readonly<{
  created: boolean;
  claimState: SeasonNftClaimState;
  attemptId: string | null;
  attemptState: SeasonNftAttemptState | null;
}>;

export type DueReceiptClaim = Readonly<{
  claimId: string;
  retryCount: number;
}>;

export type DueClaimAttempt = Readonly<{
  attemptId: string;
  claimId: string;
  step: SeasonNftAttemptStep;
  retryCount: number;
}>;

export type ClaimActor = Readonly<{
  userId: string;
  walletAccountId: string;
  walletAddress: string;
}>;

export type ClaimCreateScope = Readonly<{
  seasonExists: boolean;
  cancelled: boolean;
  forceEnded: boolean;
  ended: boolean;
  participant: boolean;
  participantWalletAccountId: string | null;
  participantWalletAddress: string | null;
  hasUsage: boolean;
  releaseId: string | null;
  releaseState: string | null;
  claimId: string | null;
  claimState: SeasonNftClaimState | null;
  claimWalletAccountId: string | null;
  claimWalletAddress: string | null;
  activeAttemptId: string | null;
  activeAttemptState: SeasonNftAttemptState | null;
}>;

export type OwnClaimAttempt = Readonly<{
  claimId: string;
  releaseId: string;
  network: SeasonNftNetwork;
  attemptId: string;
  state: SeasonNftAttemptState;
  step: SeasonNftAttemptStep;
  walletAddress: string;
  assetAddress: string | null;
  errorCode: string | null;
  transaction: null | Readonly<{
    transactionId: string;
    serializedTransaction: Buffer;
    lastValidBlockHeight: bigint;
    estimatedCostLamports: bigint;
    estimatedAt: Date;
  }>;
}>;

export type ClaimBuildSource = Readonly<{
  attemptId: string;
  claimId: string;
  releaseId: string;
  network: SeasonNftNetwork;
  state: SeasonNftAttemptState;
  step: SeasonNftAttemptStep;
  walletAddress: string;
  merkleProof: readonly Uint8Array[];
  assetAddress: string | null;
  assetName: string;
  metadataUri: string;
  collectionAddress: string;
  candyMachineAddress: string;
  candyGuardAddress: string;
  merkleRoot: Uint8Array;
}>;

export type ClaimReceiptSource = Readonly<{
  claimId: string;
  network: SeasonNftNetwork;
  walletAddress: string;
  assetName: string;
  metadataUri: string;
  collectionAddress: string;
  candyMachineAddress: string;
  candyGuardAddress: string;
  merkleRoot: Uint8Array;
  knownMintSignature: string | null;
  receiptHistoryBefore: string | null;
}>;

export type ClaimReconciliationSource = Readonly<{
  transactionId: string;
  transactionState: SeasonNftTransactionState;
  kind: Extract<SeasonNftTransactionKind, 'USER_PROOF' | 'USER_MINT'>;
  claimId: string;
  attemptId: string;
  attemptState: SeasonNftAttemptState;
  walletAddress: string;
  assetAddress: string | null;
  candyMachineAddress: string;
  candyGuardAddress: string;
  merkleRoot: Uint8Array;
}>;

/** claim 소유권 조회와 claim, attempt 상태 전이를 release 잠금 아래 소유한다. */
@Injectable()
export class ClaimRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly transactions: TransactionRunner,
  ) {}

  /** worker가 외부 I/O 전에 immutable release와 현재 attempt 입력을 한 번에 읽는다. */
  async findBuildSource(attemptId: string): Promise<ClaimBuildSource | null> {
    const result = await this.pool.query<{
      attempt_id: string;
      claim_id: string;
      release_id: string;
      network: SeasonNftNetwork;
      attempt_state: SeasonNftAttemptState;
      attempt_step: SeasonNftAttemptStep;
      wallet_address: string;
      merkle_proof: number[][];
      asset_address: string | null;
      asset_name: string;
      metadata_uri: string;
      collection_address: string;
      candy_machine_address: string;
      candy_guard_address: string;
      merkle_root: Buffer;
    }>(
      `SELECT a.id AS attempt_id, c.id AS claim_id, r.id AS release_id,
              r.network, a.state AS attempt_state, a.step AS attempt_step,
              c.wallet_address, c.merkle_proof, a.asset_address,
              r.asset_name, r.metadata_uri, r.collection_address,
              r.candy_machine_address, r.candy_guard_address, r.merkle_root
       FROM season_nft_claim_attempts a
       JOIN season_nft_claims c ON c.id = a.claim_id
       JOIN season_nft_releases r ON r.id = c.release_id
       WHERE a.id = $1 AND r.state = 'READY' AND r.stage = 'LOCKED'`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      attemptId: row.attempt_id,
      claimId: row.claim_id,
      releaseId: row.release_id,
      network: row.network,
      state: row.attempt_state,
      step: row.attempt_step,
      walletAddress: row.wallet_address,
      merkleProof: row.merkle_proof.map((node) => Uint8Array.from(node)),
      assetAddress: row.asset_address,
      assetName: row.asset_name,
      metadataUri: row.metadata_uri,
      collectionAddress: row.collection_address,
      candyMachineAddress: row.candy_machine_address,
      candyGuardAddress: row.candy_guard_address,
      merkleRoot: Uint8Array.from(row.merkle_root),
    };
  }

  /** live attempt와 무관하게 CLAIMED/RESOLVING receipt의 frozen identity를 복구한다. */
  async findReceiptSource(claimId: string): Promise<ClaimReceiptSource | null> {
    const result = await this.pool.query<{
      claim_id: string;
      network: SeasonNftNetwork;
      wallet_address: string;
      asset_name: string;
      metadata_uri: string;
      collection_address: string;
      candy_machine_address: string;
      candy_guard_address: string;
      merkle_root: Buffer;
      known_mint_signature: string | null;
      receipt_history_before: string | null;
    }>(
      `SELECT c.id AS claim_id, c.network, c.wallet_address, r.asset_name,
              r.metadata_uri, r.collection_address, r.candy_machine_address,
              r.candy_guard_address, r.merkle_root,
              mt.signature AS known_mint_signature,
              c.receipt_history_before
       FROM season_nft_claims c
       JOIN season_nft_releases r ON r.id = c.release_id
       LEFT JOIN LATERAL (
         SELECT t.signature
         FROM season_nft_transactions t
         JOIN season_nft_claim_attempts a ON a.id = t.attempt_id
         WHERE a.claim_id = c.id AND t.kind = 'USER_MINT'
           AND t.signature IS NOT NULL
         ORDER BY t.created_at DESC, t.id DESC LIMIT 1
       ) mt ON TRUE
       WHERE c.id = $1 AND c.state = 'CLAIMED'
         AND c.receipt_state = 'RESOLVING' AND r.state = 'READY'`,
      [claimId],
    );
    const row = result.rows[0];
    return row
      ? {
          claimId: row.claim_id,
          network: row.network,
          walletAddress: row.wallet_address,
          assetName: row.asset_name,
          metadataUri: row.metadata_uri,
          collectionAddress: row.collection_address,
          candyMachineAddress: row.candy_machine_address,
          candyGuardAddress: row.candy_guard_address,
          merkleRoot: Uint8Array.from(row.merkle_root),
          knownMintSignature: row.known_mint_signature,
          receiptHistoryBefore: row.receipt_history_before,
        }
      : null;
  }

  /** dispatcher checkpoint 뒤 user transaction과 claim identity를 복구한다. */
  async findReconciliationSources(
    transactionIds: readonly string[],
  ): Promise<readonly ClaimReconciliationSource[]> {
    if (transactionIds.length === 0) return [];
    const result = await this.pool.query<{
      transaction_id: string;
      transaction_state: SeasonNftTransactionState;
      kind: Extract<SeasonNftTransactionKind, 'USER_PROOF' | 'USER_MINT'>;
      claim_id: string;
      attempt_id: string;
      attempt_state: SeasonNftAttemptState;
      wallet_address: string;
      asset_address: string | null;
      candy_machine_address: string;
      candy_guard_address: string;
      merkle_root: Buffer;
    }>(
      `SELECT t.id AS transaction_id, t.state AS transaction_state, t.kind,
              c.id AS claim_id, a.id AS attempt_id,
              a.state AS attempt_state, c.wallet_address,
              COALESCE(t.asset_address, a.asset_address) AS asset_address,
              r.candy_machine_address, r.candy_guard_address, r.merkle_root
       FROM season_nft_transactions t
       JOIN season_nft_claim_attempts a ON a.id = t.attempt_id
       JOIN season_nft_claims c ON c.id = a.claim_id
       JOIN season_nft_releases r ON r.id = c.release_id
       WHERE t.id = ANY($1::uuid[]) AND t.kind IN ('USER_PROOF', 'USER_MINT')`,
      [transactionIds],
    );
    return result.rows.map((row) => ({
      transactionId: row.transaction_id,
      transactionState: row.transaction_state,
      kind: row.kind,
      claimId: row.claim_id,
      attemptId: row.attempt_id,
      attemptState: row.attempt_state,
      walletAddress: row.wallet_address,
      assetAddress: row.asset_address,
      candyMachineAddress: row.candy_machine_address,
      candyGuardAddress: row.candy_guard_address,
      merkleRoot: Uint8Array.from(row.merkle_root),
    }));
  }

  /** terminal transaction commit 뒤 attempt 반영 전 crash를 독립 scan으로 복구한다. */
  async findPendingReconciliationTransactionIds(
    network: SeasonNftNetwork,
    limit: number,
  ): Promise<readonly string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT t.id
       FROM season_nft_transactions t
       JOIN season_nft_claim_attempts a ON a.id = t.attempt_id
       JOIN season_nft_claims c ON c.id = a.claim_id
       WHERE c.network = $1
         AND t.kind IN ('USER_PROOF', 'USER_MINT')
         AND t.state IN ('FINALIZED', 'RECONCILED', 'FAILED', 'EXPIRED')
         AND a.state IN ('AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
         AND t.kind = CASE WHEN a.step = 'ALLOWLIST_PROOF'
                           THEN 'USER_PROOF' ELSE 'USER_MINT' END
       ORDER BY t.updated_at ASC, t.id ASC LIMIT $2`,
      [network, limit],
    );
    return result.rows.map(({ id }) => id);
  }

  /** submitted user transaction을 조회 가능한 CONFIRMING 상태로 단조 전이한다. */
  async markAttemptConfirming(
    input: Readonly<{ claimId: string; attemptId: string }>,
    transaction: TransactionContext,
  ): Promise<void> {
    await this.lockClaim(input.claimId, transaction);
    await getPgExecutor(this.pool, transaction).query(
      `UPDATE season_nft_claim_attempts
       SET state = 'CONFIRMING', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_id = $2 AND state = 'SUBMITTING'`,
      [input.attemptId, input.claimId],
    );
  }

  /** proof finalized evidence 뒤 같은 attempt만 MINT QUEUED로 이동한다. */
  async advanceAttemptToMint(
    input: Readonly<{ claimId: string; attemptId: string }>,
    transaction: TransactionContext,
  ): Promise<void> {
    await this.lockClaim(input.claimId, transaction);
    await getPgExecutor(this.pool, transaction).query(
      `UPDATE season_nft_claim_attempts
       SET state = 'QUEUED', step = 'MINT', next_attempt_at = CURRENT_TIMESTAMP,
           retry_count = 0, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_id = $2 AND step = 'ALLOWLIST_PROOF'
         AND state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')`,
      [input.attemptId, input.claimId],
    );
  }

  /** PREPARED commit과 서명 노출 상태 전이를 같은 DB transaction 안에서 수행한다. */
  async markAwaitingSignature(
    input: Readonly<{
      claimId: string;
      attemptId: string;
      step: SeasonNftAttemptStep;
      assetAddress?: string;
    }>,
    transaction: TransactionContext,
  ): Promise<boolean> {
    await this.lockClaim(input.claimId, transaction);
    const updated = await getPgExecutor(this.pool, transaction).query(
      `UPDATE season_nft_claim_attempts
       SET state = 'AWAITING_SIGNATURE',
           asset_address = COALESCE($4, asset_address),
           retry_count = 0, last_error_code = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_id = $2 AND state = 'QUEUED' AND step = $3
       RETURNING id`,
      [input.attemptId, input.claimId, input.step, input.assetAddress ?? null],
    );
    return updated.rows.length === 1;
  }

  /** 시즌·참가·usage·고정 claim과 활성 attempt를 한 actor 기준으로 읽어 create 판정 입력을 만든다. */
  async findCreateScope(
    seasonId: string,
    network: SeasonNftNetwork,
    actor: ClaimActor,
    transaction: TransactionContext,
  ): Promise<ClaimCreateScope> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      season_id: string;
      cancelled: boolean;
      force_ended: boolean;
      ended: boolean;
      participant: boolean;
      participant_wallet_account_id: string | null;
      participant_wallet_address: string | null;
      has_usage: boolean;
      release_id: string | null;
      release_state: string | null;
      claim_id: string | null;
      claim_state: SeasonNftClaimState | null;
      claim_wallet_account_id: string | null;
      claim_wallet_address: string | null;
      attempt_id: string | null;
      attempt_state: SeasonNftAttemptState | null;
    }>(
      `SELECT s.canvas_id AS season_id,
              s.cancelled_at IS NOT NULL AS cancelled,
              s.force_ended_at IS NOT NULL AS force_ended,
              c.ends_at <= CURRENT_TIMESTAMP AS ended,
              p.user_id IS NOT NULL AS participant,
              p.wallet_account_id AS participant_wallet_account_id,
              p.wallet_address AS participant_wallet_address,
              EXISTS (
                SELECT 1 FROM canvas_stroke_usages u
                WHERE u.canvas_id = s.canvas_id AND u.user_id = $3
              ) AS has_usage,
              r.id AS release_id, r.state AS release_state,
              nc.id AS claim_id, nc.state AS claim_state,
              nc.wallet_account_id AS claim_wallet_account_id,
              nc.wallet_address AS claim_wallet_address,
              a.id AS attempt_id, a.state AS attempt_state
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = 'season'
       LEFT JOIN season_participants p
         ON p.season_id = s.canvas_id AND p.user_id = $3
       LEFT JOIN season_nft_releases r
         ON r.season_id = s.canvas_id AND r.network = $2
       LEFT JOIN season_nft_claims nc
         ON nc.release_id = r.id AND nc.user_id = $3
       LEFT JOIN LATERAL (
         SELECT ca.id, ca.state
         FROM season_nft_claim_attempts ca
         WHERE ca.claim_id = nc.id
           AND ca.state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
         ORDER BY ca.created_at DESC, ca.id DESC LIMIT 1
       ) a ON TRUE
       WHERE s.canvas_id = $1`,
      [seasonId, network, actor.userId],
    );
    const row = result.rows[0];
    if (!row) {
      return {
        seasonExists: false,
        cancelled: false,
        forceEnded: false,
        ended: false,
        participant: false,
        participantWalletAccountId: null,
        participantWalletAddress: null,
        hasUsage: false,
        releaseId: null,
        releaseState: null,
        claimId: null,
        claimState: null,
        claimWalletAccountId: null,
        claimWalletAddress: null,
        activeAttemptId: null,
        activeAttemptState: null,
      };
    }
    return {
      seasonExists: true,
      cancelled: row.cancelled,
      forceEnded: row.force_ended,
      ended: row.ended,
      participant: row.participant,
      participantWalletAccountId: row.participant_wallet_account_id,
      participantWalletAddress: row.participant_wallet_address,
      hasUsage: row.has_usage,
      releaseId: row.release_id,
      releaseState: row.release_state,
      claimId: row.claim_id,
      claimState: row.claim_state,
      claimWalletAccountId: row.claim_wallet_account_id,
      claimWalletAddress: row.claim_wallet_address,
      activeAttemptId: row.attempt_id,
      activeAttemptState: row.attempt_state,
    };
  }

  /** season, attempt, user와 두 지갑 식별자가 모두 맞는 시도만 조회하고 서명 대기 거래만 노출한다. */
  async findOwnAttempt(
    seasonId: string,
    attemptId: string,
    actor: ClaimActor,
    transaction: TransactionContext,
  ): Promise<OwnClaimAttempt | null> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      claim_id: string;
      release_id: string;
      network: SeasonNftNetwork;
      attempt_id: string;
      attempt_state: SeasonNftAttemptState;
      attempt_step: SeasonNftAttemptStep;
      wallet_address: string;
      asset_address: string | null;
      last_error_code: string | null;
      transaction_id: string | null;
      serialized_transaction: Buffer | null;
      last_valid_block_height: string | null;
      estimated_cost_lamports: string | null;
      estimated_at: Date | null;
    }>(
      `SELECT nc.id AS claim_id, r.id AS release_id, r.network,
              a.id AS attempt_id, a.state AS attempt_state,
              a.step AS attempt_step, nc.wallet_address, a.asset_address,
              a.last_error_code, tx.id AS transaction_id,
              tx.serialized_transaction, tx.last_valid_block_height,
              tx.estimated_cost_lamports, tx.estimated_at
       FROM season_nft_claim_attempts a
       JOIN season_nft_claims nc ON nc.id = a.claim_id
       JOIN season_nft_releases r ON r.id = nc.release_id
       LEFT JOIN LATERAL (
         SELECT t.id, t.serialized_transaction, t.last_valid_block_height,
                t.estimated_cost_lamports, t.estimated_at
         FROM season_nft_transactions t
         WHERE t.attempt_id = a.id AND t.state = 'PREPARED'
           AND t.estimated_at > CURRENT_TIMESTAMP - interval '60 seconds'
           AND t.kind = CASE WHEN a.step = 'ALLOWLIST_PROOF'
                             THEN 'USER_PROOF' ELSE 'USER_MINT' END
         ORDER BY t.created_at DESC, t.id DESC LIMIT 1
       ) tx ON a.state = 'AWAITING_SIGNATURE'
       WHERE r.season_id = $1 AND a.id = $2
         AND nc.user_id = $3 AND nc.wallet_account_id = $4
         AND nc.wallet_address = $5`,
      [
        seasonId,
        attemptId,
        actor.userId,
        actor.walletAccountId,
        actor.walletAddress,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const transactionView =
      row.transaction_id &&
      row.serialized_transaction &&
      row.last_valid_block_height !== null &&
      row.estimated_cost_lamports !== null &&
      row.estimated_at
        ? {
            transactionId: row.transaction_id,
            serializedTransaction: row.serialized_transaction,
            lastValidBlockHeight: BigInt(row.last_valid_block_height),
            estimatedCostLamports: BigInt(row.estimated_cost_lamports),
            estimatedAt: row.estimated_at,
          }
        : null;
    return {
      claimId: row.claim_id,
      releaseId: row.release_id,
      network: row.network,
      attemptId: row.attempt_id,
      state: row.attempt_state,
      step: row.attempt_step,
      walletAddress: row.wallet_address,
      assetAddress: row.asset_address,
      errorCode: row.last_error_code,
      transaction: transactionView,
    };
  }

  /** CLAIMED/RESOLVING을 attempt·transaction 유무와 무관하게 선점하고 다음 확인 시각을 먼저 저장한다. */
  async claimDueReceipts(
    input: Readonly<{
      network: SeasonNftNetwork;
      limit: number;
      claimDurationMs: number;
    }>,
  ): Promise<readonly DueReceiptClaim[]> {
    return withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const executor = getPgExecutor(this.pool, transaction);
        const candidates = await executor.query<{ id: string }>(
          `SELECT id FROM season_nft_claims
           WHERE network = $1 AND state = 'CLAIMED' AND receipt_state = 'RESOLVING'
             AND receipt_next_check_at <= statement_timestamp()
           ORDER BY receipt_next_check_at ASC, created_at ASC, id ASC
           LIMIT $2`,
          [input.network, input.limit],
        );
        const claimed: DueReceiptClaim[] = [];
        for (const candidate of candidates.rows) {
          const claim = await this.lockClaim(candidate.id, transaction);
          if (
            claim.state !== 'CLAIMED' ||
            claim.network !== input.network ||
            claim.receipt_state !== 'RESOLVING' ||
            claim.receipt_next_check_at === null
          ) {
            continue;
          }
          const updated = await executor.query(
            `UPDATE season_nft_claims
             SET receipt_next_check_at = statement_timestamp() +
                   ($2::double precision * interval '1 millisecond'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND state = 'CLAIMED' AND receipt_state = 'RESOLVING'
               AND receipt_next_check_at <= statement_timestamp()
             RETURNING id`,
            [claim.id, input.claimDurationMs],
          );
          // 잠금 대기 중 다른 선점이 due 시각을 바꿨으면 stale 후보를 건너뛴다.
          if (updated.rows.length === 0) continue;
          claimed.push({
            claimId: claim.id,
            retryCount: claim.receipt_retry_count,
          });
        }
        return claimed;
      }),
    );
  }

  /** receipt lookup 실패를 CLAIMED 상태로 유지하며 durable backoff만 증가시킨다. */
  async rescheduleReceipt(
    input: Readonly<{
      claimId: string;
      retryDelayMs: number;
      historyBefore?: string | null;
    }>,
  ): Promise<void> {
    await withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const claim = await this.lockClaim(input.claimId, transaction);
        if (claim.state !== 'CLAIMED' || claim.receipt_state !== 'RESOLVING')
          return;
        await getPgExecutor(this.pool, transaction).query(
          `UPDATE season_nft_claims
           SET receipt_retry_count = receipt_retry_count + 1,
               receipt_next_check_at = statement_timestamp() +
                 ($2::double precision * interval '1 millisecond'),
               receipt_history_before = CASE WHEN $3 THEN $4
                                             ELSE receipt_history_before END,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = 'CLAIMED' AND receipt_state = 'RESOLVING'`,
          [
            input.claimId,
            input.retryDelayMs,
            Object.hasOwn(input, 'historyBefore'),
            input.historyBefore ?? null,
          ],
        );
      }),
    );
  }

  /** QUEUED attempt를 claim 잠금 아래 선점해 future builder가 DB 상태에서 재시작되게 한다. */
  async claimDueAttempts(
    input: Readonly<{
      network: SeasonNftNetwork;
      limit: number;
      claimDurationMs: number;
    }>,
  ): Promise<readonly DueClaimAttempt[]> {
    return withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const executor = getPgExecutor(this.pool, transaction);
        const candidates = await executor.query<{
          id: string;
          claim_id: string;
        }>(
          `SELECT a.id, a.claim_id FROM season_nft_claim_attempts a
           JOIN season_nft_claims c ON c.id = a.claim_id
           WHERE c.network = $1 AND a.state = 'QUEUED'
             AND a.next_attempt_at <= statement_timestamp()
           ORDER BY a.next_attempt_at ASC, a.created_at ASC, a.id ASC
           LIMIT $2`,
          [input.network, input.limit],
        );
        const claimed: DueClaimAttempt[] = [];
        for (const candidate of candidates.rows) {
          await this.lockClaim(candidate.claim_id, transaction);
          const attempt = (
            await executor.query<AttemptRow>(
              `SELECT id, claim_id, state, step, next_attempt_at, created_at,
                      retry_count
               FROM season_nft_claim_attempts WHERE id = $1 FOR UPDATE`,
              [candidate.id],
            )
          ).rows[0];
          if (!attempt || attempt.state !== 'QUEUED') {
            continue;
          }
          const updated = await executor.query(
            `UPDATE season_nft_claim_attempts
             SET next_attempt_at = statement_timestamp() +
                   ($2::double precision * interval '1 millisecond'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND state = 'QUEUED'
               AND next_attempt_at <= statement_timestamp()
             RETURNING id`,
            [attempt.id, input.claimDurationMs],
          );
          // 잠금 대기 중 다른 선점이 due 시각을 바꿨으면 stale 후보를 건너뛴다.
          if (updated.rows.length === 0) continue;
          claimed.push({
            attemptId: attempt.id,
            claimId: attempt.claim_id,
            step: attempt.step,
            retryCount: attempt.retry_count,
          });
        }
        return claimed;
      }),
    );
  }

  /** builder transient 실패는 attempt를 종료하지 않고 durable next_attempt_at만 갱신한다. */
  async rescheduleAttempt(
    input: Readonly<{
      attemptId: string;
      claimId: string;
      retryDelayMs: number;
      errorCode: string;
    }>,
  ): Promise<void> {
    await withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        await this.lockClaim(input.claimId, transaction);
        await getPgExecutor(this.pool, transaction).query(
          `UPDATE season_nft_claim_attempts
           SET next_attempt_at = statement_timestamp() +
                 ($3::double precision * interval '1 millisecond'),
               last_error_code = $4,
               retry_count = retry_count + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND claim_id = $2 AND state = 'QUEUED'`,
          [input.attemptId, input.claimId, input.retryDelayMs, input.errorCode],
        );
      }),
    );
  }

  /** 인증 사용자와 고정 참가 지갑이 모두 일치하는 claim만 반환한다. */
  async findOwnClaim(
    input: Readonly<{
      releaseId: string;
      userId: string;
      walletAccountId: string;
      walletAddress: string;
    }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{
    id: string;
    state: SeasonNftClaimState;
    receiptState: SeasonNftReceiptState;
  }> | null> {
    const result = await getPgExecutor(this.pool, transaction).query<ClaimRow>(
      `SELECT id, release_id, network, state, receipt_state, user_id,
              wallet_account_id, wallet_address
       FROM season_nft_claims
       WHERE release_id = $1 AND user_id = $2
         AND wallet_account_id = $3 AND wallet_address = $4`,
      [
        input.releaseId,
        input.userId,
        input.walletAccountId,
        input.walletAddress,
      ],
    );
    const claim = result.rows[0];
    return claim
      ? { id: claim.id, state: claim.state, receiptState: claim.receipt_state }
      : null;
  }

  /** claim을 잠근 뒤 기존 활성 attempt를 재사용하고 없을 때만 새 QUEUED attempt를 만든다. */
  async getOrCreateAttempt(
    input: Readonly<{ claimId: string; step?: SeasonNftAttemptStep }>,
    transaction: TransactionContext,
  ): Promise<GetOrCreateAttemptResult> {
    const executor = getPgExecutor(this.pool, transaction);
    const claim = await this.lockClaim(input.claimId, transaction);
    // CLAIMED는 receipt 확인 중이어도 단조 완료 상태이므로 새 attempt를 만들지 않는다.
    if (claim.state === 'CLAIMED') {
      return {
        created: false,
        claimState: claim.state,
        attemptId: null,
        attemptState: null,
      };
    }
    const active = await executor.query<AttemptRow>(
      `SELECT id, claim_id, state, step
       FROM season_nft_claim_attempts
       WHERE claim_id = $1
         AND state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
       FOR UPDATE`,
      [input.claimId],
    );
    if (active.rows[0]) {
      return {
        created: false,
        claimState: 'PROCESSING',
        attemptId: active.rows[0].id,
        attemptState: active.rows[0].state,
      };
    }

    const attemptId = randomUUID();
    const inserted = await executor.query<AttemptRow>(
      `INSERT INTO season_nft_claim_attempts (id, claim_id, state, step)
       VALUES ($1, $2, 'QUEUED', $3)
       ON CONFLICT (claim_id)
         WHERE state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
       DO NOTHING
       RETURNING id, claim_id, state, step`,
      [attemptId, input.claimId, input.step ?? 'ALLOWLIST_PROOF'],
    );
    const attempt =
      inserted.rows[0] ??
      (
        await executor.query<AttemptRow>(
          `SELECT id, claim_id, state, step
           FROM season_nft_claim_attempts
           WHERE claim_id = $1
             AND state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
           FOR UPDATE`,
          [input.claimId],
        )
      ).rows[0];
    if (!attempt)
      throw new Error('Season NFT active attempt could not be recovered.');
    await executor.query(
      `UPDATE season_nft_claims
       SET state = 'PROCESSING', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'UNCLAIMED'`,
      [input.claimId],
    );
    return {
      created: inserted.rows.length === 1,
      claimState: 'PROCESSING',
      attemptId: attempt.id,
      attemptState: attempt.state,
    };
  }

  /** mint 효과를 확인한 claim은 CLAIMED를 유지하며 receipt 증거 유무에 따라 복구 또는 완료로 기록한다. */
  async completeClaim(
    input: Readonly<{
      claimId: string;
      attemptId?: string;
      receiptState: Extract<SeasonNftReceiptState, 'RESOLVING' | 'VERIFIED'>;
      assetAddress?: string;
      mintSignature?: string;
      claimedAt?: Date;
    }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    if (
      input.receiptState === 'VERIFIED' &&
      (!input.assetAddress || !input.mintSignature || !input.claimedAt)
    ) {
      throw new Error('Verified season NFT receipt evidence is incomplete.');
    }
    const executor = getPgExecutor(this.pool, transaction);
    const claim = await this.lockClaim(input.claimId, transaction);
    // worker가 연결된 attempt를 알고 있으면 잠그고 완료한다. Counter 기반 receipt 복구는 attempt 없이도 진행한다.
    if (input.attemptId) {
      const attempt = await executor.query<AttemptRow>(
        `SELECT id, claim_id, state, step
         FROM season_nft_claim_attempts
         WHERE id = $1 AND claim_id = $2 FOR UPDATE`,
        [input.attemptId, input.claimId],
      );
      if (!attempt.rows[0])
        throw new Error('Season NFT attempt does not belong to the claim.');
      if (
        ![
          'QUEUED',
          'AWAITING_SIGNATURE',
          'SUBMITTING',
          'CONFIRMING',
          'SUCCEEDED',
        ].includes(attempt.rows[0].state)
      ) {
        throw new Error(
          'Season NFT terminal attempt cannot complete the claim.',
        );
      }

      await executor.query(
        `UPDATE season_nft_claim_attempts
         SET state = 'SUCCEEDED', asset_address = COALESCE($3, asset_address),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND claim_id = $2
           AND state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')`,
        [input.attemptId, input.claimId, input.assetAddress ?? null],
      );
    } else {
      // Counter 기반 복구가 활성 attempt를 발견하면 같은 claim 잠금 아래 종료해 재전송을 막는다.
      await executor.query(
        `UPDATE season_nft_claim_attempts
         SET state = 'SUCCEEDED', asset_address = COALESCE($2, asset_address),
             updated_at = CURRENT_TIMESTAMP
         WHERE claim_id = $1
           AND state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')`,
        [input.claimId, input.assetAddress ?? null],
      );
    }
    if (claim.state !== 'CLAIMED') {
      const completed = await executor.query(
        `UPDATE season_nft_claims
         SET state = 'CLAIMED', receipt_state = $2,
             asset_address = $3, mint_signature = $4, claimed_at = $5,
             receipt_next_check_at = CASE WHEN $2 = 'RESOLVING'
                                          THEN CURRENT_TIMESTAMP ELSE NULL END,
             receipt_retry_count = 0, receipt_history_before = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state IN ('UNCLAIMED', 'PROCESSING')
         RETURNING id`,
        [
          input.claimId,
          input.receiptState,
          input.assetAddress ?? null,
          input.mintSignature ?? null,
          input.claimedAt ?? null,
        ],
      );
      return { updated: completed.rows.length === 1 };
    }
    // CLAIMED/RESOLVING 후속 조회는 CLAIMED를 되돌리지 않고 receipt 증거만 완성한다.
    if (
      input.receiptState === 'VERIFIED' &&
      claim.receipt_state === 'RESOLVING'
    ) {
      const verified = await executor.query(
        `UPDATE season_nft_claims
         SET receipt_state = 'VERIFIED', asset_address = $2,
             mint_signature = $3, claimed_at = $4,
             receipt_next_check_at = NULL, receipt_retry_count = 0,
             receipt_history_before = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND state = 'CLAIMED' AND receipt_state = 'RESOLVING'
         RETURNING id`,
        [
          input.claimId,
          input.assetAddress,
          input.mintSignature,
          input.claimedAt,
        ],
      );
      return { updated: verified.rows.length === 1 };
    }
    return { updated: false };
  }

  /** attempt가 예상 상태일 때만 종료하고 아직 PROCESSING인 claim만 다시 UNCLAIMED로 연다. */
  async failAttempt(
    input: Readonly<{
      claimId: string;
      attemptId: string;
      expectedState: SeasonNftAttemptState;
      state: Extract<SeasonNftAttemptState, 'FAILED' | 'EXPIRED'>;
      errorCode: string;
      nextAttemptAt?: Date;
    }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    // 종료 또는 과거 attempt를 다시 적용해 현재 PROCESSING claim을 여는 요청은 lost-race로 처리한다.
    if (
      !['QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING'].includes(
        input.expectedState,
      )
    ) {
      return { updated: false };
    }
    const executor = getPgExecutor(this.pool, transaction);
    await this.lockClaim(input.claimId, transaction);
    await executor.query(
      `SELECT id FROM season_nft_claim_attempts
       WHERE id = $1 AND claim_id = $2 FOR UPDATE`,
      [input.attemptId, input.claimId],
    );
    const failed = await executor.query(
      `UPDATE season_nft_claim_attempts
       SET state = $4, last_error_code = $5,
           next_attempt_at = COALESCE($6, next_attempt_at),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND claim_id = $2 AND state = $3
       RETURNING id`,
      [
        input.attemptId,
        input.claimId,
        input.expectedState,
        input.state,
        input.errorCode,
        input.nextAttemptAt ?? null,
      ],
    );
    if (failed.rows.length === 0) return { updated: false };
    await executor.query(
      `UPDATE season_nft_claims
       SET state = 'UNCLAIMED', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'PROCESSING'`,
      [input.claimId],
    );
    return { updated: true };
  }

  /** season, release, claim 순서로 잠가 attempt 쓰기 전에 claim의 최신 단조 상태를 읽는다. */
  private async lockClaim(
    claimId: string,
    transaction: TransactionContext,
  ): Promise<ClaimRow> {
    const executor = getPgExecutor(this.pool, transaction);
    const identity = await executor.query<{
      release_id: string;
      season_id: string;
    }>(
      `SELECT c.release_id, r.season_id
       FROM season_nft_claims c
       JOIN season_nft_releases r ON r.id = c.release_id
       WHERE c.id = $1`,
      [claimId],
    );
    if (!identity.rows[0]) throw new Error('Season NFT claim was not found.');
    await executor.query(
      `SELECT canvas_id FROM seasons WHERE canvas_id = $1 FOR UPDATE`,
      [identity.rows[0].season_id],
    );
    await executor.query(
      `SELECT id FROM season_nft_releases WHERE id = $1 FOR UPDATE`,
      [identity.rows[0].release_id],
    );
    const claim = await executor.query<ClaimRow>(
      `SELECT id, release_id, network, state, receipt_state, user_id,
              wallet_account_id, wallet_address, receipt_next_check_at,
              receipt_retry_count, created_at
       FROM season_nft_claims WHERE id = $1 FOR UPDATE`,
      [claimId],
    );
    return claim.rows[0];
  }
}
