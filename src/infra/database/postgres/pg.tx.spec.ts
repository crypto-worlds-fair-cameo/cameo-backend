import type { Pool, PoolClient } from 'pg';
import type { TransactionContext } from '../../../common/transaction/transaction-context';
import { PgTransactionRunner } from './pg-transaction.runner';
import { getPgExecutor } from './pg-executor';
import { withTransaction } from './pg.tx';

function fixture() {
  const query = jest.fn().mockResolvedValue({ rows: [] });
  const release = jest.fn();
  const client = { query, release } as unknown as PoolClient;
  const connect = jest.fn().mockResolvedValue(client);
  const pool = { connect } as unknown as Pool;
  return { pool, client, query, release, connect };
}

describe('PostgreSQL transactions', () => {
  it('commits using one connection and releases it', async () => {
    const { pool, client, query, release } = fixture();
    await expect(
      withTransaction(pool, async (tx) => {
        expect(tx).toBe(client);
        await tx.query('insert');
        return 42;
      }),
    ).resolves.toBe(42);
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'begin',
      'insert',
      'commit',
    ]);
    expect(release).toHaveBeenCalledWith(false);
  });
  it('rolls back work failures', async () => {
    const { pool, query, release } = fixture();
    const error = new Error('work failed');
    await expect(
      withTransaction(pool, () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'begin',
      'rollback',
    ]);
    expect(release).toHaveBeenCalledWith(false);
  });
  it('preserves original failure and discards a connection when rollback fails', async () => {
    const { pool, query, release } = fixture();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('connection lost'));
    const error = new Error('work failed');
    await expect(
      withTransaction(pool, () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(release).toHaveBeenCalledWith(true);
  });
  it('does not invoke work when acquisition fails', async () => {
    const { pool, connect, release } = fixture();
    connect.mockRejectedValueOnce(new Error('no connection'));
    const work = jest.fn();
    await expect(withTransaction(pool, work)).rejects.toThrow('no connection');
    expect(work).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it('rejects expired or foreign contexts instead of escaping the transaction', async () => {
    const { pool, client } = fixture();
    let expired: TransactionContext | undefined;
    await new PgTransactionRunner(pool).run(async (transaction) => {
      expired = transaction;
      expect(getPgExecutor(pool, transaction)).toBe(client);
      await Promise.resolve();
    });
    expect(getPgExecutor(pool)).toBe(pool);
    expect(() => getPgExecutor(pool, expired)).toThrow('no longer active');
    expect(() => getPgExecutor(pool, {} as TransactionContext)).toThrow(
      'invalid',
    );
  });
});
