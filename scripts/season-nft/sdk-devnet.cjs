const { createHash } = require('node:crypto');
const { chmod, lstat, mkdir, readFile, readdir, realpath } = require('node:fs/promises');
const { isAbsolute, join } = require('node:path');
const {
  GENESIS_HASHES,
  REQUIRED_EXTERNAL_TESTS,
  notRun,
  pass,
  publishSignedItem,
  signedDataItemId,
  streamToBuffer,
} = require('./sdk-validation.cjs');

const CHAIN_TESTS = REQUIRED_EXTERNAL_TESTS.filter((id) => ![
  'proofFits100',
  'mintFits100',
  'uploadItemRestoresSameId',
  'permanentUploadRetrievable',
].includes(id));
const STORAGE_TESTS = ['uploadItemRestoresSameId', 'permanentUploadRetrievable'];
const REQUIRED_LOCAL_TESTS = [
  'sdkExports',
  'sdkVersions',
  'programAddresses',
  'proofFits100',
  'mintFits100',
  'payerRecipientSerialization',
  'signedItemRoundTrip',
];
const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const KEY_NAMES = ['service', 'allowed-a', 'allowed-b', 'outsider-c'];
const RESOURCE_NAMES = ['collection', 'alternate-collection', 'candy-machine', 'asset-a', 'asset-b'];
const NAME = 'Cameo Season SDK Validation';
const URI = 'https://example.invalid/cameo-season-sdk-validation.json';
const CHAIN_CHECKPOINTS = Object.freeze({
  NONE: 0,
  LOCKED: 1,
  MINT0_PREPARED: 2,
  PRE_TRANSFER: 3,
  TRANSFERRED: 4,
  BURNED: 5,
  MINT1_PREPARED: 6,
  MINTS_COMPLETE: 7,
});
const DELEGATE_PLUGIN_KEYS = [
  'updateDelegate',
  'transferDelegate',
  'burnDelegate',
  'freezeDelegate',
  'permanentTransferDelegate',
  'permanentBurnDelegate',
  'permanentFreezeDelegate',
];

class AmbiguousTransactionError extends Error {
  constructor(label, signature, message) {
    super(message);
    this.name = 'AmbiguousTransactionError';
    this.code = 'TRANSACTION_OUTCOME_PENDING';
    this.label = label;
    this.signature = signature;
  }
}

class ConfirmedTransactionError extends Error {
  constructor(signature, chainError) {
    super(`Submitted transaction ${signature} failed: ${JSON.stringify(chainError)}`);
    this.name = 'ConfirmedTransactionError';
    this.code = 'TRANSACTION_CONFIRMED_FAILED';
    this.signature = signature;
  }
}

function serializeMintQuote(quote) {
  if (!quote) return null;
  return {
    feeLamports: quote.feeLamports.toString(),
    priorityFeeLamports: quote.priorityFeeLamports.toString(),
    payerDebitLamports: quote.payerDebitLamports.toString(),
    rentLamports: quote.rentLamports.toString(),
    protocolLamports: quote.protocolLamports.toString(),
    totalLamports: quote.totalLamports.toString(),
    addresses: quote.addresses,
    rentByAddress: [...quote.rentByAddress].map(([address, amount]) => [address, amount.toString()]),
  };
}

function deserializeMintQuote(quote) {
  if (!quote) return null;
  return {
    feeLamports: BigInt(quote.feeLamports),
    priorityFeeLamports: BigInt(quote.priorityFeeLamports),
    payerDebitLamports: BigInt(quote.payerDebitLamports),
    rentLamports: BigInt(quote.rentLamports),
    protocolLamports: BigInt(quote.protocolLamports),
    totalLamports: BigInt(quote.totalLamports),
    addresses: quote.addresses,
    rentByAddress: new Map(quote.rentByAddress.map(([address, amount]) => [address, BigInt(amount)])),
  };
}

/** Publishes append-only scenario state so a later process can skip assertions invalidated by later mutations. */
async function saveChainCheckpoint(directory, state) {
  const payload = {
    schemaVersion: 1,
    stage: state.stage,
    tests: state.tests,
    mintSignatures: state.mintSignatures,
    assetLockObservations: state.assetLockObservations,
    firstMintSignature: state.firstMintSignature,
    firstMintQuote: serializeMintQuote(state.firstMintQuote),
  };
  await publishSignedItem(
    directory,
    `checkpoint-${String(state.stage).padStart(2, '0')}.json`,
    Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'),
  );
}

/** Loads the latest complete checkpoint; no final file means the interrupted stage must be replayed. */
async function loadChainCheckpoint(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const matches = entries
    .filter((entry) => entry.isFile() && /^checkpoint-\d{2}\.json$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (matches.length === 0) return null;
  const path = join(directory, matches.at(-1).name);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
    throw new Error('Chain recovery checkpoint must be a regular 0600 file.');
  }
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  if (parsed.schemaVersion !== 1 || !Object.values(CHAIN_CHECKPOINTS).includes(parsed.stage)) {
    throw new Error('Chain recovery checkpoint has an unsupported schema or stage.');
  }
  return {
    stage: parsed.stage,
    tests: parsed.tests ?? [],
    mintSignatures: parsed.mintSignatures ?? [],
    assetLockObservations: parsed.assetLockObservations ?? [],
    firstMintSignature: parsed.firstMintSignature ?? null,
    firstMintQuote: deserializeMintQuote(parsed.firstMintQuote),
  };
}

function failure(id, gate, reason, signatures = []) {
  return { id, gate, status: 'FAIL', signatures, reason };
}

function presentDelegatePlugins(account) {
  return DELEGATE_PLUGIN_KEYS.filter((key) => Boolean(account?.[key]));
}

function signatureString(signature) {
  const bs58Module = require('bs58');
  const bs58 = bs58Module.default?.encode ? bs58Module.default : bs58Module;
  return bs58.encode(signature);
}

