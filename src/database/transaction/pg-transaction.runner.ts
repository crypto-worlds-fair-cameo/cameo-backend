import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import type { TransactionContext } from './transaction-context';
import {
  TransactionRunner,
  type TransactionOptions,
} from './transaction-runner';
import { PG_POOL } from '../pg.constants';
import {
  createTransactionContext,
  closeTransactionContext,
} from './pg-transaction-scope';
import { withTransaction } from './pg.tx';

@Injectable()
export class PgTransactionRunner implements TransactionRunner {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * 여러 repository 작업이 같은 PostgreSQL 커넥션에서 실행되도록 트랜잭션 경계를 제공합니다.
   */
  async run<T>(
    fn: (transaction: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ) {
    return withTransaction(
      this.pool,
      async (client) => {
        const transaction = createTransactionContext(client);
        try {
          return await fn(transaction);
        } finally {
          closeTransactionContext(transaction);
        }
      },
      options,
    );
  }
}
