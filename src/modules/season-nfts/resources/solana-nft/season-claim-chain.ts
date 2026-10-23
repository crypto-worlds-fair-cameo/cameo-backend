import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createNoopSigner,
  generateSigner,
  isSome,
  publicKey,
  signerIdentity,
  type MaybeRpcAccount,
  type Signer,
  type Transaction,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import * as core from '@metaplex-foundation/mpl-core';
import * as candy from '@metaplex-foundation/mpl-core-candy-machine';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import {
  ClaimRepository,
  type ClaimBuildSource,
} from '../claim/claim.repository';
import {
  NftClaimBuildOperationProvider,
  NftClaimReceiptLookup,
  NftOperationPermanentError,
  type ReceiptLookupResult,
} from '../nft-worker/nft-runtime-queue';
import { withDbOnlyRetry } from '../nft-worker/db-only-retry';
import type { NftRpcJob, NftRpcScheduler } from '../nft-worker/rpc-scheduler';
import { NftTransactionRepository } from './nft-transaction.repository';
import { SeasonNftRpcTransport } from './season-release-chain';
import {
  type DispatchableNftTransaction,
  NftClaimEffectRpc,
  type NftTransactionInspection,
} from './nft-transaction-dispatcher';

const CANDY_GUARD_PROGRAM_ID = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
const CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

export type ClaimQuote = Readonly<{
  totalLamports: bigint;
  transactionFeeLamports: bigint;
  priorityFeeLamports: bigint;
  accountRentLamports: bigint;
  protocolFeeLamports: bigint;
}>;

export function selectClaimPriorityFee(
  input: Readonly<{
    estimatedMicroLamports: bigint;
    consumedUnits: bigint;
    capLamports: bigint;
  }>,
): Readonly<{
  computeUnitLimit: number;
  microLamports: bigint;
  quotedLamports: bigint;
}> {
  if (input.consumedUnits <= 0n)
    throw new Error('Claim compute usage must be positive.');
  const computeUnitLimit = Math.min(
    1_400_000,
    Math.max(
      Number(input.consumedUnits) + 10_000,
      Math.ceil(Number(input.consumedUnits) * 1.2),
    ),
  );
  const estimate =
    (input.estimatedMicroLamports * BigInt(computeUnitLimit) + 999_999n) /
    1_000_000n;
  const quotedLamports =
    estimate < input.capLamports ? estimate : input.capLamports;
  const microLamports =
    quotedLamports === 0n
      ? 0n
      : (quotedLamports * 1_000_000n) / BigInt(computeUnitLimit) || 1n;
  return { computeUnitLimit, microLamports, quotedLamports };
}

function accountLamports(account: MaybeRpcAccount): bigint {
  return account.exists ? account.lamports.basisPoints : 0n;
}

/** simulation의 named account credit을 rent와 protocol cost로 정확히 분리한다. */
export function deriveClaimQuote(
  input: Readonly<{
    feeLamports: bigint;
    priorityFeeLamports: bigint;
    payerAddress: string;
    addresses: readonly string[];
    preAccounts: readonly MaybeRpcAccount[];
    postAccounts: readonly MaybeRpcAccount[];
    rentByAddress: ReadonlyMap<string, bigint>;
  }>,
): ClaimQuote {
  if (
    input.addresses.length !== input.preAccounts.length ||
    input.addresses.length !== input.postAccounts.length
  ) {
    throw new Error('Claim quote accounts do not align with the message.');
  }
  const payerIndex = input.addresses.indexOf(input.payerAddress);
  if (payerIndex < 0)
    throw new Error('Claim payer is absent from the simulated message.');
  let accountRentLamports = 0n;
  let protocolFeeLamports = 0n;
  for (let index = 0; index < input.addresses.length; index += 1) {
    if (index === payerIndex) continue;
    const before = accountLamports(input.preAccounts[index]);
    const after = accountLamports(input.postAccounts[index]);
    const credit = after > before ? after - before : 0n;
    const configuredRent =
      input.rentByAddress.get(input.addresses[index]) ?? 0n;
    const rent = configuredRent > credit ? credit : configuredRent;
    accountRentLamports += rent;
    protocolFeeLamports += credit - rent;
  }
  const totalLamports =
    input.feeLamports +
    input.priorityFeeLamports +
    accountRentLamports +
    protocolFeeLamports;
  const payerDebit =
    accountLamports(input.preAccounts[payerIndex]) -
    accountLamports(input.postAccounts[payerIndex]);
  const instructionDebit = accountRentLamports + protocolFeeLamports;
  if (payerDebit !== totalLamports && payerDebit !== instructionDebit) {
    throw new Error('Claim simulation payer debit does not reconcile.');
  }
  return {
    totalLamports,
    transactionFeeLamports: input.feeLamports,
    priorityFeeLamports: input.priorityFeeLamports,
    accountRentLamports,
    protocolFeeLamports,
  };
}

