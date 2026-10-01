import type { Pool, PoolClient } from 'pg';

export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('begin');
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