/** Removes the configured endpoint and URL-shaped tokens before evidence reaches stdout or disk. */
function redactDiagnostic(value, rpcUrl = '') {
  let result = String(value ?? 'Unknown validation failure.');
  if (rpcUrl) result = result.split(rpcUrl).join('[RPC_ENDPOINT]');
  return result.replace(/https?:\/\/[^\s"']+/gu, '[REDACTED_URL]');
}

/** A rejected simulation counts only when an on-chain program logged an instruction failure. */
function isProgramRejection(response) {
  const value = response?.value;
  return Boolean(
    value?.err &&
    Array.isArray(value.logs) &&
    value.logs.some((line) => /Program .* failed:|custom program error:/u.test(line)),
  );
}

function customErrorCode(response) {
  const detail = response?.value?.err?.InstructionError?.[1];
  return Number.isInteger(detail?.Custom) ? detail.Custom : null;
}

function matchesExpectedProgramRejection(response, expectedProgram, expectedCodes) {
  if (!isProgramRejection(response)) return false;
  const failedLog = response.value.logs.find((line) => /Program .* failed:/u.test(line));
  return failedLog?.includes(String(expectedProgram)) === true &&
    expectedCodes.includes(customErrorCode(response));
}

/** Validates Core's retained one-byte uninitialized account after a successful burn. */
function inspectBurnTombstone(account, coreProgramId) {
  if (!account?.exists) throw new Error('Burned Core asset tombstone is missing.');
  if (String(account.owner) !== String(coreProgramId)) {
    throw new Error('Burned Core asset tombstone has an unexpected owner.');
  }
  if (account.data?.length !== 1 || account.data[0] !== 0) {
    throw new Error('Burned Core asset is not a one-byte uninitialized tombstone.');
  }
  return {
    owner: String(account.owner),
    byteLength: account.data.length,
    discriminator: account.data[0],
    lamports: account.lamports.basisPoints.toString(),
  };
}

/** Splits named account credits into rent and protocol cost, whether simulation balances include the transaction fee or not. */
function deriveMintFeeComponents({
  feeLamports,
  priorityFeeLamports,
  payerAddress,
  addresses,
  preBalances,
  postBalances,
  rentByAddress,
}) {
  if (addresses.length !== preBalances.length || addresses.length !== postBalances.length) {
    throw new Error('Named simulation balances do not align with message accounts.');
  }
  const payerIndex = addresses.indexOf(payerAddress);
  if (payerIndex < 0) throw new Error('Payer is absent from simulated message accounts.');
  const namedAccounts = {};
  let rentLamports = 0n;
  let protocolLamports = 0n;

  for (let index = 0; index < addresses.length; index += 1) {
    const address = addresses[index];
    if (address === payerAddress) continue;
    const before = BigInt(preBalances[index]);
    const after = BigInt(postBalances[index]);
    const positiveCredit = after > before ? after - before : 0n;
    const configuredRent = rentByAddress.get(address) ?? 0n;
    const rent = configuredRent > positiveCredit ? positiveCredit : configuredRent;
    const protocol = positiveCredit - rent;
    rentLamports += rent;
    protocolLamports += protocol;
    if (configuredRent > 0n || positiveCredit > 0n) {
      namedAccounts[address] = {
        beforeLamports: before.toString(),
        afterLamports: after.toString(),
        rentLamports: rent.toString(),
        protocolLamports: protocol.toString(),
      };
    }
  }

  const observedPayerDebitLamports = BigInt(preBalances[payerIndex]) - BigInt(postBalances[payerIndex]);
  const totalLamports = BigInt(feeLamports) + BigInt(priorityFeeLamports) + rentLamports + protocolLamports;
  const instructionDebitLamports = rentLamports + protocolLamports;
  const feeObservedInPayerBalance = observedPayerDebitLamports === totalLamports;
  if (!feeObservedInPayerBalance && observedPayerDebitLamports !== instructionDebitLamports) {
    throw new Error(`Payer debit ${observedPayerDebitLamports} does not reconcile to named components ${totalLamports}.`);
  }
  return {
    feeLamports: BigInt(feeLamports),
    priorityFeeLamports: BigInt(priorityFeeLamports),
    payerDebitLamports: totalLamports,
    observedPayerDebitLamports,
    feeObservedInPayerBalance,
    rentLamports,
    protocolLamports,
    totalLamports,
    namedAccounts,
  };
}

/** Returns audit-ready rejection evidence with the program failure and bounded log tail in the required reason field. */
function simulationRejectionEvidence(response, expectedProgram, rpcUrl) {
  const failedLog = response.value.logs.find((line) => /Program .* failed:/u.test(line));
  const code = customErrorCode(response);
  const logTail = response.value.logs.slice(-4).map((line) => redactDiagnostic(line, rpcUrl));
  return {
    details: {
      programError: redactDiagnostic(failedLog, rpcUrl),
      customErrorCode: code,
      logTail,
      simulation: true,
    },
    reason: `Simulation rejected by ${expectedProgram} with custom error ${code}; ${logTail.join(' | ')}`,
  };
}

async function retryRead(operation, attempts = 4, delayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs * (2 ** attempt)));
      }
    }
  }
  throw lastError;
}

/** Keeps Start Date removal and permanent Guard authority lock in the same final transaction. */
function createFinalLockBuilder({ umi, candy, authority, candyGuard, lockAuthority, merkleRoot }) {
  return candy.updateCandyGuard(umi, {
    candyGuard,
    authority,
    guards: {
      allowList: { merkleRoot },
      mintLimit: { id: 0, limit: 1 },
      startDate: null,
    },
    groups: [],
  }).add(candy.setCandyGuardAuthority(umi, {
    candyGuard,
    authority,
    newAuthority: lockAuthority,
  }));
}

async function enforcePrivateDirectory(directory) {
  if (!isAbsolute(directory)) throw new Error('Validation artifact roots must be absolute paths.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o700) {
    throw new Error('Validation key directory must be a non-symlink directory with mode 0700.');
  }
  return realpath(directory);
}

/** Creates or reloads only isolated Devnet fixtures; no operational wallet input is accepted. */
async function loadFixtureSigners(umi, umiModule, preparationRoot) {
  if (!isAbsolute(preparationRoot)) throw new Error('NFT_PREPARATION_KEY_DIR must be an absolute path.');
  const directory = await enforcePrivateDirectory(join(preparationRoot, 'devnet-validation'));
  const signers = {};

  for (const name of [...KEY_NAMES, ...RESOURCE_NAMES]) {
    const path = join(directory, `${name}.json`);
    let secret;
    try {
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
        throw new Error(`Validation key ${name} must be a regular 0600 file.`);
      }
      secret = Uint8Array.from(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const generated = umi.eddsa.generateKeypair();
      secret = generated.secretKey;
      try {
        await publishSignedItem(directory, `${name}.json`, Buffer.from(`${JSON.stringify([...secret])}\n`, 'utf8'));
      } catch (publishError) {
        // Another validator may win the no-clobber race; adopt only its valid final fixture.
        const existing = JSON.parse(await readFile(path, 'utf8'));
        if (!Array.isArray(existing) || existing.length !== 64) throw publishError;
        secret = Uint8Array.from(existing);
      }
    }
    if (secret.length !== 64) throw new Error(`Validation key ${name} is not a 64-byte Ed25519 secret.`);
    signers[name] = umiModule.createSignerFromKeypair(
      umi,
      umi.eddsa.createKeypairFromSecretKey(secret),
    );
  }
  return { directory, signers };
}

async function rpcGenesisHash(umi) {
  return umi.rpc.call('getGenesisHash', []);
}

async function programAccountsAreExecutable(umi, addresses) {
  const results = await Promise.all(Object.values(addresses).map(async (address) => {
    const response = await umi.rpc.call('getAccountInfo', [address, { encoding: 'base64' }]);
    return response?.value?.executable === true;
  }));
  return results.every(Boolean);
}

async function simulateBuilder(umi, builder) {
  const transaction = await builder.setLatestBlockhash(umi).then((value) => value.buildAndSign(umi));
  const bytes = umi.transactions.serialize(transaction);
  return umi.rpc.call('simulateTransaction', [Buffer.from(bytes).toString('base64'), {
    encoding: 'base64',
    sigVerify: true,
    commitment: 'confirmed',
    replaceRecentBlockhash: false,
  }]);
}

function rpcAccountLamports(account) {
  if (!account || account.exists === false) return 0n;
  if (account.lamports?.basisPoints !== undefined) return BigInt(account.lamports.basisPoints);
  return BigInt(account.lamports ?? 0);
}

function rpcAccountDataLength(account) {
  const data = account?.data;
  if (data instanceof Uint8Array || Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data) && typeof data[0] === 'string') return Buffer.from(data[0], 'base64').length;
  throw new Error('Simulated account data is unavailable for rent derivation.');
}

async function simulateSignedTransactionWithAccounts(umi, transaction, addresses) {
  const bytes = umi.transactions.serialize(transaction);
  return umi.rpc.call('simulateTransaction', [Buffer.from(bytes).toString('base64'), {
    encoding: 'base64',
    sigVerify: true,
    commitment: 'confirmed',
    replaceRecentBlockhash: false,
    accounts: { encoding: 'base64', addresses },
  }]);
}