type ClaimAddresses = Readonly<{
  proof: string;
  counter: string;
}>;

function claimAddresses(umi: Umi, source: ClaimBuildSource): ClaimAddresses {
  const user = publicKey(source.walletAddress);
  const candyGuard = publicKey(source.candyGuardAddress);
  const candyMachine = publicKey(source.candyMachineAddress);
  return {
    proof: String(
      candy.findAllowListProofPda(umi, {
        merkleRoot: source.merkleRoot,
        user,
        candyGuard,
        candyMachine,
      })[0],
    ),
    counter: String(
      candy.findMintCounterPda(umi, {
        id: 0,
        user,
        candyGuard,
        candyMachine,
      })[0],
    ),
  };
}

function assertGuardAccount(account: MaybeRpcAccount, label: string): void {
  if (account.exists && String(account.owner) !== CANDY_GUARD_PROGRAM_ID) {
    throw new NftOperationPermanentError(
      'NFT_CHAIN_CONFIGURATION_INVALID',
      `${label} has an unexpected owner.`,
    );
  }
}

function buildTransaction(
  umi: Umi,
  source: ClaimBuildSource,
  blockhash: string,
  asset: Signer | undefined,
  priorityMicroLamports = 0n,
  computeUnitLimit = 200_000,
): Promise<Transaction> {
  const payer = createNoopSigner(publicKey(source.walletAddress));
  const priorityItem = {
    instruction: {
      keys: [],
      programId: publicKey('ComputeBudget111111111111111111111111111111'),
      data: Uint8Array.from([
        3,
        ...Array.from({ length: 8 }, (_, index) =>
          Number((priorityMicroLamports >> BigInt(index * 8)) & 0xffn),
        ),
      ]),
    },
    signers: [],
    bytesCreatedOnChain: 0,
  };
  const limitItem = {
    instruction: {
      keys: [],
      programId: publicKey('ComputeBudget111111111111111111111111111111'),
      data: Uint8Array.from([
        2,
        ...[0, 8, 16, 24].map((shift) => (computeUnitLimit >>> shift) & 0xff),
      ]),
    },
    signers: [],
    bytesCreatedOnChain: 0,
  };
  if (source.step === 'ALLOWLIST_PROOF') {
    let builder = candy.route(umi, {
      candyMachine: publicKey(source.candyMachineAddress),
      candyGuard: publicKey(source.candyGuardAddress),
      payer,
      guard: 'allowList',
      routeArgs: {
        path: 'proof',
        merkleRoot: source.merkleRoot,
        merkleProof: [...source.merkleProof],
        minter: payer.publicKey,
      },
      ...(source.claimGroup ? { group: source.claimGroup } : {}),
    });
    // 0 수수료도 명시해 Phantom이 budget 명령을 추가하며 원본 message를 바꾸지 않게 한다.
    builder = builder.prepend([limitItem, priorityItem]);
    return builder
      .setVersion('legacy')
      .setBlockhash(blockhash)
      .buildAndSign(umi);
  }
  if (!asset) throw new Error('Claim mint asset signer is missing.');
  let builder = candy.mintV1(umi, {
    candyMachine: publicKey(source.candyMachineAddress),
    candyGuard: publicKey(source.candyGuardAddress),
    payer,
    minter: payer,
    owner: payer.publicKey,
    asset,
    collection: publicKey(source.collectionAddress),
    mintArgs: {
      allowList: { merkleRoot: source.merkleRoot },
      mintLimit: { id: 0 },
    },
    ...(source.claimGroup ? { group: source.claimGroup } : {}),
  });
  if (
    String(builder.items[0]?.instruction.keys[6]?.pubkey) !==
    source.walletAddress
  )
    throw new Error('Claim mint builder encoded an unexpected initial owner.');
  // Asset 부분 서명을 보존하려면 지갑에 전달하기 전 budget까지 확정해야 한다.
  builder = builder.prepend([limitItem, priorityItem]);
  return builder.setVersion('legacy').setBlockhash(blockhash).buildAndSign(umi);
}

