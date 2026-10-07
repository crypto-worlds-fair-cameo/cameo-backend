import type { TransactionContext } from './transaction-context';

export type TransactionOptions = Readonly<{
  isolationLevel: 'read committed';
}>;

export abstract class TransactionRunner {
  abstract run<T>(
    fn: (transaction: TransactionContext) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}
