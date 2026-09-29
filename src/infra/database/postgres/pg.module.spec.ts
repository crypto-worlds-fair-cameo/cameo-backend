import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { TransactionRunner } from '../../../common/transaction/transaction-runner';
import { PG_POOL } from './pg.constants';
import { PgModule } from './pg.module';
import { PgReadinessService } from './pg-readiness.service';

describe('PgModule lifecycle', () => {
  it('wires the transaction contract and readiness and closes the pool', async () => {
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    const module = await Test.createTestingModule({ imports: [PgModule] })
      .overrideProvider(PG_POOL)
      .useValue(pool)
      .compile();
    await module.init();
    expect(module.get(TransactionRunner)).toBeDefined();
    await module.get(PgReadinessService).check();
    expect(pool.query).toHaveBeenCalledTimes(2);
    await module.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
  it('closes the pool and rejects initialization on connection failure', async () => {
    const failure = new Error('connection refused');
    const pool = {
      query: jest.fn().mockRejectedValue(failure),
      end: jest.fn().mockResolvedValue(undefined),
    };
    const module = new PgModule(pool as unknown as Pool);
    await expect(module.onModuleInit()).rejects.toBe(failure);
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
