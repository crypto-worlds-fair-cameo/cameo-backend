const { createHash, randomBytes } = require('node:crypto');
const {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  unlink,
} = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { dirname, join, parse } = require('node:path');

const EXPECTED_PACKAGES = Object.freeze({
  '@ardrive/turbo-sdk': '2.1.0',
  '@metaplex-foundation/mpl-core': '1.10.0',
  '@metaplex-foundation/mpl-core-candy-machine': '0.3.0',
  '@metaplex-foundation/umi': '0.8.10',
  '@metaplex-foundation/umi-bundle-defaults': '0.8.10',
});

const PROGRAM_ADDRESSES = Object.freeze({
  mplCore: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
  mplCoreCandyMachine: 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J',
  mplCoreCandyGuard: 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ',
});

const GENESIS_HASHES = Object.freeze({
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
});

const REQUIRED_EXTERNAL_TESTS = Object.freeze([
  'mintAfterLock',
  'outsiderRejected',
  'secondMintRejected',
  'nameChangeRejected',
  'uriChangeRejected',
  'rootChangeRejected',
  'supplyChangeRejected',
  'transferWorks',
  'remintAfterTransferRejected',
  'proofFits100',
  'mintFits100',
  'uploadItemRestoresSameId',
  'remintAfterBurnRejected',
  'assetMetadataChangeRejected',
  'collectionChangeRejected',
  'mintAuthorityChangeRejected',
  'noBypassGuardGroup',
  'payerIsRecipient',
  'feeEstimateMatchesInstructions',
  'permanentUploadRetrievable',
]);

const REQUIRED_EXPORTS = Object.freeze({
  '@metaplex-foundation/umi': [
    'generateSigner',
    'createSignerFromKeypair',
    'none',
    'publicKey',
    'signerIdentity',
    'some',
  ],
  '@metaplex-foundation/umi-bundle-defaults': ['createUmi'],
  '@metaplex-foundation/mpl-core': [
    'burnV1',
    'createCollection',
    'createCollectionV2',
    'fetchAsset',
    'fetchCollection',
    'mplCore',
    'transferV1',
    'updateCollectionV1',
    'updateV1',
    'updateV2',
  ],
  '@metaplex-foundation/mpl-core-candy-machine': [
    'create',
    'fetchCandyGuard',
    'fetchCandyMachine',
    'findMintCounterPda',
    'getMerkleProof',
    'getMerkleRoot',
    'mintAssetFromCandyMachine',
    'mintV1',
    'route',
    'safeFetchAllowListProofFromSeeds',
    'safeFetchMintCounterFromSeeds',
    'setCandyGuardAuthority',
    'setCandyMachineAuthority',
    'setMintAuthority',
    'updateCandyGuard',
    'updateCandyMachine',
  ],
  '@ardrive/turbo-sdk': ['TurboFactory'],
});

/** Loads all external SDKs in one adapter so application code does not guess CJS/ESM export shapes. */
async function loadSdkModules() {
  const entries = await Promise.all(
    Object.keys(EXPECTED_PACKAGES).map(async (name) => {
      const imported = await import(name);
      return [name, imported.default ? { ...imported.default, ...imported } : imported];
    }),
  );
  return Object.fromEntries(entries);
}