async function expectProgramRejection(id, umi, builder, rpcUrl, expectedProgram, expectedCodes = []) {
  try {
    const response = await simulateBuilder(umi, builder);
    if (!isProgramRejection(response)) {
      return failure(id, 'CHAIN_AUTHORITY', redactDiagnostic(JSON.stringify(response), rpcUrl));
    }
    const failedLog = response.value.logs.find((line) => /Program .* failed:/u.test(line));
    const code = customErrorCode(response);
    if (
      expectedProgram && expectedCodes.length > 0 &&
      !matchesExpectedProgramRejection(response, expectedProgram, expectedCodes)
    ) {
      return failure(id, 'CHAIN_AUTHORITY', `Unexpected rejecting program/code ${redactDiagnostic(failedLog, rpcUrl)} / ${code ?? 'none'}; expected ${expectedCodes.join(' or ')}.`);
    }
    const evidence = simulationRejectionEvidence(response, expectedProgram, rpcUrl);
    const result = pass(id, 'CHAIN_AUTHORITY', 'Program rejected the simulated transaction.', evidence.details);
    result.reason = evidence.reason;
    return result;
  } catch (error) {
    return failure(id, 'CHAIN_AUTHORITY', `Transport failure is not a rejection: ${redactDiagnostic(error.message, rpcUrl)}`);
  }
}

function isRetriableTransportError(error) {
  return /429|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|socket|network/iu.test(String(error?.message ?? error));
}

async function signatureResolution(umi, signature, delayMs) {
  const [status] = await retryRead(
    () => umi.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    3,
    delayMs,
  );
  const signatureText = signatureString(signature);
  if (status?.error) throw new ConfirmedTransactionError(signatureText, status.error);
  if (status?.commitment === 'finalized') return 'FINALIZED';
  if (status) return 'LANDED_NOT_FINALIZED';
  return 'UNRESOLVED';
}

async function waitForSignatureResolution(umi, signature, attempts, delayMs) {
  let resolution = 'UNRESOLVED';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    resolution = await signatureResolution(umi, signature, delayMs);
    if (resolution === 'FINALIZED') return resolution;
    if (attempt < attempts - 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
  return resolution;
}

/** Persists one signed transaction and returns its canonical signature and bytes. */
async function persistSignedTransaction(umi, transaction, options) {
  const signature = transaction.signatures[0];
  if (!signature || signature.length !== 64 || !Buffer.from(signature).some(Boolean)) {
    throw new Error('Signed transaction is missing its canonical payer signature.');
  }
  const signatureText = signatureString(signature);
  const bytes = Buffer.from(umi.transactions.serialize(transaction));
  const safeLabel = String(options.label).replace(/[^a-z0-9_-]/giu, '-');
  await publishSignedItem(options.directory, `${safeLabel}-${signatureText}.tx`, bytes);
  return { signature, signatureText, bytes };
}

/** Persists one signed transaction before exposure and resends only those identical bytes after ambiguous transport loss. */
async function sendSignedTransaction(umi, transaction, options) {
  const { signature, signatureText } = await persistSignedTransaction(umi, transaction, options);
  const delayMs = options.retryDelayMs ?? 500;
  const sendAttempts = options.sendAttempts ?? 3;

  for (let attempt = 0; attempt < sendAttempts; attempt += 1) {
    try {
      const returned = await umi.rpc.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 0,
      });
      if (signatureString(returned) !== signatureText) {
        throw new Error('RPC returned a signature different from the persisted signed transaction.');
      }
    } catch (error) {
      if (!isRetriableTransportError(error)) throw error;
    }

    let resolution;
    try {
      resolution = await waitForSignatureResolution(umi, signature, 8, delayMs);
    } catch (error) {
      if (error instanceof ConfirmedTransactionError) throw error;
      throw new AmbiguousTransactionError(
        options.label,
        signatureText,
        `Transaction ${options.label} status is unavailable; persisted signature ${signatureText} remains pending.`,
      );
    }
    if (resolution === 'FINALIZED') return signatureText;
    if (resolution === 'LANDED_NOT_FINALIZED') {
      throw new AmbiguousTransactionError(
        options.label,
        signatureText,
        `Transaction ${options.label} landed but is not finalized; persisted signature ${signatureText} remains pending.`,
      );
    }
    // A null status is unresolved; the next iteration resends the exact same transaction object and bytes.
  }
  throw new AmbiguousTransactionError(
    options.label,
    signatureText,
    `Transaction ${options.label} remained unresolved; persisted signature ${signatureText} remains pending.`,
  );
}

/** Reloads one persisted signed transaction and rejects duplicate or altered recovery artifacts. */
async function loadPersistedTransaction(umi, directory, label) {
  const safeLabel = String(label).replace(/[^a-z0-9_-]/giu, '-');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const prefix = `${safeLabel}-`;
  const matches = entries.filter((entry) => (
    entry.name.startsWith(prefix) && entry.name.endsWith('.tx')
  ));
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new Error(`Multiple persisted transactions exist for ${safeLabel}; automatic recovery is unsafe.`);
  }
  const entry = matches[0];
  const path = join(directory, entry.name);
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o777) !== 0o600) {
    throw new Error(`Persisted transaction ${safeLabel} must be a regular 0600 file.`);
  }
  const bytes = await readFile(path);
  const transaction = umi.transactions.deserialize(bytes);
  if (!Buffer.from(umi.transactions.serialize(transaction)).equals(bytes)) {
    throw new Error(`Persisted transaction ${safeLabel} changed during deserialization.`);
  }
  const signature = transaction.signatures[0];
  const signatureText = signatureString(signature);
  const fileSignature = entry.name.slice(prefix.length, -'.tx'.length);
  if (signatureText !== fileSignature) {
    throw new Error(`Persisted transaction ${safeLabel} signature does not match its file name.`);
  }
  return { transaction, signature, signatureText };
}

