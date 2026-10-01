import {
  Global,
  Inject,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PgReadinessService } from './pg-readiness.service';
import { PgTransactionRunner } from './transaction/pg-transaction.runner';
import { PG_POOL } from './pg.constants';
import { PgPoolProvider } from './pg.pool.provider';
import { TransactionRunner } from './transaction/transaction-runner';

@Global()
@Module({
  providers: [
    PgReadinessService,
    PgPoolProvider,
    PgTransactionRunner,
    { provide: TransactionRunner, useExisting: PgTransactionRunner },
  ],
  exports: [PG_POOL, TransactionRunner, PgReadinessService],
})
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  private closed = false;
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

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

  async onModuleDestroy() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
    this.logger.log('PostgreSQL pool closed');
  }
}
