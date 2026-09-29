declare const transactionContextBrand: unique symbol;

export type TransactionContext = {
  readonly [transactionContextBrand]: 'TransactionContext';
};
