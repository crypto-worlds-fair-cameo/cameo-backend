const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  canExpire,
  confirmationDelayMs,
  NftTransactionDispatcher,
} = require('../../dist/modules/season-nfts/resources/solana-nft/nft-transaction-dispatcher');

test('expiry requires final height and complete negative evidence', () => {
  const evidence = {
    finalizedHeight: 101n,
    lastValidBlockHeight: 100n,
    signature: 'ABSENT',
    accountEvidence: 'ABSENT',
    allQueriesSucceeded: true,
  };
  assert.equal(canExpire(evidence), true);
  assert.equal(canExpire({ ...evidence, finalizedHeight: 100n }), false);
  assert.equal(canExpire({ ...evidence, signature: 'CONFIRMED' }), false);
  assert.equal(canExpire({ ...evidence, signature: 'FINALIZED' }), false);
  assert.equal(canExpire({ ...evidence, accountEvidence: 'SUCCESS' }), false);
  assert.equal(canExpire({ ...evidence, accountEvidence: 'UNKNOWN' }), false);
  assert.equal(canExpire({ ...evidence, allQueriesSucceeded: false }), false);
});

test('ambiguous send preserves and resends exact persisted bytes', async () => {
  const signedBytes = Buffer.from('persisted-signed-transaction');
  const saved = [];
  let sends = 0;
  const row = {
    id: 'transaction-1',
    state: 'SIGNED',
    signature: 'saved-signature',
    serializedTransaction: signedBytes,
    lastValidBlockHeight: 100n,
  };
  const repository = {
    findDispatchable: async () => row,
    recordDispatchOutcome: async (outcome) => saved.push(outcome),
  };
  const chain = {
    sendSignedTransaction: async (bytes) => {
      sends += 1;
      assert.deepEqual(bytes, signedBytes);
      if (sends === 1) throw new Error('response lost');
      return 'saved-signature';
    },
    inspectTransactions: async () => [],
  };
  const dispatcher = new NftTransactionDispatcher(repository, chain);
  await dispatcher.dispatch('transaction-1');
  await dispatcher.dispatch('transaction-1');
  assert.equal(sends, 2);
  assert.equal(saved[0].state, 'SIGNED');
  assert.equal(saved[1].state, 'SUBMITTED');
  assert.strictEqual(row.serializedTransaction, signedBytes);
});

test('dispatcher rejects a chain signature that differs from persisted signature', async () => {
  const repository = {
    findDispatchable: async () => ({
      id: 'transaction-2',
      state: 'SIGNED',
      signature: 'saved-signature',
      serializedTransaction: Buffer.from('bytes'),
      lastValidBlockHeight: 100n,
    }),
    recordDispatchOutcome: async () => assert.fail('must not persist mismatch'),
  };
  const dispatcher = new NftTransactionDispatcher(repository, {
    sendSignedTransaction: async () => 'different-signature',
    inspectTransactions: async () => [],
  });
  await assert.rejects(
    () => dispatcher.dispatch('transaction-2'),
    /signature does not match/,
  );
});

test('finalized effect reconciliation is terminal and does not resend', async () => {
  let sends = 0;
  const saved = [];
  const repository = {
    findDispatchable: async () => ({
      id: 'transaction-3',
      state: 'SUBMITTED',
      signature: 'saved-signature',
      serializedTransaction: Buffer.from('bytes'),
      lastValidBlockHeight: 100n,
    }),
    recordDispatchOutcome: async (outcome) => saved.push(outcome),
  };
  const dispatcher = new NftTransactionDispatcher(repository, {
    sendSignedTransaction: async () => {
      sends += 1;
      return 'saved-signature';
    },
    inspectTransactions: async () => [
      {
        transactionId: 'transaction-3',
        signature: 'ABSENT',
        accountEvidence: 'SUCCESS',
        allQueriesSucceeded: true,
        finalizedHeight: 101n,
        reconciliationEvidence: { operation: 'USER_MINT', slot: '1' },
      },
    ],
  });
  await dispatcher.check(['transaction-3']);
  assert.equal(saved[0].state, 'RECONCILED');
  assert.equal(sends, 0);
});

test('finalized signature wins over effect reconciliation and PREPARED stays unsigned', async () => {
  const rows = new Map([
    [
      'finalized',
      {
        id: 'finalized',
        state: 'SUBMITTED',
        signature: 'sig',
        serializedTransaction: Buffer.from('signed'),
        lastValidBlockHeight: 100n,
      },
    ],
    [
      'prepared',
      {
        id: 'prepared',
        state: 'PREPARED',
        signature: null,
        serializedTransaction: Buffer.from('partial'),
        lastValidBlockHeight: 100n,
      },
    ],
  ]);
  const saved = [];
  const dispatcher = new NftTransactionDispatcher(
    {
      findDispatchable: async (id) => rows.get(id),
      recordDispatchOutcome: async (outcome) => saved.push(outcome),
    },
    {
      sendSignedTransaction: async () => assert.fail('must not send'),
      inspectTransactions: async () => [
        {
          transactionId: 'finalized',
          signature: 'FINALIZED',
          accountEvidence: 'SUCCESS',
          allQueriesSucceeded: true,
          finalizedHeight: 101n,
          reconciliationEvidence: { operation: 'USER_MINT', slot: '1' },
        },
        {
          transactionId: 'prepared',
          signature: 'ABSENT',
          accountEvidence: 'UNKNOWN',
          allQueriesSucceeded: false,
          finalizedHeight: 101n,
        },
      ],
    },
  );
  await dispatcher.check(['finalized', 'prepared']);
  assert.equal(saved[0].state, 'FINALIZED');
  assert.equal(saved[1].state, 'PREPARED');
});

