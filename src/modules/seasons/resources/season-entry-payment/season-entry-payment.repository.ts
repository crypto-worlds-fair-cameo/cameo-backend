import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';
import type {
  SeasonEntryPaymentRecord,
  SeasonEntryPaymentStatus,
} from './season-entry-payment';

type PaymentRow = Readonly<{
  id: string;
  season_id: string;
  user_id: string;
  wallet_account_id: string;
  payer_address: string;
  recipient_address: string;
  network: SeasonNftNetwork;
  lamports: string;
  status: SeasonEntryPaymentStatus;
  prepared_transaction: Buffer;
  message_hash: string;
  signature: string | null;
  last_valid_block_height: string;
  expires_at: Date;
}>;

const PAYMENT_COLUMNS = `id, season_id, user_id, wallet_account_id, payer_address,
  recipient_address, network, lamports::text AS lamports, status,
  prepared_transaction, message_hash, signature,
  last_valid_block_height::text AS last_valid_block_height, expires_at`;

function toRecord(row: PaymentRow): SeasonEntryPaymentRecord {
  return {
    id: row.id,
    seasonId: row.season_id,
    userId: row.user_id,
    walletAccountId: row.wallet_account_id,
    payerAddress: row.payer_address,
    recipientAddress: row.recipient_address,
    network: row.network,
    lamports: row.lamports,
    status: row.status,
    preparedTransaction: row.prepared_transaction,
    messageHash: row.message_hash,
    signature: row.signature,
    lastValidBlockHeight: BigInt(row.last_valid_block_height),
    expiresAt: row.expires_at,
  };
}

export type SeasonEntryPaymentInsert = Readonly<{
  seasonId: string;
  userId: string;
  walletAccountId: string;
  payerAddress: string;
  recipientAddress: string;
  network: SeasonNftNetwork;
  lamports: bigint;
  preparedTransaction: Buffer;
  messageHash: string;
  lastValidBlockHeight: bigint;
  expiresAt: Date;
  time: Date;
}>;

/** 입장료 결제 기록과 결제 중 정원 예약을 저장하고 조회한다. */
@Injectable()
export class SeasonEntryPaymentRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 개설 때 고정한 입장료 수령 지갑을 읽는다. 무료 시즌은 null이다. */
  async readFeeRecipient(
    seasonId: string,
    transaction: TransactionContext,
  ): Promise<string | null> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      recipient: string | null;
    }>(
      `SELECT entry_fee_recipient AS recipient
       FROM seasons WHERE canvas_id = $1`,
      [seasonId],
    );
    return result.rows[0]?.recipient ?? null;
  }

  /** 사용자의 서명 대기·제출 중 결제를 잠근다. 시즌 행 잠금 뒤에 호출한다. */
  async lockOpen(
    seasonId: string,
    userId: string,
    transaction: TransactionContext,
  ): Promise<SeasonEntryPaymentRecord | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS}
       FROM season_entry_payments
       WHERE season_id = $1 AND user_id = $2
         AND status IN ('AWAITING_SIGNATURE', 'SUBMITTED')
       FOR UPDATE`,
      [seasonId, userId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  /** 다른 사용자의 기한 안 서명 대기와 제출 중 결제를 정원 예약으로 센다. */
  async countReservedSeats(
    seasonId: string,
    excludedUserId: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<number> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      count: number;
    }>(
      `SELECT count(*)::integer AS count
       FROM season_entry_payments
       WHERE season_id = $1 AND user_id <> $2
         AND (
           status = 'SUBMITTED'
           OR (status = 'AWAITING_SIGNATURE' AND expires_at > $3::timestamptz)
         )`,
      [seasonId, excludedUserId, time],
    );
    return result.rows[0].count;
  }

  async insert(
    input: SeasonEntryPaymentInsert,
    transaction: TransactionContext,
  ): Promise<SeasonEntryPaymentRecord> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<PaymentRow>(
      `INSERT INTO season_entry_payments
         (season_id, user_id, wallet_account_id, payer_address,
          recipient_address, network, lamports, status, prepared_transaction,
          message_hash, last_valid_block_height, expires_at,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'AWAITING_SIGNATURE', $8, $9, $10,
               $11, $12, $12)
       RETURNING ${PAYMENT_COLUMNS}`,
      [
        input.seasonId,
        input.userId,
        input.walletAccountId,
        input.payerAddress,
        input.recipientAddress,
        input.network,
        input.lamports.toString(),
        input.preparedTransaction,
        input.messageHash,
        input.lastValidBlockHeight.toString(),
        input.expiresAt,
        input.time,
      ],
    );
    return toRecord(result.rows[0]);
  }

  /** 현재 사용자와 시즌에 속한 결제만 찾는다. lock이면 행을 잠근다. */
  async findOwned(
    input: Readonly<{ paymentId: string; seasonId: string; userId: string }>,
    transaction: TransactionContext,
    lock = false,
  ): Promise<SeasonEntryPaymentRecord | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<PaymentRow>(
      `SELECT ${PAYMENT_COLUMNS}
       FROM season_entry_payments
       WHERE id = $1 AND season_id = $2 AND user_id = $3
       ${lock ? 'FOR UPDATE' : ''}`,
      [input.paymentId, input.seasonId, input.userId],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : undefined;
  }

  async markSubmitted(
    paymentId: string,
    signature: string,
    transaction: TransactionContext,
  ): Promise<SeasonEntryPaymentRecord> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<PaymentRow>(
      `UPDATE season_entry_payments
       SET status = 'SUBMITTED', signature = $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'AWAITING_SIGNATURE'
       RETURNING ${PAYMENT_COLUMNS}`,
      [paymentId, signature],
    );
    if (!result.rows[0])
      throw new Error('Season entry payment submission update failed.');
    return toRecord(result.rows[0]);
  }

  /** 열린 결제를 확정·실패·만료 중 하나로 끝낸다. */
  async finish(
    paymentId: string,
    status: Extract<
      SeasonEntryPaymentStatus,
      'CONFIRMED' | 'FAILED' | 'EXPIRED'
    >,
    transaction: TransactionContext,
  ): Promise<SeasonEntryPaymentRecord> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<PaymentRow>(
      `UPDATE season_entry_payments
       SET status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status IN ('AWAITING_SIGNATURE', 'SUBMITTED')
       RETURNING ${PAYMENT_COLUMNS}`,
      [paymentId, status],
    );
    if (!result.rows[0])
      throw new Error('Season entry payment status update failed.');
    return toRecord(result.rows[0]);
  }
}
