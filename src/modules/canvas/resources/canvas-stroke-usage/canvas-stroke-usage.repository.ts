import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { CanvasStrokeError } from '../canvas-stroke/canvas-stroke';

/** 좌표와 별도로 계정의 획 사용을 기록하며 중단된 획도 사용 횟수에 포함한다. */
@Injectable()
export class CanvasStrokeUsageRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 인증이 잠근 사용자 행을 커밋까지 유지하는 동일 트랜잭션에서만 차감한다. */
  async consumeMain(
    userId: string,
    clientStrokeId: string,
    transaction: TransactionContext,
  ): Promise<string> {
    const executor = getPgExecutor(this.pool, transaction);
    // 사용자 잠금이 동시 탭의 검사와 INSERT를 직렬화하므로 모두 같은 남은 획을 사용할 수 없다.
    const result = await executor.query<{
      id: string;
      stroke_limit_per_user: number;
      used: number;
      repeated: boolean;
    }>(
      `SELECT c.id, c.stroke_limit_per_user, count(u.id)::integer AS used,
              COALESCE(bool_or(u.client_stroke_id = $2::uuid), false) AS repeated
       FROM canvases c LEFT JOIN canvas_stroke_usages u
         ON u.canvas_id = c.id AND u.user_id = $1
       WHERE c.type = 'main' GROUP BY c.id`,
      [userId, clientStrokeId],
    );
    const canvas = result.rows[0];
    // 메인 설정이 없으면 차감하거나 임의의 새 캔버스를 만들지 않는다.
    if (!canvas) throw new Error('Main canvas is missing.');
    // 메모리에 없는 과거 획 ID를 재사용해 새로운 그림을 무료로 시작하는 것을 막는다.
    if (canvas.repeated)
      throw new CanvasStrokeError(
        'STROKE_ALREADY_USED',
        'This stroke has already been used.',
      );
    if (canvas.used >= canvas.stroke_limit_per_user)
      throw new CanvasStrokeError(
        'STROKE_LIMIT_REACHED',
        'Stroke limit has been reached.',
      );
    const inserted = await executor.query<{ id: string }>(
      `INSERT INTO canvas_stroke_usages (canvas_id, user_id, client_stroke_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [canvas.id, userId, clientStrokeId],
    );
    return inserted.rows[0].id;
  }

  /** 정상 종료한 기존 사용 기록만 갱신하며 최초 사용 시각과 이미 기록한 완료 시각을 유지한다. */
  async completeMain(
    userId: string,
    clientStrokeId: string,
    transaction: TransactionContext,
  ): Promise<void> {
    const result = await getPgExecutor(this.pool, transaction).query(
      `WITH completed AS (
         UPDATE canvas_stroke_usages u
         SET completed_at = GREATEST(clock_timestamp(), u.used_at)
         FROM canvases c
         WHERE c.id = u.canvas_id AND c.type = 'main'
           AND u.user_id = $1 AND u.client_stroke_id = $2
           AND u.completed_at IS NULL RETURNING u.canvas_id
       ), advanced AS (
         UPDATE canvases c SET last_sequence = c.last_sequence + 1
         FROM completed WHERE completed.canvas_id = c.id RETURNING c.id
       )
       SELECT u.id FROM canvas_stroke_usages u JOIN canvases c ON c.id = u.canvas_id
       WHERE c.type = 'main' AND u.user_id = $1 AND u.client_stroke_id = $2`,
      [userId, clientStrokeId],
    );
    // 기록 없는 완료는 승인하지 않아 메모리와 DB의 완료 상태가 어긋나지 않게 한다.
    if (result.rowCount !== 1) throw new Error('Stroke usage is missing.');
  }

  /** COMMIT 응답이 유실됐을 때 정확한 최초 사용 기록의 실제 저장 여부를 조회한다. */
  async recordedMain(
    userId: string,
    clientStrokeId: string,
    usageId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT u.id FROM canvas_stroke_usages u JOIN canvases c ON c.id = u.canvas_id
       WHERE c.type = 'main' AND u.user_id = $1 AND u.client_stroke_id = $2 AND u.id = $3`,
      [userId, clientStrokeId, usageId],
    );
    return result.rowCount === 1;
  }
}
