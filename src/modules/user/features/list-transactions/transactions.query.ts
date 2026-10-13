import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type { SeasonNftNetwork } from '../../../season-nfts/resources/season-nft/season-nft';

export type TransactionRecord = Readonly<{
  id: string;
  direction: 'outgoing' | 'incoming';
  seasonId: string;
  seasonTitle: string;
  lamports: string;
  network: SeasonNftNetwork;
  signature: string;
  occurredAt: Date;
}>;

type TransactionFilter = Readonly<{
  userId: string;
  network: SeasonNftNetwork | null;
}>;

// 확정된 입장료만 실제 SOL 이동이다. 참가자는 보낸 결제, 개설자는 자기 시즌으로 받은 결제를 본다.
const CONFIRMED_ENTRIES = `
  FROM season_entry_payments payment
  JOIN seasons season ON season.canvas_id = payment.season_id
  WHERE payment.status = 'CONFIRMED'
    AND ($2::text IS NULL OR payment.network = $2::text)
    AND (payment.user_id = $1 OR season.creator_id = $1)`;

@Injectable()
export class TransactionsQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async count(
    filter: TransactionFilter,
    transaction: TransactionContext,
  ): Promise<number> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      total: number;
    }>(`SELECT count(*)::integer AS total ${CONFIRMED_ENTRIES}`, [
      filter.userId,
      filter.network,
    ]);
    return result.rows[0].total;
  }

  async list(
    input: TransactionFilter & Readonly<{ limit: number; offset: number }>,
    transaction: TransactionContext,
  ): Promise<TransactionRecord[]> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<TransactionRecord>(
      `SELECT payment.id,
              CASE WHEN payment.user_id = $1 THEN 'outgoing' ELSE 'incoming' END
                AS direction,
              payment.season_id AS "seasonId", season.title AS "seasonTitle",
              payment.lamports::text AS lamports, payment.network,
              payment.signature, payment.updated_at AS "occurredAt"
       ${CONFIRMED_ENTRIES}
       ORDER BY payment.updated_at DESC, payment.id DESC
       LIMIT $3 OFFSET $4`,
      [input.userId, input.network, input.limit, input.offset],
    );
    return result.rows;
  }
}
