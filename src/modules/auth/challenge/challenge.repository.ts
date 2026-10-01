import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../database/pg.constants';
import { getPgExecutor } from '../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../database/transaction/transaction-context';
import type { NewChallenge } from './challenge';

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

  /** 발급한 입력과 브라우저 연결값의 해시를 호출자의 트랜잭션에 저장한다. */
  async create(
    challenge: NewChallenge,
    transaction: TransactionContext,
  ): Promise<void> {
    await getPgExecutor(this.pool, transaction).query(
      `INSERT INTO auth_challenges
         (id, auth_method, nonce, verification_payload, browser_binding_hash,
          created_at, expires_at)
       VALUES ($1, 'siws', $2, $3::jsonb, $4, $5, $6)`,
      [
        challenge.id,
        challenge.nonce,
        JSON.stringify(challenge.signInInput),
        challenge.browserBindingHash,
        challenge.createdAt,
        challenge.expiresAt,
      ],
    );
  }
}
