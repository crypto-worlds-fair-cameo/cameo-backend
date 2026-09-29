import type { Pool, PoolClient } from 'pg';
import type { TransactionContext } from '../../../common/transaction/transaction-context';
import { getTransactionClient } from './pg-transaction-scope';

export type PgExecutor = Pool | PoolClient;

/**
 * repository가 새 트랜잭션을 열지 않고 전달받은 트랜잭션 클라이언트 또는 기본 pool을 선택하게 합니다.
 */
export function getPgExecutor(
  pool: Pool,
  transaction?: TransactionContext,
): PgExecutor {
  return getTransactionClient(transaction) ?? pool;
}
