import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/pg.constants';
import { getPgExecutor } from '../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../database/transaction/transaction-context';
import type { NewChallenge, StoredChallenge } from './challenge';

@Injectable()
export class ChallengeRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** DB와 JSON의 발급·만료 시각이 일치하도록 DB 시각을 밀리초 단위로 가져온다. */
  async getIssueTime(transaction: TransactionContext): Promise<Date> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      issued_at: Date;
    }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS issued_at");
    return result.rows[0].issued_at;
  }

  /** 호출자가 선택한 인증 방식·검증용 데이터와 연결값 해시를 같은 트랜잭션에 저장한다. */
  async create(
    challenge: NewChallenge,
    transaction: TransactionContext,
  ): Promise<void> {
    await getPgExecutor(this.pool, transaction).query(
      `INSERT INTO auth_challenges
         (id, auth_method, nonce, verification_payload, browser_binding_hash,
          created_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
      [
        challenge.id,
        challenge.authMethod,
        challenge.nonce,
        JSON.stringify(challenge.verificationPayload),
        challenge.browserBindingHash,
        challenge.createdAt,
        challenge.expiresAt,
      ],
    );
  }

  /** 서명 검증 전 읽기이며, 여기서 유효해도 잠금 대기 후 소비를 다시 판정해야 한다. */
  findById(id: string): Promise<StoredChallenge | undefined> {
    return this.read(id);
  }

  /** 검증 후 챌린지를 잠가 소비와 저장 데이터 변경을 같은 트랜잭션에 묶는다. */
  lockById(
    id: string,
    transaction: TransactionContext,
  ): Promise<StoredChallenge | undefined> {
    return this.read(id, transaction);
  }

  private async read(
    id: string,
    transaction?: TransactionContext,
  ): Promise<StoredChallenge | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<StoredChallenge>(
      `WITH check_time AS MATERIALIZED (SELECT clock_timestamp() AS value)
       SELECT c.id, c.auth_method AS "authMethod", c.nonce,
              c.verification_payload AS "verificationPayload",
              c.browser_binding_hash AS "browserBindingHash",
              c.created_at AS "createdAt", c.expires_at AS "expiresAt",
              c.consumed_at AS "consumedAt",
              (c.consumed_at IS NULL AND c.created_at <= t.value
               AND t.value < c.expires_at) AS usable
       FROM auth_challenges c CROSS JOIN check_time t WHERE c.id = $1
       ${transaction ? 'FOR UPDATE OF c' : ''}`,
      [id],
    );
    return result.rows[0];
  }

  /** 모든 잠금 뒤의 실제 DB 시각을 한 번 평가해 검사와 소비에 같은 값을 사용한다. */
  async consume(
    id: string,
    transaction: TransactionContext,
  ): Promise<Date | undefined> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      consumed_at: Date;
    }>(
      `WITH consumption_time AS MATERIALIZED (
         SELECT date_trunc('milliseconds', clock_timestamp()) AS value
       )
       UPDATE auth_challenges c SET consumed_at = t.value
       FROM consumption_time t
       WHERE c.id = $1 AND c.auth_method = 'siws' AND c.consumed_at IS NULL
         AND c.created_at <= t.value AND t.value < c.expires_at
       RETURNING c.consumed_at`,
      [id],
    );
    return result.rows[0]?.consumed_at;
  }
}
