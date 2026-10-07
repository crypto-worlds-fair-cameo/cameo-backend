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

  /** 인증이 잠근 사용자 행과 같은 트랜잭션에서 대상별 획 사용을 기록한다. */
  async consume(
    canvasId: string,
    userId: string,
    clientStrokeId: string,
    limit: number | null,
    transaction: TransactionContext,
  ): Promise<string> {
    const executor = getPgExecutor(this.pool, transaction);
    // 사용자 잠금이 동시 탭의 검사와 INSERT를 직렬화하므로 모두 같은 남은 획을 사용할 수 없다.
    const result = await executor.query<{
      used: number;
      repeated: boolean;
    }>(
      `SELECT count(*)::integer AS used,
              COALESCE(bool_or(client_stroke_id = $3::uuid), false) AS repeated
       FROM canvas_stroke_usages
       WHERE canvas_id = $1 AND user_id = $2`,
      [canvasId, userId, clientStrokeId],
    );
    const usage = result.rows[0];
    // 메모리에 없는 과거 획 ID를 재사용해 새로운 그림을 무료로 시작하는 것을 막는다.
    if (usage.repeated)
      throw new CanvasStrokeError(
        'STROKE_ALREADY_USED',
        'This stroke has already been used.',
      );
    // NULL 제한은 무제한이므로 숫자 제한이 있을 때만 사용 횟수를 비교한다.
    if (limit !== null && usage.used >= limit)
      throw new CanvasStrokeError(
        'STROKE_LIMIT_REACHED',
        'Stroke limit has been reached.',
      );
    const inserted = await executor.query<{ id: string }>(
      `INSERT INTO canvas_stroke_usages (canvas_id, user_id, client_stroke_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [canvasId, userId, clientStrokeId],
    );
    return inserted.rows[0].id;
  }

  /** 대상에서 정상 종료한 기존 사용만 갱신하고 완료된 획 순서를 함께 전진시킨다. */
  async complete(
    canvasId: string,
    userId: string,
    clientStrokeId: string,
    transaction: TransactionContext,
  ): Promise<void> {
    const result = await getPgExecutor(this.pool, transaction).query(
      `WITH completed AS (
         UPDATE canvas_stroke_usages u
         SET completed_at = GREATEST(clock_timestamp(), u.used_at)
         WHERE u.canvas_id = $1 AND u.user_id = $2
           AND u.client_stroke_id = $3
           AND u.completed_at IS NULL RETURNING u.canvas_id
       ), advanced AS (
         UPDATE canvases c SET last_sequence = c.last_sequence + 1
         FROM completed WHERE completed.canvas_id = c.id RETURNING c.id
       )
       SELECT u.id FROM canvas_stroke_usages u
       WHERE u.canvas_id = $1 AND u.user_id = $2 AND u.client_stroke_id = $3`,
      [canvasId, userId, clientStrokeId],
    );
    // 기록 없는 완료는 승인하지 않아 메모리와 DB의 완료 상태가 어긋나지 않게 한다.
    if (result.rowCount !== 1) throw new Error('Stroke usage is missing.');
  }

  /** COMMIT 응답이 유실됐을 때 대상에 속한 정확한 최초 사용 기록을 확인한다. */
  async recorded(
    canvasId: string,
    userId: string,
    clientStrokeId: string,
    usageId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT id FROM canvas_stroke_usages
       WHERE canvas_id = $1 AND user_id = $2
         AND client_stroke_id = $3 AND id = $4`,
      [canvasId, userId, clientStrokeId, usageId],
    );
    return result.rowCount === 1;
  }

  /** 기존 메인 호출을 유지하며 DB의 메인 ID와 제한을 일반 차감 경로에 전달한다. */
  async consumeMain(
    userId: string,
    clientStrokeId: string,
    transaction: TransactionContext,
  ): Promise<string> {
    const main = await this.main(transaction);
    return this.consume(
      main.id,
      userId,
      clientStrokeId,
      main.strokeLimitPerUser,
      transaction,
    );
  }

  /** 기존 메인 완료 호출을 일반 대상 완료 경로에 위임한다. */
  async completeMain(
    userId: string,
    clientStrokeId: string,
    transaction: TransactionContext,
  ): Promise<void> {
    const main = await this.main(transaction);
    return this.complete(main.id, userId, clientStrokeId, transaction);
  }

  /** 기존 메인 커밋 확인 호출을 일반 대상 조회 경로에 위임한다. */
  async recordedMain(
    userId: string,
    clientStrokeId: string,
    usageId: string,
  ): Promise<boolean> {
    const main = await this.main();
    return this.recorded(main.id, userId, clientStrokeId, usageId);
  }

  /** 메인 wrapper가 사용할 현재 DB의 단일 메인 ID와 획 제한을 읽는다. */
  private async main(
    transaction?: TransactionContext,
  ): Promise<{ id: string; strokeLimitPerUser: number }> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
      strokeLimitPerUser: number;
    }>(
      `SELECT id, stroke_limit_per_user AS "strokeLimitPerUser"
       FROM canvases WHERE type = 'main'`,
    );
    const main = result.rows[0];
    if (!main) throw new Error('Main canvas is missing.');
    return main;
  }
}
