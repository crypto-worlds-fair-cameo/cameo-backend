import type { PoolClient } from 'pg';
import type { TransactionContext } from '../../../common/transaction/transaction-context';

const transactionClients = new WeakMap<object, PoolClient>();

export function createTransactionContext(
  client: PoolClient,
): TransactionContext {
  const transaction = {};
  transactionClients.set(transaction, client);

  return transaction as TransactionContext;
}

export function getTransactionClient(
  transaction?: TransactionContext,
): PoolClient | undefined {
  if (!transaction) {
    return undefined;
  }

  const client = transactionClients.get(transaction);
  if (!client)
    throw new Error('Transaction context is invalid or no longer active.');
  return client;
}

export function closeTransactionContext(transaction: TransactionContext): void {
  transactionClients.delete(transaction);
}
