import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from './pg.constants';

@Injectable()
export class PgReadinessService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async check(): Promise<void> {
    await this.pool.query('select 1 as ok');
  }
}