/** 사용자 proof/mint는 SDK local build와 외부 RPC request를 분리해 shared limiter에 하나씩 등록한다. */
@Injectable()
export class SeasonClaimChain extends NftClaimBuildOperationProvider {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly claims: ClaimRepository,
    private readonly nftTransactions: NftTransactionRepository,
    private readonly transport: SeasonNftRpcTransport,
    private readonly transactions: TransactionRunner,
  ) {
    super();
  }

  async next(): Promise<NftRpcJob<void> | null> {
    throw new Error(
      'Production claim build requires request-level scheduling.',
    );
  }

  override async build(
    attemptId: string,
    scheduler: NftRpcScheduler,
  ): Promise<void> {
    const source = await this.claims.findBuildSource(attemptId);
    if (!source || source.state !== 'QUEUED') return;
    if (
      this.config.get('seasonNft.network', { infer: true }) !== source.network
    )
      throw new NftOperationPermanentError(
        'NFT_CHAIN_CONFIGURATION_INVALID',
        'Claim network does not match the worker network.',
      );
    const endpoint =
      this.config.get('seasonNft.rpcUrl', { infer: true }) ??
      'http://127.0.0.1:8899';
    const umi = createUmi(endpoint)
      .use(core.mplCore())
      .use(candy.mplCandyMachine())
      // The wallet signs in the browser later; the server must still build with an explicit zero-signature identity.
      .use(signerIdentity(createNoopSigner(publicKey(source.walletAddress))));
    const addresses = claimAddresses(umi, source);
    const inspected = await scheduler.enqueue({
      kind: 'USER_BUILD',
      rpcType: 'READ',
      run: (signal) =>
        this.transport.getAccounts(
          [addresses.proof, addresses.counter],
          signal,
        ),
    });
    const [proofAccount, counterAccount] = inspected.accounts;
    assertGuardAccount(proofAccount, 'Allow-list proof');
    assertGuardAccount(counterAccount, 'Mint counter');
    if (counterAccount.exists) {
      const counter = candy.deserializeMintCounter(counterAccount);
      if (counter.count >= 1) {
        await withDbOnlyRetry(() =>
          this.transactions.run((transaction) =>
            this.claims.completeClaim(
              {
                claimId: source.claimId,
                attemptId: source.attemptId,
                receiptState: 'RESOLVING',
                ...(source.assetAddress
                  ? { assetAddress: source.assetAddress }
                  : {}),
              },
              transaction,
            ),
          ),
        );
        return;
      }
    }
    if (proofAccount.exists) candy.deserializeAllowListProof(proofAccount);
    if (source.step === 'ALLOWLIST_PROOF' && proofAccount.exists) {
      await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.claims.advanceAttemptToMint(
            { claimId: source.claimId, attemptId: source.attemptId },
            transaction,
          ),
        ),
      );
      return;
    }
    if (source.step === 'MINT' && !proofAccount.exists) {
      throw new NftOperationPermanentError(
        'NFT_CHAIN_CONFIGURATION_INVALID',
        'Expected finalized allow-list proof is absent.',
      );
    }

    const operationKey = `claim:${source.attemptId}:${source.step}`;
    const existing = await this.nftTransactions.findByOperation({
      network: source.network,
      releaseId: source.releaseId,
      operationKey,
    });
    if (existing?.state === 'PREPARED') {
      await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.claims.markAwaitingSignature(
            {
              claimId: source.claimId,
              attemptId: source.attemptId,
              step: source.step,
              ...(existing.assetAddress
                ? { assetAddress: existing.assetAddress }
                : {}),
            },
            transaction,
          ),
        ),
      );
      return;
    }

    const checkpoint = await scheduler.enqueue({
      kind: 'USER_BUILD',
      rpcType: 'READ',
      run: (signal) => this.transport.getLatestBlockhash(signal),
    });
    const asset = source.step === 'MINT' ? generateSigner(umi) : undefined;
    let transaction = await buildTransaction(
      umi,
      source,
      checkpoint.blockhash,
      asset,
    );
    if (
      transaction.message.version !== 'legacy' ||
      String(transaction.message.accounts[0]) !== source.walletAddress
    ) {
      throw new Error('Claim transaction payer or version is invalid.');
    }
    let serialized = Buffer.from(umi.transactions.serialize(transaction));
    let message = Buffer.from(transaction.serializedMessage);
    const baseFeeLamports = await scheduler.enqueue({
      kind: 'USER_BUILD',
      rpcType: 'READ',
      run: (signal) => this.transport.getFeeForMessage(message, signal),
    });
    let messageAddresses = transaction.message.accounts.map(String);
    let pre = await scheduler.enqueue({
      kind: 'USER_BUILD',
      rpcType: 'READ',
      run: (signal) => this.transport.getAccounts(messageAddresses, signal),
    });
    let simulation = await scheduler.enqueue({
      kind: 'USER_BUILD',
      rpcType: 'READ',
      run: (signal) =>
        this.transport.simulateTransaction(
          serialized,
          messageAddresses,
          signal,
        ),
    });
    const assertSimulation = (): void => {
      if (simulation.error === null) {
        if (!simulation.accounts)
          throw new Error('Claim simulation account readback is unavailable.');
        return;
      }
      const detail = JSON.stringify({
        error: simulation.error,
        logs: simulation.logs,
      });
      if (
        /insufficient(?:funds|lamports)|InsufficientFundsFor(?:Fee|Rent)/iu.test(
          detail,
        )
      ) {
        throw new NftOperationPermanentError(
          'NFT_INSUFFICIENT_FUNDS',
          'The participant wallet cannot fund the claim transaction.',
        );
      }
      if (/InstructionError|custom program error/iu.test(detail))
        throw new NftOperationPermanentError(
          'NFT_CHAIN_CONFIGURATION_INVALID',
          'Claim transaction simulation rejected the frozen transaction.',
        );
      throw new Error('Claim transaction simulation is not conclusive.');
    };
    assertSimulation();
    let feeLamports = baseFeeLamports;
    let priorityFeeLamports = 0n;
    const priorityCap =
      this.config.get('seasonNft.priorityFeeMaxLamports', { infer: true }) ??
      0n;
    if (priorityCap > 0n) {
      if (!simulation.unitsConsumed)
        throw new Error('Claim simulation compute usage is unavailable.');
      const estimatedMicroLamports = await scheduler.enqueue({
        kind: 'USER_BUILD',
        rpcType: 'READ',
        run: (signal) =>
          this.transport.getPriorityFeeEstimate(messageAddresses, signal),
      });
      const priority = selectClaimPriorityFee({
        estimatedMicroLamports,
        consumedUnits: simulation.unitsConsumed,
        capLamports: priorityCap,
      });
      if (priority.quotedLamports > 0n) {
        transaction = await buildTransaction(
          umi,
          source,
          checkpoint.blockhash,
          asset,
          priority.microLamports,
          priority.computeUnitLimit,
        );
        serialized = Buffer.from(umi.transactions.serialize(transaction));
        message = Buffer.from(transaction.serializedMessage);
        messageAddresses = transaction.message.accounts.map(String);
        feeLamports = await scheduler.enqueue({
          kind: 'USER_BUILD',
          rpcType: 'READ',
          run: (signal) => this.transport.getFeeForMessage(message, signal),
        });
        priorityFeeLamports =
          feeLamports > baseFeeLamports ? feeLamports - baseFeeLamports : 0n;
        if (priorityFeeLamports > priorityCap)
          throw new Error('Claim priority fee exceeds its configured cap.');
        pre = await scheduler.enqueue({
          kind: 'USER_BUILD',
          rpcType: 'READ',
          run: (signal) => this.transport.getAccounts(messageAddresses, signal),
        });
        simulation = await scheduler.enqueue({
          kind: 'USER_BUILD',
          rpcType: 'READ',
          run: (signal) =>
            this.transport.simulateTransaction(
              serialized,
              messageAddresses,
              signal,
            ),
        });
        assertSimulation();
      }
    }
    if (serialized.length === 0 || serialized.length > 1232)
      throw new NftOperationPermanentError(
        'NFT_CHAIN_CONFIGURATION_INVALID',
        'Claim transaction exceeds the legacy packet limit.',
      );
    const postAccounts = simulation.accounts;
    if (!postAccounts)
      throw new Error('Claim simulation account readback is unavailable.');
    const rentTargets =
      source.step === 'ALLOWLIST_PROOF'
        ? [addresses.proof]
        : [String(asset!.publicKey), addresses.counter];
    const rentByAddress = new Map<string, bigint>();
    for (const address of rentTargets) {
      const index = messageAddresses.indexOf(address);
      const simulatedAccount = postAccounts[index];
      if (index < 0 || !simulatedAccount?.exists)
        throw new Error('Claim simulation omitted a created account.');
      const rent = await scheduler.enqueue({
        kind: 'USER_BUILD',
        rpcType: 'READ',
        run: (signal) =>
          this.transport.getRent(simulatedAccount.data.length, signal),
      });
      rentByAddress.set(address, rent);
    }
    const quote = deriveClaimQuote({
      feeLamports: feeLamports - priorityFeeLamports,
      priorityFeeLamports,
      payerAddress: source.walletAddress,
      addresses: messageAddresses,
      preAccounts: pre.accounts,
      postAccounts,
      rentByAddress,
    });
    const payer = pre.accounts[messageAddresses.indexOf(source.walletAddress)];
    if (accountLamports(payer) < quote.totalLamports)
      throw new NftOperationPermanentError(
        'NFT_INSUFFICIENT_FUNDS',
        'The participant wallet cannot fund the claim transaction.',
      );
    await withDbOnlyRetry(() =>
      this.transactions.run(async (databaseTransaction) => {
        const prepared = await this.nftTransactions.insertPrepared(
          {
            network: source.network,
            releaseId: source.releaseId,
            attemptId: source.attemptId,
            operationKey,
            kind:
              source.step === 'ALLOWLIST_PROOF' ? 'USER_PROOF' : 'USER_MINT',
            messageHash: createHash('sha256').update(message).digest('hex'),
            serializedTransaction: serialized,
            recentBlockhash: checkpoint.blockhash,
            lastValidBlockHeight: checkpoint.lastValidBlockHeight,
            ...(asset ? { assetAddress: String(asset.publicKey) } : {}),
            estimatedCostLamports: quote.totalLamports,
            estimatedAt: new Date(),
            costBreakdown: {
              transactionFeeLamports: quote.transactionFeeLamports.toString(),
              priorityFeeLamports: quote.priorityFeeLamports.toString(),
              accountRentLamports: quote.accountRentLamports.toString(),
              protocolFeeLamports: quote.protocolFeeLamports.toString(),
            },
          },
          databaseTransaction,
        );
        if (prepared.state !== 'PREPARED') return;
        await this.claims.markAwaitingSignature(
          {
            claimId: source.claimId,
            attemptId: source.attemptId,
            step: source.step,
            ...(asset ? { assetAddress: String(asset.publicKey) } : {}),
          },
          databaseTransaction,
        );
      }),
    );
  }
}

