import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type { LifecycleSnapshot } from '../canvas-drawing/canvas-drawing';

export type SeasonCanvasFacts = LifecycleSnapshot &
  Readonly<{ isParticipant: boolean }>;

/** Canvas가 시즌 공개 범위와 참가 사실을 읽는 전용 쿼리다. */
@Injectable()
export class SeasonCanvasQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 한 DB 시각으로 시즌 lifecycle과 선택 사용자의 참가 여부를 읽는다. */
  async observe(
    canvasId: string,
    userId: string | undefined,
    transaction?: TransactionContext,
  ): Promise<SeasonCanvasFacts | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SeasonCanvasFacts>(
      `SELECT s.creator_id AS "creatorId", c.starts_at AS "startsAt",
              c.ends_at AS "endsAt", s.cancelled_at AS "cancelledAt",
              s.force_ended_at AS "forceEndedAt",
              date_trunc('milliseconds', clock_timestamp()) AS "observedAt",
              CASE WHEN $2::uuid IS NULL THEN false ELSE EXISTS (
                SELECT 1 FROM season_participants p
                WHERE p.season_id = s.canvas_id AND p.user_id = $2::uuid
              ) END AS "isParticipant"
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
       WHERE s.canvas_id = $1 AND s.canvas_type = 'season'`,
      [canvasId, userId ?? null],
    );
    return result.rows[0];
  }

  /** lifecycle transaction이 변경할 시즌 행만 잠그고 상태 판정은 뒤의 admission 조회에 맡긴다. */
  async lock(
    canvasId: string,
    transaction: TransactionContext,
  ): Promise<boolean> {
    const result = await getPgExecutor(this.pool, transaction).query(
      `SELECT 1 FROM seasons s
       WHERE s.canvas_id = $1 AND s.canvas_type = 'season'
       FOR UPDATE OF s`,
      [canvasId],
    );
    return result.rowCount === 1;
  }

  /** 시즌 잠금 대기 뒤 별도 SELECT에서 DB 시각과 최신 참가·종료 사실을 함께 읽는다. */
  admission(
    canvasId: string,
    userId: string,
    transaction: TransactionContext,
  ): Promise<SeasonCanvasFacts | undefined> {
    return this.observe(canvasId, userId, transaction);
  }

  /** resident 시즌들의 공개 lifecycle을 한 쿼리로 읽고 ID별 스냅샷으로 반환한다. */
  async states(
    canvasIds: readonly string[],
  ): Promise<Map<string, LifecycleSnapshot>> {
    // 빈 resident 목록에는 DB 호출을 만들지 않는다.
    if (canvasIds.length === 0) return new Map();
    const result = await this.pool.query<
      LifecycleSnapshot & { canvasId: string }
    >(
      `WITH observed AS MATERIALIZED (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS time
       )
       SELECT s.canvas_id AS "canvasId", s.creator_id AS "creatorId",
              c.starts_at AS "startsAt", c.ends_at AS "endsAt",
              s.cancelled_at AS "cancelledAt",
              s.force_ended_at AS "forceEndedAt",
              observed.time AS "observedAt"
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
       CROSS JOIN observed
       WHERE s.canvas_type = 'season' AND s.canvas_id = ANY($1::uuid[])`,
      [canvasIds],
    );
    return new Map(
      result.rows.map(({ canvasId, ...state }) => [canvasId, state]),
    );
  }
}
