import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type { CanvasKey, CanvasTarget } from './canvas-target';

export type SeasonCanvasDefinition = Readonly<{
  width: number;
  height: number;
  strokeLimitPerUser: number | null;
  startsAt: Date;
  endsAt: Date;
  createdAt: Date;
}>;

/** 캔버스 공통 행을 생성하며 실시간 메인 캔버스 상태는 초기화하지 않는다. */
@Injectable()
export class CanvasDefinition {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 정규화한 키와 실제 DB type이 일치하는 캔버스 설정만 반환한다. */
  async resolve(key: CanvasKey): Promise<CanvasTarget | undefined> {
    const kind = key === 'main' ? 'main' : 'season';
    const id = key === 'main' ? null : key.slice('season:'.length);
    const result = await this.pool.query<{
      id: string;
      type: 'main' | 'season';
      width: number;
      height: number;
      stroke_limit_per_user: number | null;
      starts_at: Date | null;
      ends_at: Date | null;
    }>(
      `SELECT id, type, width, height, stroke_limit_per_user, starts_at, ends_at
       FROM canvases
       WHERE type = $1
         AND ($1 = 'main' OR id = $2::uuid)
       LIMIT 1`,
      [kind, id],
    );
    const row = result.rows[0];
    // 키의 종류와 실제 행 type이 맞지 않거나 행이 없으면 대상을 노출하지 않는다.
    if (!row) return undefined;
    return {
      id: row.id,
      key,
      kind: row.type,
      width: row.width,
      height: row.height,
      strokeLimitPerUser: row.stroke_limit_per_user,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
    };
  }

  /** 호출자의 트랜잭션에 시즌 캔버스를 추가하고 시즌·참가 기록이 공유할 ID를 반환한다. */
  async createSeason(
    input: SeasonCanvasDefinition,
    transaction: TransactionContext,
  ): Promise<string> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
    }>(
      `INSERT INTO canvases
         (type, width, height, stroke_limit_per_user, starts_at, ends_at, created_at)
       VALUES ('season', $1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        input.width,
        input.height,
        input.strokeLimitPerUser,
        input.startsAt,
        input.endsAt,
        input.createdAt,
      ],
    );
    return result.rows[0].id;
  }
}
