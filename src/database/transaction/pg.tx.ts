import type { Pool, PoolClient } from 'pg';
import type { TransactionOptions } from './transaction-runner';

export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
  options?: TransactionOptions,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    // 지원하는 격리 수준은 고정 SQL로 선택해 외부 문자열이 트랜잭션 문장에 들어가지 않게 한다.
    if (options?.isolationLevel === 'read committed') {
      await client.query('begin isolation level read committed');
    } else {
      await client.query('begin');
    }
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error: unknown) {
    try {
      await client.query('rollback');
    } catch {
      // Rollback failure must not hide the original failure or return a broken connection.
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
