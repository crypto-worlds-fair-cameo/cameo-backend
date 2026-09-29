import {
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { TransactionRunner } from '../../../common/transaction/transaction-runner';
import { PgTransactionRunner } from './pg-transaction.runner';
import { PG_POOL } from './pg.constants';
import { PgReadinessService } from './pg-readiness.service';
import { PgPoolProvider } from './pg.pool.provider';

@Module({
  providers: [
    PgReadinessService,
    PgPoolProvider,
    PgTransactionRunner,
    { provide: TransactionRunner, useExisting: PgTransactionRunner },
  ],
  exports: [PG_POOL, TransactionRunner, PgReadinessService],
})
export class PgModule implements OnModuleInit, OnModuleDestroy {
  private closed = false;
  private readonly logger = new Logger(PgModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // DB모듈 연결 직후
  async onModuleInit() {
    try {
      await this.pool.query('select 1 as ok');
      this.logger.log('PostgreSQL connected');
    } catch (error: unknown) {
      this.logger.error(
        'Failed to connect to PostgreSQL.',
        error instanceof Error ? error.stack : String(error),
      );
      await this.onModuleDestroy();
      throw error;
    }
  }

  // DB모듈 종료 이후
  async onModuleDestroy() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
    this.logger.log('PostgreSQL pool closed');
  }
}
