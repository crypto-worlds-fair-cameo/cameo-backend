import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';

@Injectable()
export class ProfileRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 세션 인증으로 잠근 사용자의 닉네임을 저장한다. 닉네임 중복은 허용한다. */
  async updateDisplayName(
    userId: string,
    displayName: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<Readonly<{ id: string; displayName: string }>> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
      displayName: string;
    }>(
      `UPDATE users SET display_name = $2, updated_at = $3
       WHERE id = $1 RETURNING id, display_name AS "displayName"`,
      [userId, displayName, time],
    );
    if (!result.rows[0]) throw new Error('Authenticated user is missing');
    return result.rows[0];
  }
}