/** dispatcher용 USER_* effect reader는 한 호출에서 PDA account batch 하나만 읽는다. */
@Injectable()
export class SeasonClaimEffectInspector extends NftClaimEffectRpc {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly claims: ClaimRepository,
    private readonly transport: SeasonNftRpcTransport,
  ) {
    super();
  }

  async inspect(
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ): Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'accountEvidence' | 'reconciliationEvidence'
    >[]
  > {
    const sources = await this.claims.findReconciliationSources(
      transactions.map(({ id }) => id),
    );
    const byId = new Map(
      sources.map((source) => [source.transactionId, source]),
    );
    const endpoint =
      this.config.get('seasonNft.rpcUrl', { infer: true }) ??
      'http://127.0.0.1:8899';
    const umi = createUmi(endpoint).use(candy.mplCandyMachine());
    const identities = transactions.map((transaction) => {
      const source = byId.get(transaction.id);
      if (!source) return null;
      const user = publicKey(source.walletAddress);
      const candyGuard = publicKey(source.candyGuardAddress);
      const candyMachine = publicKey(source.candyMachineAddress);
      const effectAddress =
        source.kind === 'USER_PROOF'
          ? String(
              candy.findAllowListProofPda(umi, {
                merkleRoot: source.merkleRoot,
                user,
                candyGuard,
                candyMachine,
              })[0],
            )
          : String(
              candy.findMintCounterPda(umi, {
                id: 0,
                user,
                candyGuard,
                candyMachine,
              })[0],
            );
      const addresses = [effectAddress];
      if (source.kind === 'USER_MINT' && source.assetAddress)
        addresses.push(source.assetAddress);
      return { transaction, source, addresses };
    });
    const readable = identities.filter(
      (value): value is NonNullable<typeof value> => value !== null,
    );
    if (readable.length === 0) {
      return transactions.map(({ id }) => ({
        transactionId: id,
        accountEvidence: 'UNKNOWN' as const,
      }));
    }
    const requested = readable.flatMap(({ addresses }) => addresses);
    const response = await this.transport.getAccounts(requested, signal);
    let offset = 0;
    const accountsByTransaction = new Map<string, readonly MaybeRpcAccount[]>();
    for (const identity of readable) {
      accountsByTransaction.set(
        identity.transaction.id,
        response.accounts.slice(offset, offset + identity.addresses.length),
      );
      offset += identity.addresses.length;
    }
    return transactions.map((transaction) => {
      const identity = identities.find(
        (item) => item?.transaction.id === transaction.id,
      );
      const accounts = accountsByTransaction.get(transaction.id);
      if (
        !identity ||
        !accounts ||
        accounts.length !== identity.addresses.length
      )
        return { transactionId: transaction.id, accountEvidence: 'UNKNOWN' };
      const effect = accounts[0];
      if (!effect.exists) {
        const asset = accounts[1];
        return {
          transactionId: transaction.id,
          accountEvidence:
            identity.source.kind === 'USER_MINT' && asset?.exists
              ? 'UNKNOWN'
              : identity.source.kind === 'USER_MINT' &&
                  !identity.source.assetAddress
                ? 'UNKNOWN'
                : 'ABSENT',
        };
      }
      if (String(effect.owner) !== CANDY_GUARD_PROGRAM_ID)
        return { transactionId: transaction.id, accountEvidence: 'UNKNOWN' };
      let success: boolean;
      try {
        success =
          identity.source.kind === 'USER_PROOF'
            ? Boolean(candy.deserializeAllowListProof(effect))
            : candy.deserializeMintCounter(effect).count >= 1;
      } catch {
        return { transactionId: transaction.id, accountEvidence: 'UNKNOWN' };
      }
      if (!success && identity.source.kind === 'USER_MINT') {
        const asset = accounts[1];
        if (!identity.source.assetAddress || asset?.exists)
          return { transactionId: transaction.id, accountEvidence: 'UNKNOWN' };
      }
      return {
        transactionId: transaction.id,
        accountEvidence: success ? ('SUCCESS' as const) : ('ABSENT' as const),
        ...(success
          ? {
              reconciliationEvidence: {
                operationKey: transaction.operationKey,
                finalizedSlot: response.slot.toString(),
                observedAt: new Date().toISOString(),
              },
            }
          : {}),
      };
    });
  }
}

