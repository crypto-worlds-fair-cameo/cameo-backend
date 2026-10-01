import { Inject, Injectable } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';

export type SessionLifetime = Readonly<{
  expiresAt: Date;
  absoluteExpiresAt: Date;
}>;

@Injectable()
export class SessionRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 사용자 잠금을 먼저 얻기 위한 예비 조회다. 이 결과만으로 세션을 인증하지 않는다. */
  async findOwner(tokenHash: string): Promise<string | undefined> {
    const result = await this.pool.query<{ user_id: string }>(
      'SELECT user_id FROM auth_sessions WHERE token_hash = $1',
      [tokenHash],
    );
    return result.rows[0]?.user_id;
  }

  /** 사용자 잠금 이후 제출 토큰과 사용자에 대응하는 세션을 다시 읽고 잠근다. */
  async lockForAuthentication(
    tokenHash: string,
    userId: string,
    transaction: TransactionContext,
  ): Promise<string | undefined> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
    }>(
      'SELECT id FROM auth_sessions WHERE token_hash = $1 AND user_id = $2 FOR UPDATE',
      [tokenHash, userId],
    );
    return result.rows[0]?.id;
  }

  /** 모든 행 잠금 뒤 DB 시각을 한 번 평가하며, 만료의 정밀도를 DB에서 유지한다. */
  async inspectAtCurrentTime(
    sessionId: string,
    transaction: TransactionContext,
  ): Promise<Readonly<{ time: Date; usable: boolean }> | undefined> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      time: Date;
      usable: boolean;
    }>(
      `WITH check_time AS MATERIALIZED (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS value
       )
       SELECT t.value AS time,
              (s.revoked_at IS NULL AND t.value < s.expires_at
               AND t.value < s.absolute_expires_at) AS usable
       FROM auth_sessions s CROSS JOIN check_time t WHERE s.id = $1`,
      [sessionId],
    );
    return result.rows[0];
  }

  /** 잠금 뒤 확인한 같은 시각으로 활동을 갱신하며 폐기·절대 만료는 바꾸지 않는다. */
  async renew(
    sessionId: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<SessionLifetime | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SessionLifetime>(
      `UPDATE auth_sessions
       SET last_seen_at = $2,
           expires_at = LEAST($2::timestamptz + INTERVAL '7 days', absolute_expires_at)
       WHERE id = $1 AND revoked_at IS NULL
         AND $2::timestamptz < expires_at AND $2::timestamptz < absolute_expires_at
       RETURNING expires_at AS "expiresAt", absolute_expires_at AS "absoluteExpiresAt"`,
      [sessionId, time],
    );
    return result.rows[0];
  }

  /** DB 판정 시각 기준으로 7일·절대 30일 세션을 생성하며 토큰 해시만 저장한다. */
  async create(
    userId: string,
    tokenHash: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<SessionLifetime> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SessionLifetime>(
      `INSERT INTO auth_sessions
         (user_id, token_hash, created_at, last_seen_at, expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $3, $3::timestamptz + INTERVAL '7 days', $3::timestamptz + INTERVAL '30 days')
       RETURNING expires_at AS "expiresAt", absolute_expires_at AS "absoluteExpiresAt"`,
      [userId, tokenHash, time],
    );
    return result.rows[0];
  }

  /** 성공 시 제출된 기존 토큰만 폐기한다. 만료·사용자와 무관하며 이미 폐기된 값은 유지한다. */
  async revokeSubmitted(
    tokenHash: string,
    transaction: TransactionContext,
  ): Promise<void> {
    await getPgExecutor(this.pool, transaction).query(
      `UPDATE auth_sessions SET revoked_at = GREATEST(clock_timestamp(), created_at)
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  /**
   * 세션의 남은 수명을 DB 시각으로 측정하고 앱의 단조 시계 기준 만료 시각으로 변환한다.
   * 앱·DB의 시계 차이를 피하면서 이후 쿼리 응답·커밋에 걸린 시간도 차감할 수 있다.
   */
  async sessionExpiryDeadline(
    expiresAt: Date,
    transaction: TransactionContext,
  ): Promise<number> {
    const startedAt = performance.now();
    const result = await getPgExecutor(this.pool, transaction).query<{
      remaining_ms: number;
    }>(
      `SELECT GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) * 1000)
         ::double precision AS remaining_ms`,
      [expiresAt],
    );
    return startedAt + result.rows[0].remaining_ms;
  }
}