async function hasPersistedTransactions(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).some(
      (entry) => entry.isFile() && entry.name.endsWith('.tx'),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** Reconciles a prior process's signed bytes before any builder can create a replacement transaction. */
async function reconcilePersistedTransaction(umi, persisted, options) {
  let resolution;
  try {
    resolution = await signatureResolution(umi, persisted.signature, options.retryDelayMs ?? 500);
  } catch (error) {
    if (error instanceof ConfirmedTransactionError) throw error;
    throw new AmbiguousTransactionError(
      options.label,
      persisted.signatureText,
      `Transaction ${options.label} status is unavailable; persisted signature ${persisted.signatureText} remains pending.`,
    );
  }
  if (resolution === 'FINALIZED') return persisted.signatureText;
  if (resolution === 'LANDED_NOT_FINALIZED') {
    throw new AmbiguousTransactionError(
      options.label,
      persisted.signatureText,
      `Transaction ${options.label} landed but is not finalized; persisted signature ${persisted.signatureText} remains pending.`,
    );
  }
  return sendSignedTransaction(umi, persisted.transaction, options);
}

async function send(umi, builder, options) {
  const persisted = await loadPersistedTransaction(umi, options.directory, options.label);
  if (persisted) return reconcilePersistedTransaction(umi, persisted, options);
  const latest = await builder.setLatestBlockhash(umi);
  const transaction = await latest.buildAndSign(umi);
  return sendSignedTransaction(umi, transaction, options);
}

/** Adds the successful burn as supporting evidence without attributing its signature to a simulated rejection. */
function attachBurnSupportEvidence(result, burnSignature, burnTombstone, mintCounter) {
  result.details = {
    ...(result.details ?? {}),
    burnSignature,
    burnTombstone,
    mintCounter,
  };
  return result;
}

/** Maps only a confirmed or deterministic chain error to FAIL; ambiguous transport remains pending. */
function chainResultsForError(error, rpcUrl) {
  const reason = redactDiagnostic(error.message, rpcUrl);
  if (!(error instanceof AmbiguousTransactionError)) {
    return CHAIN_TESTS.map((id) => failure(id, 'CHAIN_AUTHORITY', reason));
  }
  return CHAIN_TESTS.map((id) => {
    const result = notRun(id, 'CHAIN_AUTHORITY', reason);
    result.details = {
      pendingTransaction: {
        label: error.label,
        signature: error.signature,
        persisted: true,
      },
    };
    return result;
  });
}

function gateStatus(tests, gate) {
  const selected = tests.filter((item) => item.gate === gate);
  if (selected.length === 0) return 'NOT_RUN';
  if (selected.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (selected.every((item) => item.status === 'PASS')) return 'PASS';
  if (selected.every((item) => ['PASS', 'NOT_RUN'].includes(item.status))) return 'NOT_RUN';
  return 'FAIL';
}

function evidenceIntegrityErrors(tests) {
  const expected = new Map([
    ...REQUIRED_LOCAL_TESTS.map((id) => [id, 'LOCAL_SDK']),
    ...CHAIN_TESTS.map((id) => [id, 'CHAIN_AUTHORITY']),
    ...STORAGE_TESTS.map((id) => [id, 'STORAGE_RECOVERY']),
  ]);
  const errors = [];
  for (const [id, gate] of expected) {
    const matches = tests.filter((item) => item.id === id);
    if (matches.length !== 1) errors.push(`${id} occurs ${matches.length} times`);
    else if (matches[0].gate !== gate) errors.push(`${id} uses ${matches[0].gate}, expected ${gate}`);
    else if (!['PASS', 'FAIL', 'NOT_RUN'].includes(matches[0].status)) {
      errors.push(`${id} has invalid status ${matches[0].status}`);
    }
  }
  return errors;
}

/** Validates the persisted authority and plugin readback required before external evidence can be verified. */
function observedLockStateErrors(state) {
  const errors = [];
  if (!state) return ['observed lock state is missing'];
  if (
    state.derivation?.programId !== SYSTEM_PROGRAM_ID ||
    state.derivation?.seedUtf8 !== 'cameo-nft-lock-v1' ||
    !Number.isInteger(state.derivation?.bump) ||
    !state.derivation?.address
  ) errors.push('lock derivation is incomplete');
  for (const key of ['machineAuthority', 'mintAuthority', 'guardAuthority', 'collectionUpdateAuthority']) {
    if (!state[key]?.expected || state[key].expected !== state[key].actual) {
      errors.push(`${key} expected/actual mismatch`);
    }
  }
  if (
    state.derivation?.address !== state.machineAuthority?.expected ||
    state.derivation?.address !== state.guardAuthority?.expected ||
    state.derivation?.address !== state.collectionUpdateAuthority?.expected
  ) errors.push('lock derivation address does not match locked authorities');
  if (!state.candyGuardAddress || state.mintAuthority?.expected !== state.candyGuardAddress) {
    errors.push('Candy Guard address does not match mint authority');
  }
  if (state.immutableMetadata?.present !== false || state.immutableMetadata?.authorityKind !== null || state.collectionMetadataProtection !== 'LOCKED_AUTHORITY') {
    errors.push('collection metadata protection must use its locked authority');
  }
  // Collection 발행에는 Machine PDA가 필요하지만 임의 지갑 delegate는 허용하지 않는다.
  if (!Array.isArray(state.collectionDelegatePluginsPresent) ||
      state.collectionDelegatePluginsPresent.length !== 1 || state.collectionDelegatePluginsPresent[0] !== 'updateDelegate' ||
      !state.collectionMintDelegate?.expected || state.collectionMintDelegate.authorityKind !== 'UpdateAuthority' ||
      !Array.isArray(state.collectionMintDelegate.actual) || state.collectionMintDelegate.actual.length !== 1 ||
      state.collectionMintDelegate.actual[0] !== state.collectionMintDelegate.expected) {
    errors.push('collection mint delegate does not match the Candy Machine PDA');
  }
  if (!Array.isArray(state.assets) || state.assets.length !== 2) {
    errors.push('two asset lock observations are required');
  } else {
    state.assets.forEach((asset, index) => {
      if (
        !asset.address ||
        asset.updateAuthority?.type !== 'Collection' ||
        asset.updateAuthority?.address !== state.collectionAddress ||
        !Array.isArray(asset.delegatePluginsPresent) ||
        asset.delegatePluginsPresent.length > 0
      ) errors.push(`asset ${index} lock observation is invalid`);
    });
  }
  return errors;
}

function finalizeEvidence(local, tests, metadata = {}) {
  const combined = [...local.checks, ...tests];
  const integrityErrors = evidenceIntegrityErrors(combined);
  const externalAllPass = REQUIRED_EXTERNAL_TESTS.every((id) => (
    combined.some((item) => item.id === id && item.status === 'PASS')
  ));
  if (externalAllPass) {
    integrityErrors.push(...observedLockStateErrors(metadata.observedLockState));
  }
  if (integrityErrors.length > 0) {
    combined.push(failure(
      'evidenceIntegrity',
      'LOCAL_SDK',
      `Required evidence set is incomplete or invalid: ${integrityErrors.join('; ')}.`,
    ));
  }
  const gates = {
    LOCAL_SDK: gateStatus(combined, 'LOCAL_SDK'),
    CHAIN_AUTHORITY: gateStatus(combined, 'CHAIN_AUTHORITY'),
    STORAGE_RECOVERY: gateStatus(combined, 'STORAGE_RECOVERY'),
  };
  const anyFailure = Object.values(gates).includes('FAIL');
  const allPass = Object.values(gates).every((status) => status === 'PASS');
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    network: 'devnet',
    gitCommit: metadata.gitCommit ?? null,
    packages: local.packages,
    programAddresses: local.programAddresses,
    ...(metadata.addresses ? { validationAddresses: metadata.addresses } : {}),
    ...(metadata.observedLockState ? { observedLockState: metadata.observedLockState } : {}),
    gates,
    tests: combined,
    overallStatus: anyFailure
      ? 'BLOCKED_TECHNICAL'
      : allPass ? 'EXTERNAL_VERIFIED' : 'EXTERNAL_VALIDATION_PENDING',
  };
}

/** Retries one immutable Turbo data item and requires every receipt to preserve its locally derived ID. */
async function uploadSignedItemWithRetry(turbo, factory, expectedId, attempts = 3, delayMs = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const receipt = await turbo.uploadSignedDataItem(factory);
      if (String(receipt.id) !== expectedId) {
        throw new Error('Turbo upload returned a different data item ID.');
      }
      return receipt;
    } catch (error) {
      lastError = error;
      if (!isRetriableTransportError(error) || attempt === attempts - 1) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function storageValidation({ turboModule, service, workRoot, rpcUrl }) {
  const bs58Module = await import('bs58');
  const bs58 = bs58Module.default?.encode ? bs58Module.default : bs58Module;
  if (!isAbsolute(workRoot)) throw new Error('NFT_UPLOAD_WORK_DIR must be an absolute path.');
  const directory = await enforcePrivateDirectory(join(workRoot, 'devnet-validation'));
  const payload = Buffer.from('cameo season nft permanent recovery validation', 'utf8');
  const turbo = turboModule.TurboFactory.authenticated({
    privateKey: bs58.encode(service.secretKey),
    token: 'solana',
    gatewayUrl: rpcUrl,
  });
  let bytes;
  let expectedId;

  try {
    const signed = await turbo.signer.signDataItem({
      fileStreamFactory: () => Buffer.from(payload),
      fileSizeFactory: () => payload.length,
      dataItemOpts: { tags: [{ name: 'Content-Type', value: 'text/plain' }] },
    });
    bytes = await streamToBuffer(signed.dataItemStreamFactory());
    expectedId = signedDataItemId(bytes);
    const path = await publishSignedItem(directory, `${expectedId}.signed`, bytes);
    const restored = await readFile(path);
    const factory = {
      dataItemStreamFactory: () => Buffer.from(restored),
      dataItemSizeFactory: () => restored.length,
      dataItemOpts: { tags: [{ name: 'Content-Type', value: 'text/plain' }] },
    };
    await uploadSignedItemWithRetry(turbo, factory, expectedId);
    await uploadSignedItemWithRetry(turbo, factory, expectedId);
  } catch (error) {
    const reason = redactDiagnostic(error.message, rpcUrl);
    if (/balance|credit|fund|payment|insufficient/iu.test(reason)) {
      return STORAGE_TESTS.map((id) => notRun(id, 'STORAGE_RECOVERY', `Turbo funding unavailable: ${reason}`));
    }
    return STORAGE_TESTS.map((id) => failure(id, 'STORAGE_RECOVERY', reason));
  }

  const restoredCheck = pass(
    'uploadItemRestoresSameId',
    'STORAGE_RECOVERY',
    'Restored signed bytes and their replay returned the original Turbo item ID.',
    { id: expectedId, byteLength: bytes.length },
  );
  try {
    const response = await retryRead(async () => {
      const result = await fetch(`https://arweave.net/${expectedId}`, { signal: AbortSignal.timeout(10_000) });
      if (!result.ok) throw new Error(`Permanent gateway returned HTTP ${result.status}.`);
      return result;
    });
    const downloaded = Buffer.from(await response.arrayBuffer());
    const sourceHash = createHash('sha256').update(payload).digest('hex');
    const downloadedHash = createHash('sha256').update(downloaded).digest('hex');
    if (downloaded.length !== payload.length || downloadedHash !== sourceHash) {
      throw new Error('Permanent gateway content length or SHA-256 does not match the uploaded payload.');
    }
    return [restoredCheck, pass(
      'permanentUploadRetrievable',
      'STORAGE_RECOVERY',
      'Permanent public retrieval matches the uploaded payload.',
      { id: expectedId, byteLength: downloaded.length, sha256: downloadedHash },
    )];
  } catch (error) {
    return [restoredCheck, failure(
      'permanentUploadRetrievable',
      'STORAGE_RECOVERY',
      redactDiagnostic(error.message, rpcUrl),
    )];
  }
}

async function runChainValidation({ umi, modules, fixtures, rpcUrl, programAddresses, transactionDirectory }) {
  const umiModule = modules['@metaplex-foundation/umi'];
  const core = modules['@metaplex-foundation/mpl-core'];
  const candy = modules['@metaplex-foundation/mpl-core-candy-machine'];
  const service = fixtures.service;
  const allowedA = fixtures['allowed-a'];
  const allowedB = fixtures['allowed-b'];
  const outsider = fixtures['outsider-c'];
  const collection = fixtures.collection;
  const alternateCollection = fixtures['alternate-collection'];
  const candyMachine = fixtures['candy-machine'];
  const assets = [fixtures['asset-a'], fixtures['asset-b']];
  const participants = [allowedA, allowedB];
  const submit = (builder, label) => send(umi, builder, { directory: transactionDirectory, label });
  const merkleRoot = candy.getMerkleRoot(participants.map(({ publicKey }) => publicKey));
  const candyGuard = candy.findCandyGuardPda(umi, { base: candyMachine.publicKey });
  const lockPda = umi.eddsa.findPda(umiModule.publicKey(SYSTEM_PROGRAM_ID), [
    Buffer.from('cameo-nft-lock-v1', 'utf8'),
  ]);
  const lockAuthority = lockPda[0];
  const addresses = Object.fromEntries(Object.entries(fixtures).map(([name, signer]) => [name, String(signer.publicKey)]));
  addresses.candyGuard = String(candyGuard[0]);
  addresses.lockAuthority = String(lockAuthority);
  await enforcePrivateDirectory(transactionDirectory);
  const recovered = await loadChainCheckpoint(transactionDirectory);
  let checkpointStage = recovered?.stage ?? CHAIN_CHECKPOINTS.NONE;
  const recoveryActive = checkpointStage > CHAIN_CHECKPOINTS.NONE ||
    await hasPersistedTransactions(transactionDirectory);

  const persistedMachine = await loadPersistedTransaction(
    umi,
    transactionDirectory,
    'create-candy-machine',
  );
  if (
    await retryRead(() => umi.rpc.accountExists(candyMachine.publicKey)) &&
    !persistedMachine &&
    checkpointStage === CHAIN_CHECKPOINTS.NONE
  ) {
    return {
      addresses,
      tests: CHAIN_TESTS.map((id) => failure(
        id,
        'CHAIN_AUTHORITY',
        'The fixed validation candy machine already exists; use a fresh isolated validation key directory.',
      )),
    };
  }

  if (!recoveryActive) {
    const balances = await Promise.all([service, allowedA, allowedB, outsider].map(
      ({ publicKey }) => retryRead(() => umi.rpc.getBalance(publicKey)),
    ));
    const minimums = [500_000_000n, 20_000_000n, 20_000_000n, 20_000_000n];
    const insufficient = balances
      .map((amount, index) => amount.basisPoints < minimums[index] ? KEY_NAMES[index] : null)
      .filter(Boolean);
    if (insufficient.length > 0) {
      const reason = `Insufficient isolated Devnet fixture balance: ${insufficient.join(', ')}. Fund only the public validation addresses recorded in evidence.`;
      return { addresses, tests: CHAIN_TESTS.map((id) => notRun(id, 'CHAIN_AUTHORITY', reason)) };
    }
  }

  if (checkpointStage < CHAIN_CHECKPOINTS.LOCKED) {
    umi.use(umiModule.signerIdentity(service));
    await submit(core.createCollection(umi, {
      collection,
      updateAuthority: service.publicKey,
      payer: service,
      name: NAME,
      uri: URI,
      plugins: [{ type: 'ImmutableMetadata' }],
    }), 'create-collection');
    await submit(core.createCollection(umi, {
      collection: alternateCollection,
      updateAuthority: service.publicKey,
      payer: service,
      name: `${NAME} alternate`,
      uri: URI,
    }), 'create-alternate-collection');

    const startDate = umiModule.dateTime(Math.floor(Date.now() / 1000) + 3600);
    const createBuilder = await candy.create(umi, {
      candyMachine,
      collection: collection.publicKey,
      collectionUpdateAuthority: service,
      payer: service,
      authority: service.publicKey,
      itemsAvailable: 2,
      maxEditionSupply: 0,
      isMutable: false,
      hiddenSettings: umiModule.some({ name: NAME, uri: URI, hash: new Uint8Array(32) }),
      configLineSettings: umiModule.none(),
      guards: {
        allowList: umiModule.some({ merkleRoot }),
        mintLimit: umiModule.some({ id: 0, limit: 1 }),
        startDate: umiModule.some({ date: startDate }),
      },
      groups: [],
    });
    await submit(createBuilder, 'create-candy-machine');

    // Machine and collection lock while Start Date still blocks claims; the final atomic tx opens claims and locks Guard management.
    await submit(candy.setCandyMachineAuthority(umi, {
      candyMachine: candyMachine.publicKey,
      authority: service,
      newAuthority: lockAuthority,
    }), 'lock-machine-authority');
    await submit(core.removeCollectionPlugin(umi, {
      collection: collection.publicKey, payer: service, authority: service, plugin: { type: 'ImmutableMetadata' },
    }).add(core.updateCollectionV1(umi, {
      collection: collection.publicKey,
      payer: service,
      authority: service,
      newUpdateAuthority: lockAuthority,
      newName: umiModule.none(),
      newUri: umiModule.none(),
    })), 'lock-collection-authority');
    await submit(createFinalLockBuilder({
      umi,
      candy,
      authority: service,
      candyGuard,
      lockAuthority,
      merkleRoot,
    }), 'open-and-lock-guard');
  }

  const machineState = await retryRead(() => candy.fetchCandyMachine(umi, candyMachine.publicKey));
  const guardState = await retryRead(() => candy.fetchCandyGuard(umi, candyGuard));
  const collectionState = await retryRead(() => core.fetchCollection(umi, collection.publicKey));
  const immutableAuthorityKind = collectionState.immutableMetadata?.authority?.type ?? null;
  const collectionDelegates = presentDelegatePlugins(collectionState);
  const collectionMintDelegate = {
    expected: String(candy.findCandyMachineAuthorityPda(umi, { candyMachine: candyMachine.publicKey })[0]),
    authorityKind: collectionState.updateDelegate?.authority?.type ?? null,
    actual: (collectionState.updateDelegate?.additionalDelegates ?? []).map(String),
  };
  if (
    String(machineState.authority) !== String(lockAuthority) ||
    String(machineState.mintAuthority) !== String(candyGuard[0]) ||
    String(guardState.authority) !== String(lockAuthority) ||
    String(collectionState.updateAuthority) !== String(lockAuthority) ||
    collectionState.immutableMetadata !== undefined ||
    collectionDelegates.length !== 1 || collectionDelegates[0] !== 'updateDelegate' ||
    collectionMintDelegate.authorityKind !== 'UpdateAuthority' || collectionMintDelegate.actual.length !== 1 ||
    collectionMintDelegate.actual[0] !== collectionMintDelegate.expected
  ) {
    throw new Error('Locked machine, Guard, collection, or ImmutableMetadata state does not match the validation contract.');
  }

  const tests = recovered?.tests ?? [];
  const mintSignatures = recovered?.mintSignatures ?? [];
  const assetLockObservations = recovered?.assetLockObservations ?? [];
  let firstMintSignature = recovered?.firstMintSignature ?? null;
  let firstMintQuote = recovered?.firstMintQuote ?? null;
  const checkpoint = async (stage) => {
    await saveChainCheckpoint(transactionDirectory, {
      stage,
      tests,
      mintSignatures,
      assetLockObservations,
      firstMintSignature,
      firstMintQuote,
    });
    checkpointStage = stage;
  };
  if (checkpointStage < CHAIN_CHECKPOINTS.LOCKED) await checkpoint(CHAIN_CHECKPOINTS.LOCKED);

  const mintParticipant = async (index) => {
    const participant = participants[index];
    const preparedStage = index === 0
      ? CHAIN_CHECKPOINTS.MINT0_PREPARED
      : CHAIN_CHECKPOINTS.MINT1_PREPARED;
    const label = `mint-${index}`;
    umi.use(umiModule.signerIdentity(participant));
    let persisted = await loadPersistedTransaction(umi, transactionDirectory, label);

    if (checkpointStage < preparedStage) {
      const proof = candy.getMerkleProof(participants.map(({ publicKey }) => publicKey), participant.publicKey);
      await submit(candy.route(umi, {
        candyMachine: candyMachine.publicKey,
        candyGuard,
        payer: participant,
        guard: 'allowList',
        routeArgs: { path: 'proof', merkleRoot, merkleProof: proof, minter: participant.publicKey },
      }), `allow-list-proof-${index}`);
      let latest;
      let signed = persisted?.transaction;
      if (!signed) {
        const mintBuilder = candy.mintV1(umi, {
          candyMachine: candyMachine.publicKey,
          candyGuard,
          payer: participant,
          minter: participant,
          owner: participant.publicKey,
          asset: assets[index],
          collection: collection.publicKey,
          mintArgs: { allowList: { merkleRoot }, mintLimit: { id: 0 } },
        });
        latest = await mintBuilder.setLatestBlockhash(umi);
        signed = await latest.buildAndSign(umi);
      }
      const payer = String(signed.message.accounts[0]);
      const compiledOwnerIndex = signed.message.instructions?.[0]?.accountIndexes?.[6];
      const encodedOwner = latest
        ? String(latest.items[0].instruction.keys[6].pubkey)
        : String(signed.message.accounts[compiledOwnerIndex]);
      if (payer !== String(participant.publicKey) || encodedOwner !== payer) {
        throw new Error('Built mint message payer or encoded owner is not the recipient.');
      }

      if (index === 0) {
        const feeQuoteResponse = await umi.rpc.call('getFeeForMessage', [
          Buffer.from(signed.serializedMessage).toString('base64'),
          { commitment: 'confirmed' },
        ]);
        if (typeof feeQuoteResponse?.value !== 'number') throw new Error('RPC did not return a pre-mint fee quote.');
        const messagePublicKeys = signed.message.accounts;
        const messageAddresses = messagePublicKeys.map(String);
        const counterAddress = candy.findMintCounterPda(umi, {
          id: 0,
          user: participant.publicKey,
          candyGuard: candyGuard[0],
          candyMachine: candyMachine.publicKey,
        })[0];
        const preAccounts = await retryRead(() => umi.rpc.getAccounts(messagePublicKeys));
        const simulation = await retryRead(() => simulateSignedTransactionWithAccounts(umi, signed, messageAddresses));
        if (simulation?.value?.err || !Array.isArray(simulation?.value?.accounts)) {
          throw new Error(`Mint fee simulation failed: ${JSON.stringify(simulation?.value?.err ?? 'accounts unavailable')}`);
        }
        const assetIndex = messageAddresses.indexOf(String(assets[index].publicKey));
        const counterIndex = messageAddresses.indexOf(String(counterAddress));
        if (assetIndex < 0 || counterIndex < 0) throw new Error('Mint message omits the asset or Mint Counter account.');
        const [assetRentQuote, counterRentQuote] = await Promise.all([
          umi.rpc.getRent(rpcAccountDataLength(simulation.value.accounts[assetIndex])),
          umi.rpc.getRent(rpcAccountDataLength(simulation.value.accounts[counterIndex])),
        ]);
        const rentByAddress = new Map([
          [String(assets[index].publicKey), assetRentQuote.basisPoints],
          [String(counterAddress), counterRentQuote.basisPoints],
        ]);
        const quote = deriveMintFeeComponents({
          feeLamports: BigInt(feeQuoteResponse.value),
          priorityFeeLamports: 0n,
          payerAddress: payer,
          addresses: messageAddresses,
          preBalances: preAccounts.map(rpcAccountLamports),
          postBalances: simulation.value.accounts.map(rpcAccountLamports),
          rentByAddress,
        });
        if (quote.rentLamports <= 0n || quote.protocolLamports <= 0n) {
          throw new Error('Mint simulation did not expose nonzero rent and Core protocol components.');
        }
        firstMintQuote = { ...quote, addresses: messageAddresses, rentByAddress };
      }

      const published = persisted ?? await persistSignedTransaction(umi, signed, {
        directory: transactionDirectory,
        label,
      });
      if (index === 0) firstMintSignature = published.signatureText;
      await checkpoint(preparedStage);
      persisted = { transaction: signed, ...published };
    }

    if (!persisted) throw new Error(`Prepared mint ${index} is missing its persisted signed transaction.`);
    const signature = await reconcilePersistedTransaction(umi, persisted, {
      directory: transactionDirectory,
      label,
    });
    if (index === 0) {
      firstMintSignature = signature;
    }
    if (!mintSignatures.includes(signature)) mintSignatures.push(signature);
    const assetState = await retryRead(() => core.fetchAsset(umi, assets[index].publicKey));
    if (
      assetState.name !== NAME || assetState.uri !== URI ||
      String(assetState.owner) !== String(participant.publicKey) ||
      assetState.updateAuthority?.type !== 'Collection' ||
      String(assetState.updateAuthority.address) !== String(collection.publicKey) ||
      presentDelegatePlugins(assetState).length > 0
    ) {
      throw new Error('Minted asset metadata, owner, or collection update authority is incorrect.');
    }
    if (!assetLockObservations.some(({ address }) => address === String(assets[index].publicKey))) {
      assetLockObservations.push({
        address: String(assets[index].publicKey),
        updateAuthority: {
          type: assetState.updateAuthority.type,
          address: String(assetState.updateAuthority.address),
        },
        delegatePluginsPresent: presentDelegatePlugins(assetState),
      });
    }
  };
  const mintCounterSeeds = {
    id: 0,
    user: allowedA.publicKey,
    candyGuard: candyGuard[0],
    candyMachine: candyMachine.publicKey,
  };
  const secondMint = () => candy.mintV1(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard,
    payer: allowedA,
    minter: allowedA,
    owner: allowedA.publicKey,
    asset: umiModule.generateSigner(umi),
    collection: collection.publicKey,
    mintArgs: { allowList: { merkleRoot }, mintLimit: { id: 0 } },
  });
  if (checkpointStage < CHAIN_CHECKPOINTS.PRE_TRANSFER) {
    await mintParticipant(0);
    const counterAfterMint = await retryRead(() => candy.safeFetchMintCounterFromSeeds(umi, mintCounterSeeds));
    if (counterAfterMint?.count !== 1) throw new Error('Mint-limit counter did not record the first mint.');

    // Rejection checks run with one item still available, so sold-out cannot mask allow-list or counter failures.
    umi.use(umiModule.signerIdentity(outsider));
    tests.push(await expectProgramRejection('outsiderRejected', umi, candy.mintV1(umi, {
      candyMachine: candyMachine.publicKey,
      candyGuard,
      payer: outsider,
      minter: outsider,
      owner: outsider.publicKey,
      asset: umiModule.generateSigner(umi),
      collection: collection.publicKey,
      mintArgs: { allowList: { merkleRoot }, mintLimit: { id: 0 } },
    }), rpcUrl, programAddresses.mplCoreCandyGuard, [0x178b]));

    umi.use(umiModule.signerIdentity(allowedA));
    tests.push(await expectProgramRejection('secondMintRejected', umi, secondMint(), rpcUrl, programAddresses.mplCoreCandyGuard, [0x178d]));

    umi.use(umiModule.signerIdentity(service));
    tests.push(await expectProgramRejection('nameChangeRejected', umi, core.updateCollectionV1(umi, {
    collection: collection.publicKey, payer: service, authority: service,
    newName: umiModule.some('mutated'), newUri: umiModule.none(),
  }), rpcUrl, programAddresses.mplCore, [0x9, 0x1a]));
  tests.push(await expectProgramRejection('uriChangeRejected', umi, core.updateCollectionV1(umi, {
    collection: collection.publicKey, payer: service, authority: service,
    newName: umiModule.none(), newUri: umiModule.some('https://example.invalid/mutated'),
  }), rpcUrl, programAddresses.mplCore, [0x9, 0x1a]));
  tests.push(await expectProgramRejection('rootChangeRejected', umi, candy.updateCandyGuard(umi, {
    candyGuard, authority: service,
    guards: { allowList: umiModule.some({ merkleRoot: new Uint8Array(32) }), mintLimit: umiModule.some({ id: 0, limit: 1 }) },
    groups: [],
  }), rpcUrl, programAddresses.mplCoreCandyGuard, [0x7d1, 0x1772]));
  tests.push(await expectProgramRejection('supplyChangeRejected', umi, candy.updateCandyMachine(umi, {
    candyMachine: candyMachine.publicKey, authority: service,
    data: { ...machineState.data, itemsAvailable: 3 },
  }), rpcUrl, programAddresses.mplCoreCandyMachine, [0x7d1, 0x1770]));
  tests.push(await expectProgramRejection('mintAuthorityChangeRejected', umi, candy.setMintAuthority(umi, {
    candyMachine: candyMachine.publicKey, authority: service, mintAuthority: service,
  }), rpcUrl, programAddresses.mplCoreCandyMachine, [0x7d1, 0x1770]));
  tests.push(await expectProgramRejection('noBypassGuardGroup', umi, candy.mintAssetFromCandyMachine(umi, {
    candyMachine: candyMachine.publicKey,
    mintAuthority: service,
    payer: service,
    assetOwner: service.publicKey,
    asset: umiModule.generateSigner(umi),
    collection: collection.publicKey,
    plugins: [],
  }), rpcUrl, programAddresses.mplCoreCandyMachine, [0x7d1, 0x1770, 0x1772]));

  tests.push(await expectProgramRejection('assetMetadataChangeRejected', umi, core.updateV1(umi, {
    asset: assets[0].publicKey, collection: collection.publicKey, payer: service, authority: service,
    newName: umiModule.some('mutated'), newUri: umiModule.none(), newUpdateAuthority: umiModule.none(),
  }), rpcUrl, programAddresses.mplCore, [0x9, 0x1a]));
    tests.push(await expectProgramRejection('collectionChangeRejected', umi, core.updateV2(umi, {
    asset: assets[0].publicKey, collection: collection.publicKey, newCollection: alternateCollection.publicKey,
    payer: service, authority: service, newName: umiModule.none(), newUri: umiModule.none(),
    newUpdateAuthority: umiModule.none(),
    }), rpcUrl, programAddresses.mplCore, [0x9, 0x1a]));
    await checkpoint(CHAIN_CHECKPOINTS.PRE_TRANSFER);
  }

  if (checkpointStage < CHAIN_CHECKPOINTS.TRANSFERRED) {
    umi.use(umiModule.signerIdentity(allowedA));
    const transferSignature = await submit(core.transferV1(umi, {
      asset: assets[0].publicKey,
      collection: collection.publicKey,
      payer: allowedA,
      authority: allowedA,
      newOwner: outsider.publicKey,
    }), 'transfer-asset-a');
    const transferred = await retryRead(() => core.fetchAsset(umi, assets[0].publicKey));
    if (String(transferred.owner) !== String(outsider.publicKey)) throw new Error('Transferred asset owner did not change.');
    const transferResult = pass('transferWorks', 'CHAIN_AUTHORITY', 'Minted asset transferred to the outsider fixture.');
    transferResult.signatures = [transferSignature];
    tests.push(transferResult);
    const counterAfterTransfer = await retryRead(() => candy.safeFetchMintCounterFromSeeds(umi, mintCounterSeeds));
    if (counterAfterTransfer?.count !== 1) throw new Error('Mint-limit counter changed after transfer.');
    tests.push(await expectProgramRejection('remintAfterTransferRejected', umi, secondMint(), rpcUrl, programAddresses.mplCoreCandyGuard, [0x178d]));
    await checkpoint(CHAIN_CHECKPOINTS.TRANSFERRED);
  }

  if (checkpointStage < CHAIN_CHECKPOINTS.BURNED) {
    umi.use(umiModule.signerIdentity(outsider));
    const burnSignature = await submit(core.burnV1(umi, {
      asset: assets[0].publicKey,
      collection: collection.publicKey,
      payer: outsider,
      authority: outsider,
    }), 'burn-asset-a');
    const burnTombstone = inspectBurnTombstone(
      await retryRead(() => umi.rpc.getAccount(assets[0].publicKey)),
      programAddresses.mplCore,
    );
    const counterAfterBurn = await retryRead(() => candy.safeFetchMintCounterFromSeeds(umi, mintCounterSeeds));
    if (counterAfterBurn?.count !== 1) throw new Error('Mint-limit counter changed after burn.');
    umi.use(umiModule.signerIdentity(allowedA));
    const remintAfterBurn = await expectProgramRejection(
      'remintAfterBurnRejected',
      umi,
      secondMint(),
      rpcUrl,
      programAddresses.mplCoreCandyGuard,
      [0x178d],
    );
    tests.push(attachBurnSupportEvidence(
      remintAfterBurn,
      burnSignature,
      burnTombstone,
      counterAfterBurn.count,
    ));
    await checkpoint(CHAIN_CHECKPOINTS.BURNED);
  }

  if (checkpointStage < CHAIN_CHECKPOINTS.MINTS_COMPLETE) {
    await mintParticipant(1);
    await checkpoint(CHAIN_CHECKPOINTS.MINTS_COMPLETE);
  }
  const mintResult = pass('mintAfterLock', 'CHAIN_AUTHORITY', 'Both allowed wallets minted after every management authority was locked.');
  mintResult.signatures = mintSignatures;
  tests.push(mintResult);
  const payerResult = pass('payerIsRecipient', 'CHAIN_AUTHORITY', 'Both signed mint messages encode the recipient as fee payer and asset owner.');
  payerResult.signatures = mintSignatures;
  tests.push(payerResult);

  const bs58Module = require('bs58');
  const bs58 = bs58Module.default?.decode ? bs58Module.default : bs58Module;
  const mintTx = await retryRead(() => umi.rpc.getTransaction(
    bs58.decode(firstMintSignature),
    { commitment: 'finalized' },
  ));
  if (!mintTx || mintTx.meta.err) throw new Error('Could not retrieve successful mint fee metadata.');
  const confirmed = deriveMintFeeComponents({
    feeLamports: mintTx.meta.fee.basisPoints,
    priorityFeeLamports: 0n,
    payerAddress: firstMintQuote.addresses[0],
    addresses: firstMintQuote.addresses,
    preBalances: mintTx.meta.preBalances.map(({ basisPoints }) => basisPoints),
    postBalances: mintTx.meta.postBalances.map(({ basisPoints }) => basisPoints),
    rentByAddress: firstMintQuote.rentByAddress,
  });
  if (!confirmed.feeObservedInPayerBalance) {
    throw new Error('Confirmed mint payer balance does not include the transaction fee.');
  }
  if (
    confirmed.feeLamports !== firstMintQuote.feeLamports ||
    confirmed.priorityFeeLamports !== firstMintQuote.priorityFeeLamports ||
    confirmed.rentLamports !== firstMintQuote.rentLamports ||
    confirmed.protocolLamports !== firstMintQuote.protocolLamports ||
    confirmed.payerDebitLamports !== firstMintQuote.payerDebitLamports
  ) {
    throw new Error(`Simulated mint quote ${firstMintQuote.totalLamports} does not match confirmed components ${confirmed.totalLamports}.`);
  }
  tests.push(pass('feeEstimateMatchesInstructions', 'CHAIN_AUTHORITY', 'The exact signed mint simulation and confirmed receipt agree on named fee, rent, and nonzero Core protocol components.', {
    payerDeltaLamports: confirmed.payerDebitLamports.toString(),
    observedPayerDeltaLamports: confirmed.observedPayerDebitLamports.toString(),
    transactionFeeLamports: confirmed.feeLamports.toString(),
    priorityFeeLamports: confirmed.priorityFeeLamports.toString(),
    accountRentLamports: confirmed.rentLamports.toString(),
    protocolLamports: confirmed.protocolLamports.toString(),
    quotedLamports: firstMintQuote.totalLamports.toString(),
    namedAccounts: confirmed.namedAccounts,
  }));
  const observedLockState = {
    candyGuardAddress: String(candyGuard[0]),
    collectionAddress: String(collection.publicKey),
    derivation: {
      programId: SYSTEM_PROGRAM_ID,
      seedUtf8: 'cameo-nft-lock-v1',
      bump: lockPda[1],
      address: String(lockAuthority),
    },
    machineAuthority: { expected: String(lockAuthority), actual: String(machineState.authority) },
    mintAuthority: { expected: String(candyGuard[0]), actual: String(machineState.mintAuthority) },
    guardAuthority: { expected: String(lockAuthority), actual: String(guardState.authority) },
    collectionUpdateAuthority: {
      expected: String(lockAuthority),
      actual: String(collectionState.updateAuthority),
    },
    immutableMetadata: {
      present: false,
      authorityKind: immutableAuthorityKind,
    },
    collectionMetadataProtection: 'LOCKED_AUTHORITY',
    collectionDelegatePluginsPresent: collectionDelegates,
    collectionMintDelegate,
    assets: assetLockObservations,
  };
  return { addresses, tests, observedLockState };
}

/** Executes external gates only after isolated fixtures, Devnet identity, program deployment, and funding checks. */
async function executeDevnetValidation({ environment, local, gitCommit }) {
  const rpcUrl = environment.SOLANA_RPC_URL;
  const modules = await require('./sdk-validation.cjs').loadSdkModules();
  const umiModule = modules['@metaplex-foundation/umi'];
  const { createUmi } = modules['@metaplex-foundation/umi-bundle-defaults'];
  const core = modules['@metaplex-foundation/mpl-core'];
  const candy = modules['@metaplex-foundation/mpl-core-candy-machine'];
  const umi = createUmi(rpcUrl).use(core.mplCore()).use(candy.mplCandyMachine());
  const { directory: fixtureDirectory, signers } = await loadFixtureSigners(
    umi,
    umiModule,
    environment.NFT_PREPARATION_KEY_DIR,
  );
  const addresses = Object.fromEntries(KEY_NAMES.map((name) => [name, String(signers[name].publicKey)]));

  try {
    if (await retryRead(() => rpcGenesisHash(umi)) !== GENESIS_HASHES.devnet) {
      const reason = 'Configured RPC genesis hash is not Devnet.';
      return finalizeEvidence(local, [
        ...CHAIN_TESTS.map((id) => failure(id, 'CHAIN_AUTHORITY', reason)),
        ...STORAGE_TESTS.map((id) => notRun(id, 'STORAGE_RECOVERY', reason)),
      ], { gitCommit, addresses });
    }
    if (!await retryRead(() => programAccountsAreExecutable(umi, local.programAddresses))) {
      const reason = 'One or more pinned SDK program accounts are absent or not executable on Devnet.';
      return finalizeEvidence(local, [
        ...CHAIN_TESTS.map((id) => failure(id, 'CHAIN_AUTHORITY', reason)),
        ...STORAGE_TESTS.map((id) => notRun(id, 'STORAGE_RECOVERY', reason)),
      ], { gitCommit, addresses });
    }
  } catch (error) {
    const reason = `RPC preflight unavailable: ${redactDiagnostic(error.message, rpcUrl)}`;
    return finalizeEvidence(local, [
      ...CHAIN_TESTS.map((id) => notRun(id, 'CHAIN_AUTHORITY', reason)),
      ...STORAGE_TESTS.map((id) => notRun(id, 'STORAGE_RECOVERY', reason)),
    ], { gitCommit, addresses });
  }

  let chain;
  try {
    chain = await runChainValidation({
      umi,
      modules,
      fixtures: signers,
      rpcUrl,
      programAddresses: local.programAddresses,
      transactionDirectory: join(fixtureDirectory, 'signed-transactions'),
    });
  } catch (error) {
    chain = { addresses, tests: chainResultsForError(error, rpcUrl) };
  }
  const storage = await storageValidation({
    turboModule: modules['@ardrive/turbo-sdk'],
    service: signers.service,
    workRoot: environment.NFT_UPLOAD_WORK_DIR,
    rpcUrl,
  });
  return finalizeEvidence(local, [...chain.tests, ...storage], {
    gitCommit,
    addresses: chain.addresses,
    observedLockState: chain.observedLockState,
  });
}

module.exports = {
  AmbiguousTransactionError,
  CHAIN_CHECKPOINTS,
  attachBurnSupportEvidence,
  chainResultsForError,
  createFinalLockBuilder,
  customErrorCode,
  deriveMintFeeComponents,
  executeDevnetValidation,
  evidenceIntegrityErrors,
  finalizeEvidence,
  isProgramRejection,
  inspectBurnTombstone,
  loadFixtureSigners,
  matchesExpectedProgramRejection,
  observedLockStateErrors,
  redactDiagnostic,
  retryRead,
  runChainValidation,
  saveChainCheckpoint,
  send,
  sendSignedTransaction,
  simulationRejectionEvidence,
  uploadSignedItemWithRetry,
};