test('inconclusive confirmation persists the durable 5, 10, 15, 15 cadence', async () => {
  assert.deepEqual(
    [0, 1, 2, 3].map(confirmationDelayMs),
    [10_000, 15_000, 15_000, 15_000],
  );
  const now = Date.now;
  Date.now = () => 1_000;
  try {
    const rows = [0, 1, 2].map((confirmationCheckCount) => ({
      id: `transaction-${confirmationCheckCount}`,
      state: 'SUBMITTED',
      signature: 'signature',
      serializedTransaction: Buffer.from('bytes'),
      lastValidBlockHeight: 100n,
      confirmationCheckCount,
      retryCount: 2,
    }));
    const saved = [];
    const dispatcher = new NftTransactionDispatcher(
      {
        findDispatchable: async (id) => rows.find((row) => row.id === id),
        recordDispatchOutcome: async (outcome) => saved.push(outcome),
      },
      {
        sendSignedTransaction: async () => assert.fail('must not send'),
        inspectTransactions: async (transactions) =>
          transactions.map((row) => ({
            transactionId: row.id,
            signature: 'ABSENT',
            accountEvidence: 'UNKNOWN',
            allQueriesSucceeded: false,
            finalizedHeight: 100n,
          })),
      },
    );
    await dispatcher.check(rows.map((row) => row.id));
    assert.deepEqual(
      saved.map((item) => item.nextCheckDelayMs),
      [10_000, 15_000, 15_000],
    );
    assert.ok(saved.every((item) => item.incrementConfirmationCheck));
    assert.ok(saved.every((item) => item.retryDisposition === 'RESET'));
  } finally {
    Date.now = now;
  }
});

test('thrown and omitted inspections persist transient retry backoff', async () => {
  const now = Date.now;
  const random = Math.random;
  Date.now = () => 1_000;
  Math.random = () => 0;
  try {
    const rows = new Map([
      [
        'thrown',
        {
          id: 'thrown',
          state: 'SUBMITTED',
          signature: 'signature',
          serializedTransaction: Buffer.from('bytes'),
          lastValidBlockHeight: 100n,
          retryCount: 1,
        },
      ],
      [
        'omitted',
        {
          id: 'omitted',
          state: 'SUBMITTED',
          signature: 'signature',
          serializedTransaction: Buffer.from('bytes'),
          lastValidBlockHeight: 100n,
          retryCount: 2,
        },
      ],
    ]);
    const saved = [];
    const repository = {
      findDispatchable: async (id) => rows.get(id),
      recordDispatchOutcome: async (outcome) => saved.push(outcome),
    };
    await new NftTransactionDispatcher(repository, {
      sendSignedTransaction: async () => assert.fail('must not send'),
      inspectTransactions: async () => {
        throw new Error('RPC unavailable');
      },
    }).check(['thrown']);
    await new NftTransactionDispatcher(repository, {
      sendSignedTransaction: async () => assert.fail('must not send'),
      inspectTransactions: async () => [],
    }).check(['omitted']);
    assert.deepEqual(
      saved.map((item) => item.nextCheckDelayMs),
      [15_000, 60_000],
    );
    assert.ok(saved.every((item) => item.retryDisposition === 'INCREMENT'));
  } finally {
    Date.now = now;
    Math.random = random;
  }
});

test('durable RPC retry logs only allowlisted operational fields', async () => {
  const events = [];
  const dispatcher = new NftTransactionDispatcher(
    {
      findDispatchable: async () => ({
        id: 'transaction-log',
        network: 'devnet',
        state: 'SIGNED',
        signature: 'private-signature',
        serializedTransaction: Buffer.from('private-signed-bytes'),
        lastValidBlockHeight: 100n,
        retryCount: 3,
      }),
      recordDispatchOutcome: async () => {},
    },
    {
      sendSignedTransaction: async () => assert.fail('must not send'),
      inspectTransactions: async () => {
        throw new Error(
          'https://rpc.invalid/?api-key=private-key cookie=secret',
        );
      },
    },
  );
  dispatcher.logger = { warn: (event) => events.push(event), log: () => {} };
  await dispatcher.check(['transaction-log']);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), [
    'errorCode',
    'event',
    'network',
    'retryCount',
    'state',
    'transactionId',
  ]);
  assert.equal(events[0].event, 'season_nft.rpc_retry');
  const serialized = JSON.stringify(events[0]);
  assert.doesNotMatch(serialized, /private|rpc\.invalid|cookie|signed-bytes/);
});