/** receipt adapter exists separately so runtime can preserve receipt work without a live attempt. */
@Injectable()
export class SeasonClaimReceiptLookup extends NftClaimReceiptLookup {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly claims: ClaimRepository,
    private readonly transport: SeasonNftRpcTransport,
  ) {
    super();
  }

  async lookup(): Promise<never> {
    throw new Error(
      'Production receipt lookup requires request-level scheduling.',
    );
  }

  override async resolve(
    claimId: string,
    scheduler: NftRpcScheduler,
  ): Promise<ReceiptLookupResult> {
    const source = await this.claims.findReceiptSource(claimId);
    if (!source) return { status: 'PENDING' };
    if (
      this.config.get('seasonNft.network', { infer: true }) !== source.network
    )
      throw new Error(
        'Claim receipt network does not match the worker network.',
      );
    const endpoint =
      this.config.get('seasonNft.rpcUrl', { infer: true }) ??
      'http://127.0.0.1:8899';
    const umi = createUmi(endpoint)
      .use(core.mplCore())
      .use(candy.mplCandyMachine());
    const counterAddress = String(
      candy.findMintCounterPda(umi, {
        id: 0,
        user: publicKey(source.walletAddress),
        candyGuard: publicKey(source.candyGuardAddress),
        candyMachine: publicKey(source.candyMachineAddress),
      })[0],
    );
    const seen = new Set<string>();
    const verifySignature = async (
      signature: string,
    ): Promise<ReceiptLookupResult | 'MISMATCH' | 'UNKNOWN'> => {
      if (seen.has(signature)) return 'MISMATCH';
      seen.add(signature);
      const transaction = await scheduler.enqueue({
        kind: 'USER_CHECK',
        rpcType: 'READ',
        run: (signal) => this.transport.getTransaction(signature, signal),
      });
      if (!transaction) return 'UNKNOWN';
      if (transaction.error !== null) return 'MISMATCH';
      let assetAddress: string | null = null;
      for (const instruction of transaction.instructions) {
        if (
          transaction.accountKeys[instruction.programIdIndex] !==
            CANDY_GUARD_PROGRAM_ID ||
          instruction.accountIndexes.length < 15
        )
          continue;
        const accounts = instruction.accountIndexes.map(
          (index) => transaction.accountKeys[index],
        );
        const possibleAsset = accounts[7];
        if (
          accounts[0] !== source.candyGuardAddress ||
          accounts[2] !== source.candyMachineAddress ||
          accounts[4] !== source.walletAddress ||
          accounts[5] !== source.walletAddress ||
          accounts[6] !== source.walletAddress ||
          accounts[8] !== source.collectionAddress ||
          accounts[9] !== CORE_PROGRAM_ID ||
          accounts[14] !== counterAddress ||
          !possibleAsset
        )
          continue;
        const payer = createNoopSigner(publicKey(source.walletAddress));
        const expectedData = candy.mintV1(umi, {
          candyMachine: publicKey(source.candyMachineAddress),
          candyGuard: publicKey(source.candyGuardAddress),
          payer,
          minter: payer,
          owner: payer.publicKey,
          asset: createNoopSigner(publicKey(possibleAsset)),
          collection: publicKey(source.collectionAddress),
          mintArgs: {
            allowList: { merkleRoot: source.merkleRoot },
            mintLimit: { id: 0 },
          },
          ...(source.claimGroup ? { group: source.claimGroup } : {}),
        }).items[0]?.instruction.data;
        if (
          expectedData &&
          Buffer.from(expectedData).equals(Buffer.from(instruction.data))
        ) {
          assetAddress = possibleAsset;
          break;
        }
      }
      if (!assetAddress) return 'MISMATCH';
      if (transaction.blockTime === null) return 'UNKNOWN';
      const readback = await scheduler.enqueue({
        kind: 'USER_CHECK',
        rpcType: 'READ',
        run: (signal) =>
          this.transport.getAccounts(
            [source.candyMachineAddress, assetAddress],
            signal,
          ),
      });
      const [machineAccount, assetAccount] = readback.accounts;
      if (!machineAccount.exists || !assetAccount.exists) return 'UNKNOWN';
      const machine = candy.deserializeCandyMachine(machineAccount);
      if (
        !isSome(machine.data.hiddenSettings) ||
        machine.data.hiddenSettings.value.name !== source.assetName ||
        machine.data.hiddenSettings.value.uri !== source.metadataUri ||
        String(machine.collectionMint) !== source.collectionAddress
      ) {
        return 'MISMATCH';
      }
      if (assetAccount.exists) {
        if (String(assetAccount.owner) !== CORE_PROGRAM_ID) return 'MISMATCH';
        if (assetAccount.data.length === 1 && assetAccount.data[0] === 0) {
          // Core burn tombstone preserves the historical mint receipt identity.
        } else {
          const asset = core.deserializeAssetV1(assetAccount);
          if (
            asset.name !== source.assetName ||
            asset.uri !== source.metadataUri ||
            asset.updateAuthority.type !== 'Collection' ||
            String(asset.updateAuthority.address) !== source.collectionAddress
          ) {
            return 'MISMATCH';
          }
        }
      }
      return {
        status: 'VERIFIED',
        assetAddress,
        mintSignature: signature,
        claimedAt: new Date(transaction.blockTime * 1000),
      };
    };

    // 저장된 signature는 history 장애와 무관한 authoritative 경로이므로 먼저 검증한다.
    if (source.knownMintSignature) {
      const verified = await verifySignature(source.knownMintSignature);
      if (typeof verified !== 'string') return verified;
      if (verified === 'UNKNOWN') return { status: 'PENDING' };
    }
    const durableBefore = source.receiptHistoryBefore ?? undefined;
    let remainingPages = 10;
    /** 한 history page를 검증하고 UNKNOWN이면 durable cursor를 유지한다. */
    const scanPage = async (before?: string) => {
      const found = await scheduler.enqueue({
        kind: 'USER_CHECK',
        rpcType: 'READ',
        run: (signal) =>
          this.transport.getSignaturesForAddress(
            counterAddress,
            signal,
            before,
          ),
      });
      for (const candidate of found) {
        if (
          candidate.error !== null ||
          candidate.confirmationStatus !== 'finalized'
        )
          continue;
        const verified = await verifySignature(candidate.signature);
        if (typeof verified !== 'string') return { result: verified, found };
        if (verified === 'UNKNOWN') {
          return {
            result: {
              status: 'PENDING' as const,
              historyBefore: source.receiptHistoryBefore ?? null,
            },
            found,
          };
        }
      }
      return { found };
    };

    // 저장된 backlog cursor가 있어도 매 retry의 첫 page는 새로 색인된 최신 mint를 확인한다.
    if (durableBefore) {
      const latest = await scanPage();
      remainingPages -= 1;
      if (latest.result) return latest.result;
    }

    let before = durableBefore;
    // 남은 budget은 durable cursor부터 이어 읽고 마지막 signature만 다음 retry에 넘긴다.
    while (remainingPages > 0) {
      const scanned = await scanPage(before);
      remainingPages -= 1;
      if (scanned.result) return scanned.result;
      if (scanned.found.length < 100)
        return { status: 'PENDING', historyBefore: null };
      before = scanned.found.at(-1)?.signature;
      if (!before) return { status: 'PENDING', historyBefore: null };
    }
    return { status: 'PENDING', historyBefore: before ?? null };
  }
}
