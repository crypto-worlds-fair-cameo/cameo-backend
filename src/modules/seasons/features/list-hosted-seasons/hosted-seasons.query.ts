import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';

export type HostedSeasonRecord = Readonly<{
  seasonId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  forceEndedAt: Date | null;
  observedAt: Date;
  participantCount: number;
  finalImageKey: string | null;
}>;

/** 현재 사용자가 개설한 시즌을 취소·종료 시즌까지 포함해 생성 역순으로 읽는다. */
@Injectable()
export class HostedSeasonsQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async count(
    userId: string,
    transaction: TransactionContext,
  ): Promise<number> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      total: number;
    }>(
      `SELECT count(*)::integer AS total
       FROM seasons
       WHERE creator_id = $1`,
      [userId],
    );
    return result.rows[0].total;
  }

  async list(
    input: Readonly<{ userId: string; limit: number; offset: number }>,
    transaction: TransactionContext,
  ): Promise<HostedSeasonRecord[]> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<HostedSeasonRecord>(
      `WITH season_page AS (
         SELECT s.canvas_id, s.title, s.cancelled_at, s.force_ended_at,
                s.created_at, c.starts_at, c.ends_at
         FROM seasons s
         JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
         WHERE s.creator_id = $1
         ORDER BY s.created_at DESC, s.canvas_id DESC
         LIMIT $2 OFFSET $3
       ), participant_counts AS (
         SELECT p.season_id, count(*)::integer AS count
         FROM season_participants p
         JOIN season_page page ON page.canvas_id = p.season_id
         GROUP BY p.season_id
       )
       SELECT page.canvas_id AS "seasonId", page.title,
              page.starts_at AS "startsAt", page.ends_at AS "endsAt",
              page.cancelled_at AS "cancelledAt",
              page.force_ended_at AS "forceEndedAt",
              CURRENT_TIMESTAMP AS "observedAt",
              COALESCE(counts.count, 0)::integer AS "participantCount",
              final_snapshot.image_key AS "finalImageKey"
       FROM season_page page
       LEFT JOIN participant_counts counts ON counts.season_id = page.canvas_id
       LEFT JOIN canvas_snapshots final_snapshot
         ON final_snapshot.canvas_id = page.canvas_id
        AND final_snapshot.status = 'READY' AND final_snapshot.is_final = true
       ORDER BY page.created_at DESC, page.canvas_id DESC`,
      [input.userId, input.limit, input.offset],
    );
    return result.rows;
  }
}
