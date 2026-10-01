import type { TransactionContext } from './transaction-context';

export abstract class TransactionRunner {
  abstract run<T>(
    fn: (transaction: TransactionContext) => Promise<T>,
  ): Promise<T>;
}