/** Reads the package owning an installed entry point and returns its published version. */
async function readInstalledVersion(packageName) {
  let current = dirname(require.resolve(packageName));
  const root = parse(current).root;

  // Walk only toward the filesystem root and accept the package whose name matches the requested entry point.
  while (current !== root) {
    try {
      const packageJson = JSON.parse(await readFile(join(current, 'package.json'), 'utf8'));
      if (packageJson.name === packageName) return packageJson.version;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    current = dirname(current);
  }
  throw new Error(`Could not locate installed package metadata for ${packageName}.`);
}

/** Verifies exact versions, runtime exports, and deployed program IDs used by later NFT providers. */
async function loadSdkContract() {
  const modules = await loadSdkModules();
  const packages = Object.fromEntries(
    await Promise.all(
      Object.keys(EXPECTED_PACKAGES).map(async (name) => [name, await readInstalledVersion(name)]),
    ),
  );
  const missingExports = [];

  for (const [packageName, exportNames] of Object.entries(REQUIRED_EXPORTS)) {
    for (const exportName of exportNames) {
      if (typeof modules[packageName][exportName] !== 'function') {
        missingExports.push(`${packageName}:${exportName}`);
      }
    }
  }

  const candy = modules['@metaplex-foundation/mpl-core-candy-machine'];
  const core = modules['@metaplex-foundation/mpl-core'];
  const programAddresses = {
    mplCore: String(core.MPL_CORE_PROGRAM_ID),
    mplCoreCandyMachine: String(candy.MPL_CORE_CANDY_MACHINE_CORE_PROGRAM_ID),
    mplCoreCandyGuard: String(candy.MPL_CORE_CANDY_GUARD_PROGRAM_ID),
  };

  return { modules, packages, programAddresses, missingExports };
}

function pass(id, gate, message, details = undefined) {
  return {
    id,
    gate,
    status: 'PASS',
    signatures: [],
    reason: null,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

function notRun(id, gate, reason) {
  return { id, gate, status: 'NOT_RUN', signatures: [], reason };
}

async function streamToBuffer(stream) {
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function signedDataItemId(bytes) {
  if (bytes.length < 66) throw new Error('Signed data item is shorter than its signature header.');
  return createHash('sha256').update(bytes.subarray(2, 66)).digest('base64url');
}

/** Publishes signed bytes without replacing an existing final item, then fsyncs the containing directory. */
async function publishSignedItem(directory, fileName, bytes) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const finalPath = join(directory, fileName);
  const temporaryPath = join(directory, `.${fileName}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await link(temporaryPath, finalPath);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(finalPath);
    if (!existing.equals(bytes)) {
      throw new Error('Existing signed data item does not match the newly signed bytes.');
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  const directoryHandle = await open(await realpath(directory), 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  return finalPath;
}

/** Builds the exact 100-wallet proof and mint messages later providers submit, without using an RPC endpoint. */
async function buildLocalTransactions(modules) {
  const umiModule = modules['@metaplex-foundation/umi'];
  const { createUmi } = modules['@metaplex-foundation/umi-bundle-defaults'];
  const core = modules['@metaplex-foundation/mpl-core'];
  const candy = modules['@metaplex-foundation/mpl-core-candy-machine'];
  const umi = createUmi('http://127.0.0.1:8899')
    .use(core.mplCore())
    .use(candy.mplCandyMachine());
  const recipient = umiModule.generateSigner(umi);
  umi.use(umiModule.signerIdentity(recipient));

  const allowList = Array.from({ length: 100 }, () => umiModule.generateSigner(umi).publicKey);
  allowList[0] = recipient.publicKey;
  const merkleRoot = candy.getMerkleRoot(allowList);
  const merkleProof = candy.getMerkleProof(allowList, recipient.publicKey);
  const candyMachine = umiModule.generateSigner(umi).publicKey;
  const candyGuard = umiModule.generateSigner(umi).publicKey;
  const collection = umiModule.generateSigner(umi).publicKey;
  const blockhash = '11111111111111111111111111111111';

  const proofBuilder = candy
    .route(umi, {
      candyMachine,
      candyGuard,
      payer: recipient,
      guard: 'allowList',
      routeArgs: {
        path: 'proof',
        merkleRoot,
        merkleProof,
        minter: recipient.publicKey,
      },
    })
    .setBlockhash(blockhash);
  const mintBuilder = candy
    .mintV1(umi, {
      candyMachine,
      candyGuard,
      payer: recipient,
      minter: recipient,
      owner: recipient.publicKey,
      asset: umiModule.generateSigner(umi),
      collection,
      mintArgs: {
        allowList: { merkleRoot },
        mintLimit: { id: 0 },
      },
    })
    .setBlockhash(blockhash);
  // Production과 같이 0 우선 수수료도 명시한 실제 packet 크기를 검증한다.
  const computeBudget = [
    Uint8Array.from([2, 0x40, 0x0d, 0x03, 0x00]), // 200,000 CU
    Uint8Array.from([3, 0, 0, 0, 0, 0, 0, 0, 0]),
  ].map((data) => ({
    instruction: { keys: [], programId: umiModule.publicKey('ComputeBudget111111111111111111111111111111'), data },
    signers: [], bytesCreatedOnChain: 0,
  }));
  const [proofTransaction, mintTransaction] = await Promise.all([
    proofBuilder.prepend(computeBudget).buildAndSign(umi),
    mintBuilder.prepend(computeBudget).buildAndSign(umi),
  ]);

  // Umi orders required signer keys first; verify each detached Ed25519 signature against the exact message bytes.
  const verifySignatures = (transaction) => ({
    required: transaction.signatures.length,
    valid: transaction.signatures.filter((signature, index) => (
      signature.length === 64 &&
      Buffer.from(signature).some((byte) => byte !== 0) &&
      umi.eddsa.verify(
        transaction.serializedMessage,
        signature,
        transaction.message.accounts[index],
      )
    )).length,
  });
  const proofSignatures = verifySignatures(proofTransaction);
  const mintSignatures = verifySignatures(mintTransaction);
  const encodedOwner = mintBuilder.items[0]?.instruction.keys[6]?.pubkey;

  const proofBytes = umi.transactions.serialize(proofTransaction).length;
  const mintBytes = umi.transactions.serialize(mintTransaction).length;
  return {
    proofBytes,
    mintBytes,
    payer: mintTransaction.message.accounts[0],
    recipient: recipient.publicKey,
    encodedOwner,
    transactionSignatures: {
      proof: proofSignatures,
      mint: mintSignatures,
    },
    merkleRoot: Buffer.from(merkleRoot).toString('hex'),
    proofNodeCount: merkleProof.length,
    signerSecretKey: recipient.secretKey,
  };
}

/** Signs a real Turbo data item, persists its exact bytes, and proves reload retains the ANS-104 item ID. */
async function verifySignedItemRestore(turboModule, signerSecretKey, workDirectory) {
  const bs58Module = await import('bs58');
  const bs58 = bs58Module.default?.encode ? bs58Module.default : bs58Module;
  const payload = Buffer.from('cameo season nft sdk recovery fixture', 'utf8');
  const turbo = turboModule.TurboFactory.authenticated({
    privateKey: bs58.encode(signerSecretKey),
    token: 'solana',
    gatewayUrl: 'https://api.devnet.solana.com',
  });
  const signed = await turbo.signer.signDataItem({
    fileStreamFactory: () => Buffer.from(payload),
    fileSizeFactory: () => payload.length,
    dataItemOpts: {
      tags: [
        { name: 'Content-Type', value: 'text/plain' },
        { name: 'App-Name', value: 'Cameo-Season-NFT-SDK-Validation' },
      ],
    },
  });
  const bytes = await streamToBuffer(signed.dataItemStreamFactory());
  const beforeId = signedDataItemId(bytes);
  const filePath = await publishSignedItem(workDirectory, 'sdk-recovery.signed', bytes);
  const restored = await readFile(filePath);
  const afterId = signedDataItemId(restored);

  if (signed.dataItemSizeFactory() !== restored.length || beforeId !== afterId) {
    throw new Error('Turbo signed item changed after persistence and reload.');
  }
  return { id: beforeId, byteLength: restored.length, filePath };
}

/** Runs local SDK integration checks and reports only checks proven by real imports and serialized bytes. */
async function verifyLocalSdk(options = {}) {
  const contract = await loadSdkContract();
  if (contract.missingExports.length > 0) {
    throw new Error(`Missing SDK exports: ${contract.missingExports.join(', ')}`);
  }
  if (JSON.stringify(contract.packages) !== JSON.stringify(EXPECTED_PACKAGES)) {
    throw new Error('Installed SDK versions do not match the pinned validation contract.');
  }
  if (JSON.stringify(contract.programAddresses) !== JSON.stringify(PROGRAM_ADDRESSES)) {
    throw new Error('Installed SDK program addresses do not match the official deployment addresses.');
  }

  const transactions = await buildLocalTransactions(contract.modules);
  if (transactions.proofBytes > 1232 || transactions.mintBytes > 1232) {
    throw new Error('A proof or mint transaction exceeds the 1232-byte Solana limit.');
  }
  if (String(transactions.payer) !== String(transactions.recipient)) {
    throw new Error('Mint transaction fee payer is not the NFT recipient.');
  }
  if (String(transactions.encodedOwner) !== String(transactions.recipient)) {
    throw new Error('Mint instruction owner is not the NFT recipient.');
  }
  for (const [name, signatures] of Object.entries(transactions.transactionSignatures)) {
    if (signatures.required === 0 || signatures.valid !== signatures.required) {
      throw new Error(`${name} transaction does not contain valid signatures for every required signer.`);
    }
  }

  const workDirectory = options.workDirectory ??
    (await mkdtemp(join(tmpdir(), 'cameo-season-nft-sdk-')));
  const signedItem = await verifySignedItemRestore(
    contract.modules['@ardrive/turbo-sdk'],
    transactions.signerSecretKey,
    workDirectory,
  );

  return {
    packages: contract.packages,
    programAddresses: contract.programAddresses,
    transactionBytes: { proof: transactions.proofBytes, mint: transactions.mintBytes },
    payer: String(transactions.payer),
    recipient: String(transactions.recipient),
    encodedOwner: String(transactions.encodedOwner),
    transactionSignatures: transactions.transactionSignatures,
    merkleRoot: transactions.merkleRoot,
    proofNodeCount: transactions.proofNodeCount,
    signedItem,
    checks: [
      pass('sdkExports', 'LOCAL_SDK', 'Required SDK operations are callable.'),
      pass('sdkVersions', 'LOCAL_SDK', 'Installed SDK versions match the lockfile contract.'),
      pass('programAddresses', 'LOCAL_SDK', 'SDK program IDs match official Core deployments.'),
      pass('proofFits100', 'LOCAL_SDK', 'A 100-wallet allow-list proof transaction fits 1232 bytes.', {
        byteLength: transactions.proofBytes,
        proofNodeCount: transactions.proofNodeCount,
      }),
      pass('mintFits100', 'LOCAL_SDK', 'The paired guarded mint transaction fits 1232 bytes.', {
        byteLength: transactions.mintBytes,
      }),
      pass('payerRecipientSerialization', 'LOCAL_SDK', 'Signed mint message payer and encoded owner are the recipient.'),
      pass('signedItemRoundTrip', 'LOCAL_SDK', 'Persisted signed bytes retain their locally derived data item ID.', {
        id: signedItem.id,
        byteLength: signedItem.byteLength,
      }),
    ],
  };
}

/** Creates evidence that preserves local PASS results while external gates remain explicitly unexecuted. */
function createPendingEvidence(local, reason, metadata = {}) {
  const localIds = new Set(local.checks.map(({ id }) => id));
  const external = REQUIRED_EXTERNAL_TESTS
    .filter((id) => !localIds.has(id))
    .map((id) => notRun(
      id,
      ['uploadItemRestoresSameId', 'permanentUploadRetrievable'].includes(id)
        ? 'STORAGE_RECOVERY'
        : 'CHAIN_AUTHORITY',
      reason,
    ));
  const storageIncomplete = external.some(({ gate }) => gate === 'STORAGE_RECOVERY');

  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    network: 'devnet',
    gitCommit: metadata.gitCommit ?? null,
    packages: local.packages,
    programAddresses: local.programAddresses,
    gates: {
      LOCAL_SDK: 'PASS',
      CHAIN_AUTHORITY: 'NOT_RUN',
      STORAGE_RECOVERY: storageIncomplete ? 'NOT_RUN' : 'PASS',
    },
    tests: [...local.checks, ...external],
    overallStatus: 'EXTERNAL_VALIDATION_PENDING',
  };
}

module.exports = {
  EXPECTED_PACKAGES,
  GENESIS_HASHES,
  PROGRAM_ADDRESSES,
  REQUIRED_EXTERNAL_TESTS,
  createPendingEvidence,
  loadSdkContract,
  loadSdkModules,
  notRun,
  pass,
  publishSignedItem,
  signedDataItemId,
  streamToBuffer,
  verifyLocalSdk,
};
