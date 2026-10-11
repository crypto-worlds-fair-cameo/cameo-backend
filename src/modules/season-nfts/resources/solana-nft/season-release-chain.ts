import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import bs58 from 'bs58';
import {
  createSignerFromKeypair,
  dateTime,
  isNone,
  isSome,
  lamports,
  none,
  publicKey,
  signerIdentity,
  some,
  type MaybeRpcAccount,
  type Option,
  type Pda,
  type PublicKey,
  type Signer,
  type TransactionBuilder,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import * as core from '@metaplex-foundation/mpl-core';
import * as candy from '@metaplex-foundation/mpl-core-candy-machine';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type { AllConfigType } from '../../../../config/config.type';
import {
  setupOperationKey,
  type SeasonNftNetwork,
} from '../season-nft/season-nft';
import {
  NftOperationPermanentError,
  NftOperationRetryError,
  NftReleaseChainOperationProvider,
} from '../nft-worker/nft-runtime-queue';
import { withDbOnlyRetry } from '../nft-worker/db-only-retry';
import { NftRpcScheduler } from '../nft-worker/rpc-scheduler';
import type { NftRpcJob } from '../nft-worker/rpc-scheduler';
import {
  NftChainRpc,
  NftClaimEffectRpc,
  type DispatchableNftTransaction,
  type NftTransactionInspection,
} from './nft-transaction-dispatcher';
import { NftTransactionRepository } from './nft-transaction.repository';
import {
  PreparationKeyStore,
  PreparationKeyStoreError,
} from './preparation-key-store';
import {
  SeasonNftRepository,
  type SeasonNftChainSource,
} from '../season-nft/season-nft.repository';

export const EXPECTED_GENESIS_HASHES: Readonly<
  Record<SeasonNftNetwork, string>
> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export type LockVerification = Readonly<{
  finalized: boolean;
  metadataMatches: boolean;
  rootMatches: boolean;
  supplyMatches: boolean;
  managementLocked: boolean;
  mintDelegatePreserved: boolean;
}>;

/** Claims open only after every frozen field and authority predicate passes finalized readback. */
export function canOpenClaims(verification: LockVerification): boolean {
  return (
    verification.finalized &&
    verification.metadataMatches &&
    verification.rootMatches &&
    verification.supplyMatches &&
    verification.managementLocked &&
    verification.mintDelegatePreserved
  );
}

export type MintDelegateReadback = Readonly<{
  machineMintAuthority: string;
  candyGuardAddress: string;
  machineCollection: string;
  collectionAddress: string;
  collectionDelegatePlugins: readonly string[];
  collectionMintDelegateMatches: boolean;
}>;

/** Guard 경유 발행과 정확한 Machine PDA의 collection 발행 권한을 함께 검증한다. */
export function mintDelegatePreserved(readback: MintDelegateReadback): boolean {
  return (
    readback.machineMintAuthority === readback.candyGuardAddress &&
    readback.machineCollection === readback.collectionAddress &&
    readback.collectionDelegatePlugins.length === 1 &&
    readback.collectionDelegatePlugins[0] === 'updateDelegate' &&
    readback.collectionMintDelegateMatches
  );
}

export const CLAIM_BLOCK_START_DATE = 9223372036854775807n;

export async function buildMachineAndGuard(
  input: Readonly<{
    umi: Umi;
    service: Signer;
    collection: PublicKey;
    machine: Signer;
    name: string;
    metadataUri: string;
    eligibleCount: number;
    merkleRoot: Uint8Array;
    rentLamports: bigint;
  }>,
): Promise<TransactionBuilder> {
  // createCandyMachine normally fetches rent internally; inject the separately scheduled quote.
  const context = Object.assign(Object.create(input.umi), input.umi, {
    rpc: Object.assign(Object.create(input.umi.rpc), input.umi.rpc, {
      getRent: async () => lamports(input.rentLamports),
    }),
  }) as Umi;
  return candy.create(context, {
    candyMachine: input.machine,
    collection: input.collection,
    collectionUpdateAuthority: input.service,
    payer: input.service,
    authority: input.service.publicKey,
    itemsAvailable: input.eligibleCount,
    maxEditionSupply: 0,
    isMutable: false,
    hiddenSettings: some({
      name: input.name,
      uri: input.metadataUri,
      hash: new Uint8Array(32),
    }),
    configLineSettings: none(),
    guards: {
      allowList: some({ merkleRoot: input.merkleRoot }),
      mintLimit: some({ id: 0, limit: 1 }),
      startDate: some({ date: dateTime(CLAIM_BLOCK_START_DATE) }),
    },
    groups: [],
  });
}

/** ImmutableMetadata가 authority 이전도 막으므로 제거와 영구 권한 잠금을 한 거래로 수행한다. */
export function buildCollectionAuthorityLock(
  input: Readonly<{
    umi: Umi;
    authority: Signer;
    collection: PublicKey;
    lockAuthority: PublicKey;
  }>,
): TransactionBuilder {
  return core
    .removeCollectionPlugin(input.umi, {
      collection: input.collection,
      payer: input.authority,
      authority: input.authority,
      plugin: { type: 'ImmutableMetadata' },
    })
    .add(
      core.updateCollectionV1(input.umi, {
        collection: input.collection,
        payer: input.authority,
        authority: input.authority,
        newUpdateAuthority: input.lockAuthority,
        newName: none(),
        newUri: none(),
      }),
    );
}

/** Opening claims and permanently locking Guard management remain one Solana transaction. */
export function buildFinalGuardLock(
  input: Readonly<{
    umi: Umi;
    authority: Signer;
    candyGuard: PublicKey | Pda;
    lockAuthority: PublicKey;
    merkleRoot: Uint8Array;
  }>,
): TransactionBuilder {
  return candy
    .updateCandyGuard(input.umi, {
      candyGuard: input.candyGuard,
      authority: input.authority,
      guards: {
        allowList: { merkleRoot: input.merkleRoot },
        mintLimit: { id: 0, limit: 1 },
        startDate: null,
      },
      groups: [],
    })
    .add(
      candy.setCandyGuardAuthority(input.umi, {
        candyGuard: input.candyGuard,
        authority: input.authority,
        newAuthority: input.lockAuthority,
      }),
    );
}

export abstract class SeasonNftRpcTransport {
  /** One call performs exactly one JSON-RPC request; callers schedule each invocation independently. */
  abstract getGenesisHash(signal: AbortSignal): Promise<string>;
  abstract getLatestBlockhash(signal: AbortSignal): Promise<
    Readonly<{
      blockhash: string;
      lastValidBlockHeight: bigint;
    }>
  >;
  abstract getRent(space: number, signal: AbortSignal): Promise<bigint>;
  abstract getFeeForMessage(
    serializedMessage: Buffer,
    signal: AbortSignal,
  ): Promise<bigint>;
  abstract getPriorityFeeEstimate(
    addresses: readonly string[],
    signal: AbortSignal,
  ): Promise<bigint>;
  abstract simulateTransaction(
    bytes: Buffer,
    addresses: readonly string[],
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      error: unknown;
      accounts: readonly MaybeRpcAccount[] | null;
      unitsConsumed: bigint | null;
      logs: readonly string[];
    }>
  >;
  abstract getAccounts(
    addresses: readonly string[],
    signal: AbortSignal,
  ): Promise<Readonly<{ slot: bigint; accounts: readonly MaybeRpcAccount[] }>>;
  abstract sendTransaction(bytes: Buffer, signal: AbortSignal): Promise<string>;
  abstract getSignatureStatuses(
    signatures: readonly string[],
    signal: AbortSignal,
  ): Promise<
    readonly Readonly<{
      confirmationStatus: string | null;
      error: unknown;
    } | null>[]
  >;
  abstract getFinalizedBlockHeight(signal: AbortSignal): Promise<bigint>;
  abstract getSignaturesForAddress(
    address: string,
    signal: AbortSignal,
    before?: string,
  ): Promise<
    readonly Readonly<{
      signature: string;
      blockTime: number | null;
      error: unknown;
      confirmationStatus: string | null;
    }>[]
  >;
  abstract getTransaction(
    signature: string,
    signal: AbortSignal,
  ): Promise<Readonly<{
    blockTime: number | null;
    error: unknown;
    accountKeys: readonly string[];
    instructions: readonly Readonly<{
      programIdIndex: number;
      accountIndexes: readonly number[];
      data: Uint8Array;
    }>[];
  }> | null>;
}

export const SEASON_NFT_RPC_FETCH = Symbol('SEASON_NFT_RPC_FETCH');

type JsonRpcResponse<T> = Readonly<{
  result?: T;
  error?: Readonly<{ code?: number; message?: string; data?: unknown }>;
}>;

/** HTTP transport owns one-request JSON-RPC calls and never retries outside the shared scheduler. */
@Injectable()
export class SolanaJsonRpcTransport extends SeasonNftRpcTransport {
  private requestId = 0;

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    @Inject(SEASON_NFT_RPC_FETCH)
    private readonly fetcher: typeof globalThis.fetch,
  ) {
    super();
  }

  async getGenesisHash(signal: AbortSignal): Promise<string> {
    return this.call<string>('getGenesisHash', [], signal);
  }

  async getLatestBlockhash(signal: AbortSignal): Promise<
    Readonly<{
      blockhash: string;
      lastValidBlockHeight: bigint;
    }>
  > {
    const result = await this.call<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'finalized' }], signal);
    return {
      blockhash: result.value.blockhash,
      lastValidBlockHeight: BigInt(result.value.lastValidBlockHeight),
    };
  }

  async getRent(space: number, signal: AbortSignal): Promise<bigint> {
    const result = await this.call<number>(
      'getMinimumBalanceForRentExemption',
      [space, { commitment: 'finalized' }],
      signal,
    );
    return BigInt(result);
  }

  async getFeeForMessage(
    serializedMessage: Buffer,
    signal: AbortSignal,
  ): Promise<bigint> {
    const result = await this.call<{ value: number | null }>(
      'getFeeForMessage',
      [serializedMessage.toString('base64'), { commitment: 'confirmed' }],
      signal,
    );
    if (result.value === null)
      throw new Error('Season NFT RPC returned no transaction fee quote.');
    return BigInt(result.value);
  }

  async getPriorityFeeEstimate(
    addresses: readonly string[],
    signal: AbortSignal,
  ): Promise<bigint> {
    const result = await this.call<readonly { prioritizationFee: number }[]>(
      'getRecentPrioritizationFees',
      [addresses],
      signal,
    );
    const samples = result
      .map(({ prioritizationFee }) => BigInt(prioritizationFee))
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return samples.length === 0 ? 0n : samples[Math.floor(samples.length / 2)];
  }

  async simulateTransaction(
    bytes: Buffer,
    addresses: readonly string[],
    signal: AbortSignal,
  ): Promise<
    Readonly<{
      error: unknown;
      accounts: readonly MaybeRpcAccount[] | null;
      unitsConsumed: bigint | null;
      logs: readonly string[];
    }>
  > {
    const result = await this.call<{
      value: {
        err: unknown;
        accounts:
          | readonly ({
              data: readonly [string, string];
              executable: boolean;
              lamports: number;
              owner: string;
              rentEpoch: number;
            } | null)[]
          | null;
        unitsConsumed?: number | null;
        logs?: readonly string[] | null;
      };
    }>(
      'simulateTransaction',
      [
        bytes.toString('base64'),
        {
          encoding: 'base64',
          commitment: 'confirmed',
          sigVerify: false,
          replaceRecentBlockhash: false,
          accounts: { encoding: 'base64', addresses },
        },
      ],
      signal,
    );
    return {
      error: result.value.err,
      unitsConsumed:
        result.value.unitsConsumed === null ||
        result.value.unitsConsumed === undefined
          ? null
          : BigInt(result.value.unitsConsumed),
      logs: result.value.logs ?? [],
      accounts:
        result.value.accounts === null
          ? null
          : result.value.accounts.length !== addresses.length
            ? null
            : result.value.accounts.map((account, index): MaybeRpcAccount =>
                account === null
                  ? {
                      exists: false,
                      publicKey: publicKey(addresses[index]),
                    }
                  : {
                      exists: true,
                      publicKey: publicKey(addresses[index]),
                      data: Uint8Array.from(
                        Buffer.from(account.data[0], 'base64'),
                      ),
                      executable: account.executable,
                      owner: publicKey(account.owner),
                      lamports: lamports(BigInt(account.lamports)),
                      rentEpoch: account.rentEpoch,
                    },
              ),
    };
  }

  async getAccounts(
    addresses: readonly string[],
    signal: AbortSignal,
  ): Promise<Readonly<{ slot: bigint; accounts: readonly MaybeRpcAccount[] }>> {
    const result = await this.call<{
      context: { slot: number };
      value: readonly ({
        data: readonly [string, string];
        executable: boolean;
        lamports: number;
        owner: string;
        rentEpoch: number;
      } | null)[];
    }>(
      'getMultipleAccounts',
      [addresses, { commitment: 'finalized', encoding: 'base64' }],
      signal,
    );
    if (result.value.length !== addresses.length) {
      throw new Error('Season NFT RPC returned an incomplete account batch.');
    }
    return {
      slot: BigInt(result.context.slot),
      accounts: result.value.map((account, index): MaybeRpcAccount =>
        account === null
          ? { exists: false, publicKey: publicKey(addresses[index]) }
          : {
              exists: true,
              publicKey: publicKey(addresses[index]),
              data: Uint8Array.from(Buffer.from(account.data[0], 'base64')),
              executable: account.executable,
              owner: publicKey(account.owner),
              lamports: lamports(BigInt(account.lamports)),
              rentEpoch: account.rentEpoch,
            },
      ),
    };
  }

  async sendTransaction(bytes: Buffer, signal: AbortSignal): Promise<string> {
    return this.call<string>(
      'sendTransaction',
      [bytes.toString('base64'), { encoding: 'base64', skipPreflight: false }],
      signal,
    );
  }

  async getSignatureStatuses(
    signatures: readonly string[],
    signal: AbortSignal,
  ): Promise<
    readonly Readonly<{
      confirmationStatus: string | null;
      error: unknown;
    } | null>[]
  > {
    const result = await this.call<{
      value: readonly ({
        confirmationStatus?: string | null;
        err?: unknown;
      } | null)[];
    }>(
      'getSignatureStatuses',
      [signatures, { searchTransactionHistory: true }],
      signal,
    );
    return result.value.map((status) =>
      status === null
        ? null
        : {
            confirmationStatus: status.confirmationStatus ?? null,
            error: status.err ?? null,
          },
    );
  }

  async getFinalizedBlockHeight(signal: AbortSignal): Promise<bigint> {
    return BigInt(
      await this.call<number>(
        'getBlockHeight',
        [{ commitment: 'finalized' }],
        signal,
      ),
    );
  }

  async getSignaturesForAddress(
    address: string,
    signal: AbortSignal,
    before?: string,
  ): Promise<
    readonly Readonly<{
      signature: string;
      blockTime: number | null;
      error: unknown;
      confirmationStatus: string | null;
    }>[]
  > {
    const result = await this.call<
      readonly {
        signature: string;
        blockTime: number | null;
        err: unknown;
        confirmationStatus?: string | null;
      }[]
    >(
      'getSignaturesForAddress',
      [
        address,
        {
          commitment: 'finalized',
          limit: 100,
          ...(before ? { before } : {}),
        },
      ],
      signal,
    );
    return result.map((item) => ({
      signature: item.signature,
      blockTime: item.blockTime,
      error: item.err,
      confirmationStatus: item.confirmationStatus ?? null,
    }));
  }

  async getTransaction(
    signature: string,
    signal: AbortSignal,
  ): Promise<Readonly<{
    blockTime: number | null;
    error: unknown;
    accountKeys: readonly string[];
    instructions: readonly Readonly<{
      programIdIndex: number;
      accountIndexes: readonly number[];
      data: Uint8Array;
    }>[];
  }> | null> {
    const result = await this.call<{
      blockTime: number | null;
      meta: { err: unknown } | null;
      transaction: {
        message: {
          accountKeys: readonly string[];
          instructions: readonly {
            programIdIndex: number;
            accounts: readonly number[];
            data: string;
          }[];
        };
      };
    } | null>(
      'getTransaction',
      [
        signature,
        {
          commitment: 'finalized',
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        },
      ],
      signal,
    );
    if (!result || result.meta === null) return null;
    return {
      blockTime: result.blockTime,
      error: result.meta?.err ?? null,
      accountKeys: result.transaction.message.accountKeys,
      instructions: result.transaction.message.instructions.map(
        (instruction) => ({
          programIdIndex: instruction.programIdIndex,
          accountIndexes: instruction.accounts,
          data: Uint8Array.from(bs58.decode(instruction.data)),
        }),
      ),
    };
  }

  /** Sends one method call with no SDK retry so scheduler accounting remains exact. */
  protected async call<T>(
    method: string,
    params: readonly unknown[],
    signal: AbortSignal,
  ): Promise<T> {
    const endpoint = this.config.get('seasonNft.rpcUrl', { infer: true });
    if (!endpoint) throw new Error('Season NFT RPC endpoint is unavailable.');
    const response = await this.fetcher(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.requestId,
        method,
        params,
      }),
      signal,
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
        const dateDelay =
          retryAfter === null
            ? Number.NaN
            : Date.parse(retryAfter) - Date.now();
        const retryAfterMs =
          Number.isFinite(seconds) && seconds >= 0
            ? seconds * 1000
            : Number.isFinite(dateDelay)
              ? Math.max(0, dateDelay)
              : undefined;
        throw new NftOperationRetryError(
          `Season NFT RPC request failed with HTTP ${response.status}.`,
          {
            reason: 'RATE_LIMITED',
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          },
        );
      }
      throw new Error(
        `Season NFT RPC request failed with HTTP ${response.status}.`,
      );
    }
    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.error) {
      if (
        /insufficient funds|insufficient lamports|account not found/iu.test(
          payload.error.message ?? '',
        )
      ) {
        throw new NftOperationRetryError(
          `Season NFT RPC ${method} reported insufficient service balance.`,
          { reason: 'SERVICE_BALANCE', retryAfterMs: 300_000 },
        );
      }
      throw new Error(
        `Season NFT RPC ${method} failed with code ${payload.error.code ?? 'unknown'}.`,
      );
    }
    if (!('result' in payload)) {
      throw new Error(`Season NFT RPC ${method} returned no result.`);
    }
    return payload.result as T;
  }
}

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const CORE_PROGRAM_ID = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const CANDY_MACHINE_PROGRAM_ID = 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J';
const CANDY_GUARD_PROGRAM_ID = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
const DELEGATE_PLUGIN_KEYS = [
  'updateDelegate',
  'transferDelegate',
  'burnDelegate',
  'freezeDelegate',
  'permanentTransferDelegate',
  'permanentBurnDelegate',
  'permanentFreezeDelegate',
] as const;
const COLLECTION_PLUGIN_KEYS = [
  'attributes',
  'groups',
  'royalties',
  'updateDelegate',
  'permanentFreezeDelegate',
  'permanentTransferDelegate',
  'permanentBurnDelegate',
  'addBlocker',
  'autograph',
  'verifiedCreators',
  'freezeExecute',
  'permanentFreezeExecute',
  'masterEdition',
  'bubblegumV2',
] as const;
const EXTERNAL_PLUGIN_ADAPTER_KEYS = [
  'lifecycleHooks',
  'oracles',
  'appDatas',
  'linkedLifecycleHooks',
  'linkedAppDatas',
  'dataSections',
  'agentIdentities',
] as const;
const RELEASE_GUARD_NAMES = new Set(['allowList', 'mintLimit', 'startDate']);

type ReleaseUmi = Readonly<{ umi: Umi; service: Signer }>;

/** The service signer is reread through a no-follow bounded handle and never enters logs or DB. */
@Injectable()
export class SeasonNftUmiFactory {
  constructor(private readonly config: ConfigService<AllConfigType>) {}

  async create(): Promise<ReleaseUmi> {
    const endpoint = this.config.get('seasonNft.rpcUrl', { infer: true });
    const keyPath = this.config.get('seasonNft.serviceKeypairPath', {
      infer: true,
    });
    if (!endpoint || !keyPath)
      throw new Error('Season NFT signer configuration is unavailable.');
    const handle = await open(
      keyPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let source: string;
    try {
      const stats = await handle.stat();
      if (
        !stats.isFile() ||
        (stats.mode & 0o077) !== 0 ||
        stats.size <= 0 ||
        stats.size > 1024
      ) {
        throw new Error(
          'Season NFT service key must be a small private regular file.',
        );
      }
      source = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const parsed: unknown = JSON.parse(source);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every(
        (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
      )
    ) {
      throw new Error('Season NFT service key is invalid.');
    }
    const umi = createUmi(endpoint)
      .use(core.mplCore())
      .use(candy.mplCandyMachine());
    const service = createSignerFromKeypair(
      umi,
      umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(parsed)),
    );
    umi.use(signerIdentity(service));
    return { umi, service };
  }
}

type ReleaseAccounts = Readonly<{
  slot: bigint;
  collection: ReturnType<typeof core.deserializeCollectionV1> | null;
  machine: ReturnType<typeof candy.deserializeCandyMachine> | null;
  guard: ReturnType<typeof candy.deserializeCandyGuard> | null;
}>;

function presentCollectionDelegates(collection: object): string[] {
  const values = collection as Record<string, unknown>;
  return DELEGATE_PLUGIN_KEYS.filter((key) => Boolean(values[key]));
}

/** Machine이 설치한 PDA 하나만 허용하고, 임의 delegate와 추가 플러그인은 거절한다. */
export function collectionMintDelegateMatches(
  collection: object,
  expected: string,
): boolean {
  const delegate = (
    collection as {
      updateDelegate?: {
        authority?: { type?: string };
        additionalDelegates?: unknown;
      };
    }
  ).updateDelegate;
  return Boolean(
    expected &&
    delegate?.authority?.type === 'UpdateAuthority' &&
    Array.isArray(delegate.additionalDelegates) &&
    delegate.additionalDelegates.length === 1 &&
    String(delegate.additionalDelegates[0]) === expected,
  );
}

/** 준비 중 임시 ImmutableMetadata, 잠금 후에는 이를 제거한 상태와 정확한 Machine delegate를 검증한다. */
export function collectionHasOnlyReleasePlugins(
  collection: object,
  expectedMintDelegate?: string,
  metadataLocked = false,
): boolean {
  const values = collection as Record<string, unknown>;
  return (
    (metadataLocked
      ? values.immutableMetadata === undefined
      : Boolean(values.immutableMetadata)) &&
    COLLECTION_PLUGIN_KEYS.every((key) =>
      key === 'updateDelegate' && expectedMintDelegate
        ? collectionMintDelegateMatches(collection, expectedMintDelegate)
        : values[key] === undefined,
    ) &&
    EXTERNAL_PLUGIN_ADAPTER_KEYS.every((key) => {
      const value = values[key];
      return (
        value === undefined || (Array.isArray(value) && value.length === 0)
      );
    })
  );
}

/** Decoded Guard state must leave every payment, expiry, gate, and plugin guard disabled. */
export function guardHasOnlyReleaseRules(guards: object): boolean {
  const values = guards as Record<string, unknown>;
  return candy.defaultCandyGuardNames.every((name) => {
    if (RELEASE_GUARD_NAMES.has(name)) return true;
    const value = values[name];
    return (
      typeof value === 'object' &&
      value !== null &&
      '__option' in value &&
      value.__option === 'None'
    );
  });
}

export function releaseSupplyMatches(
  readback: Readonly<{
    eligibleCount: number;
    itemsAvailable: bigint;
    itemsRedeemed: bigint;
    mintLimitId: number;
    mintLimit: number;
    groupCount: number;
  }>,
): boolean {
  // itemsRedeemed may increase after the atomic final lock but before DB recovery.
  return (
    readback.itemsAvailable === BigInt(readback.eligibleCount) &&
    readback.mintLimitId === 0 &&
    readback.mintLimit === 1 &&
    readback.groupCount === 0
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function decodeReleaseAccounts(
  umi: Umi,
  response: Readonly<{ slot: bigint; accounts: readonly MaybeRpcAccount[] }>,
): ReleaseAccounts {
  const [collectionRaw, machineRaw, guardRaw] = response.accounts;
  try {
    const expectedOwners = [
      CORE_PROGRAM_ID,
      CANDY_MACHINE_PROGRAM_ID,
      CANDY_GUARD_PROGRAM_ID,
    ];
    for (const [index, account] of response.accounts.entries()) {
      if (account?.exists && String(account.owner) !== expectedOwners[index]) {
        throw new Error('Program owner mismatch.');
      }
    }
    return {
      slot: response.slot,
      collection: collectionRaw?.exists
        ? core.deserializeCollectionV1(collectionRaw)
        : null,
      machine: machineRaw?.exists
        ? candy.deserializeCandyMachine(machineRaw)
        : null,
      guard: guardRaw?.exists
        ? candy.deserializeCandyGuard(umi, guardRaw)
        : null,
    };
  } catch (error: unknown) {
    throw new NftOperationPermanentError(
      'NFT_CHAIN_ACCOUNT_INVALID',
      'A season NFT account has an invalid owner or serialized shape.',
      { cause: error },
    );
  }
}

function assertCollection(
  source: SeasonNftChainSource,
  accounts: ReleaseAccounts,
  service: PublicKey,
  lock: PublicKey,
  umi: Umi,
): void {
  const collection = accounts.collection;
  if (!collection) return;
  const authority = String(collection.updateAuthority);
  const immutableAuthority = collection.immutableMetadata?.authority?.type;
  if (
    collection.name !== source.name ||
    collection.uri !== source.metadataUri ||
    (authority === String(service) &&
      immutableAuthority !== 'UpdateAuthority') ||
    !collectionHasOnlyReleasePlugins(
      collection,
      accounts.machine
        ? String(
            candy.findCandyMachineAuthorityPda(umi, {
              candyMachine: publicKey(source.candyMachineAddress!),
            })[0],
          )
        : undefined,
      authority === String(lock),
    ) ||
    (authority !== String(service) && authority !== String(lock))
  ) {
    throw new NftOperationPermanentError(
      'NFT_COLLECTION_CONFIGURATION_INVALID',
      'Existing season NFT collection settings or authority do not match.',
    );
  }
}

function assertMachineAndGuard(
  source: SeasonNftChainSource,
  accounts: ReleaseAccounts,
  service: PublicKey,
  lock: PublicKey,
  umi: Umi,
): void {
  const machine = accounts.machine;
  const guard = accounts.guard;
  if (!machine && !guard) return;
  if (!machine || !guard) {
    throw new NftOperationPermanentError(
      'NFT_MACHINE_PARTIAL_STATE',
      'Candy Machine and Candy Guard must exist together.',
    );
  }
  const hidden = machine.data.hiddenSettings;
  const allowList = guard.guards.allowList as Option<{
    merkleRoot: Uint8Array;
  }>;
  const mintLimit = guard.guards.mintLimit as Option<{
    id: number;
    limit: number;
  }>;
  const startDate = guard.guards.startDate as Option<{ date: bigint }>;
  const machineAuthority = String(machine.authority);
  const guardAuthority = String(guard.authority);
  const serviceAuthority = String(service);
  const lockAuthority = String(lock);
  // Start Date is the phase marker: service ownership keeps the sentinel; locked ownership removes it.
  const guardPhaseMatches =
    (guardAuthority === serviceAuthority &&
      isSome(startDate) &&
      startDate.value.date === CLAIM_BLOCK_START_DATE) ||
    (guardAuthority === lockAuthority && isNone(startDate));
  if (
    !hidden ||
    !isSome(hidden) ||
    hidden.value.name !== source.name ||
    hidden.value.uri !== source.metadataUri ||
    !equalBytes(hidden.value.hash, new Uint8Array(32)) ||
    BigInt(machine.data.itemsAvailable) !== BigInt(source.eligibleCount) ||
    BigInt(machine.data.maxEditionSupply) !== 0n ||
    machine.data.isMutable !== false ||
    !isNone(machine.data.configLineSettings) ||
    String(machine.collectionMint) !== source.collectionAddress ||
    !isSome(allowList) ||
    !equalBytes(allowList.value.merkleRoot, source.merkleRoot) ||
    !isSome(mintLimit) ||
    mintLimit.value.id !== 0 ||
    mintLimit.value.limit !== 1 ||
    guard.groups.length !== 0 ||
    !guardHasOnlyReleaseRules(guard.guards) ||
    (machineAuthority !== serviceAuthority &&
      machineAuthority !== lockAuthority) ||
    !guardPhaseMatches ||
    !mintDelegatePreserved({
      machineMintAuthority: String(machine.mintAuthority),
      candyGuardAddress: source.candyGuardAddress ?? '',
      machineCollection: String(machine.collectionMint),
      collectionAddress: source.collectionAddress ?? '',
      collectionMintDelegateMatches: Boolean(
        accounts.collection &&
        collectionMintDelegateMatches(
          accounts.collection,
          String(
            candy.findCandyMachineAuthorityPda(umi, {
              candyMachine: publicKey(source.candyMachineAddress!),
            })[0],
          ),
        ),
      ),
      collectionDelegatePlugins: accounts.collection
        ? presentCollectionDelegates(accounts.collection)
        : [],
    })
  ) {
    throw new NftOperationPermanentError(
      'NFT_MACHINE_CONFIGURATION_INVALID',
      'Existing Candy Machine, Guard, root, supply, or delegate settings do not match.',
    );
  }
}

function lockVerification(
  source: SeasonNftChainSource,
  accounts: ReleaseAccounts,
  lock: PublicKey,
  umi: Umi,
): LockVerification {
  const collection = accounts.collection;
  const machine = accounts.machine;
  const guard = accounts.guard;
  const hidden = machine?.data.hiddenSettings;
  const allowList = guard?.guards.allowList as
    Option<{ merkleRoot: Uint8Array }> | undefined;
  const mintLimit = guard?.guards.mintLimit as
    Option<{ id: number; limit: number }> | undefined;
  return {
    finalized: true,
    metadataMatches: Boolean(
      collection &&
      collection.name === source.name &&
      collection.uri === source.metadataUri &&
      machine &&
      hidden &&
      isSome(hidden) &&
      hidden.value.name === source.name &&
      hidden.value.uri === source.metadataUri,
    ),
    rootMatches: Boolean(
      guard &&
      allowList &&
      isSome(allowList) &&
      equalBytes(allowList.value.merkleRoot, source.merkleRoot),
    ),
    supplyMatches: Boolean(
      machine &&
      guard &&
      mintLimit &&
      isSome(mintLimit) &&
      releaseSupplyMatches({
        eligibleCount: source.eligibleCount,
        itemsAvailable: BigInt(machine.data.itemsAvailable),
        itemsRedeemed: machine.itemsRedeemed,
        mintLimitId: mintLimit.value.id,
        mintLimit: mintLimit.value.limit,
        groupCount: guard.groups.length,
      }),
    ),
    managementLocked: Boolean(
      collection &&
      machine &&
      guard &&
      String(collection.updateAuthority) === String(lock) &&
      String(machine.authority) === String(lock) &&
      String(guard.authority) === String(lock) &&
      isNone(guard.guards.startDate) &&
      collection.immutableMetadata === undefined,
    ),
    mintDelegatePreserved: Boolean(
      collection &&
      machine &&
      mintDelegatePreserved({
        machineMintAuthority: String(machine.mintAuthority),
        candyGuardAddress: source.candyGuardAddress ?? '',
        machineCollection: String(machine.collectionMint),
        collectionAddress: source.collectionAddress ?? '',
        collectionDelegatePlugins: presentCollectionDelegates(collection),
        collectionMintDelegateMatches: collectionMintDelegateMatches(
          collection,
          String(
            candy.findCandyMachineAuthorityPda(umi, {
              candyMachine: publicKey(source.candyMachineAddress!),
            })[0],
          ),
        ),
      }),
    ),
  };
}

type ReleaseIdentity = Readonly<{
  source: SeasonNftChainSource;
  umi: Umi;
  service: Signer;
  collection: Signer;
  machine: Signer;
  guard: Pda;
  lock: PublicKey;
}>;

type BlockhashCheckpoint = {
  blockhash: string;
  lastValidBlockHeight: bigint;
  fetchedAt: number;
  rentLamports?: bigint;
};

/** DB-authoritative release orchestration returns one externally scheduled RPC request per tick. */
@Injectable()
export class SeasonReleaseChain extends NftReleaseChainOperationProvider {
  private readonly checkpoints = new Map<string, BlockhashCheckpoint>();

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly releases: SeasonNftRepository,
    private readonly nftTransactions: NftTransactionRepository,
    private readonly transactions: TransactionRunner,
    private readonly keys: PreparationKeyStore,
    private readonly umiFactory: SeasonNftUmiFactory,
    private readonly transport: SeasonNftRpcTransport,
  ) {
    super();
  }

  async next(releaseId: string): Promise<NftRpcJob<void> | null> {
    const identity = await this.loadIdentity(releaseId);
    if (!identity || identity.source.state !== 'PREPARING') return null;
    if (!['METADATA', 'COLLECTION', 'MACHINE'].includes(identity.source.stage))
      return null;
    const checkpoint = this.checkpoints.get(releaseId);
    if (!checkpoint || Date.now() - checkpoint.fetchedAt > 30_000) {
      return {
        kind: 'RELEASE_PREPARE',
        rpcType: 'READ',
        run: async (signal) => {
          this.checkpoints.set(releaseId, {
            ...(await this.transport.getLatestBlockhash(signal)),
            fetchedAt: Date.now(),
          });
        },
      };
    }
    if (
      identity.source.stage === 'COLLECTION' &&
      checkpoint.rentLamports === undefined
    ) {
      const size = candy.getCandyMachineSize(
        identity.source.eligibleCount,
        none(),
      );
      return {
        kind: 'RELEASE_PREPARE',
        rpcType: 'READ',
        run: async (signal) => {
          checkpoint.rentLamports = await this.transport.getRent(size, signal);
        },
      };
    }
    return {
      kind: 'RELEASE_PREPARE',
      rpcType: 'READ',
      run: async (signal) => {
        const response = await this.transport.getAccounts(
          [
            identity.source.collectionAddress!,
            identity.source.candyMachineAddress!,
            identity.source.candyGuardAddress!,
          ],
          signal,
        );
        const accounts = decodeReleaseAccounts(identity.umi, response);
        await this.progress(identity, accounts, checkpoint);
      },
    };
  }

  /** Dispatcher uses the same finalized decoder to reconcile chain effects after uncertain sends. */
  async inspectEffects(
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ): Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'accountEvidence' | 'reconciliationEvidence'
    >[]
  > {
    const contexts = await Promise.all(
      transactions.map(async (transaction) => ({
        transaction,
        identity:
          transaction.releaseId &&
          transaction.operationKey?.startsWith('setup:')
            ? await this.loadIdentity(transaction.releaseId)
            : null,
      })),
    );
    const usable = contexts.filter(
      (item): item is typeof item & { identity: ReleaseIdentity } =>
        item.identity !== null,
    );
    const addresses = [
      ...new Set(
        usable.flatMap(({ identity }) => [
          identity.source.collectionAddress!,
          identity.source.candyMachineAddress!,
          identity.source.candyGuardAddress!,
        ]),
      ),
    ];
    if (addresses.length === 0) {
      return transactions.map(({ id }) => ({
        transactionId: id,
        accountEvidence: 'UNKNOWN',
      }));
    }
    if (addresses.length > 100) {
      throw new Error(
        'Season NFT setup effect inspection exceeded one RPC account batch.',
      );
    }
    const response = await this.transport.getAccounts(addresses, signal);
    if (response.accounts.length !== addresses.length) {
      throw new Error('Season NFT RPC returned an incomplete account batch.');
    }
    const byAddress = new Map(
      addresses.map((address, index) => [address, response.accounts[index]]),
    );
    return contexts.map(({ transaction, identity }) => {
      if (!identity || !transaction.operationKey?.startsWith('setup:')) {
        return {
          transactionId: transaction.id,
          accountEvidence: 'UNKNOWN' as const,
        };
      }
      const local = decodeReleaseAccounts(identity.umi, {
        slot: response.slot,
        accounts: [
          byAddress.get(identity.source.collectionAddress!)!,
          byAddress.get(identity.source.candyMachineAddress!)!,
          byAddress.get(identity.source.candyGuardAddress!)!,
        ],
      });
      const success = this.operationEffect(
        transaction.operationKey,
        identity,
        local,
      );
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

  private async loadIdentity(
    releaseId: string,
  ): Promise<ReleaseIdentity | null> {
    let source = await this.releases.findChainSource(releaseId);
    if (!source) return null;
    const configuredNetwork = this.config.get('seasonNft.network', {
      infer: true,
    });
    if (configuredNetwork !== source.network) {
      throw new NftOperationPermanentError(
        'NFT_RELEASE_NETWORK_MISMATCH',
        'Season NFT release network does not match the worker network.',
      );
    }
    const { umi, service } = await this.umiFactory.create();
    try {
      const collection = await this.keys.loadOrCreate({
        network: source.network,
        releaseId,
        kind: 'collection',
        expectedPublicKey: source.collectionAddress ?? undefined,
        umi,
      });
      const machine = await this.keys.loadOrCreate({
        network: source.network,
        releaseId,
        kind: 'machine',
        expectedPublicKey: source.candyMachineAddress ?? undefined,
        umi,
      });
      const guard = candy.findCandyGuardPda(umi, {
        base: machine.signer.publicKey,
      });
      const lock = umi.eddsa.findPda(publicKey(SYSTEM_PROGRAM_ID), [
        Buffer.from('cameo-nft-lock-v1', 'utf8'),
      ])[0];
      if (
        source.collectionAddress === null ||
        source.candyMachineAddress === null ||
        source.candyGuardAddress === null
      ) {
        const stored = await this.releases.recordPreparationIdentity({
          releaseId,
          expectedVersion: source.version,
          collectionAddress: collection.publicKey,
          candyMachineAddress: machine.publicKey,
          candyGuardAddress: String(guard[0]),
          preparationKeys: {
            [collection.publicKey]: collection.relativePath,
            [machine.publicKey]: machine.relativePath,
          },
        });
        if (stored.conflict) {
          throw new NftOperationPermanentError(
            'NFT_PREPARATION_IDENTITY_CONFLICT',
            'A durable NFT preparation identity changed.',
          );
        }
        source = await this.releases.findChainSource(releaseId);
        if (!source) return null;
      }
      if (
        source.collectionAddress !== collection.publicKey ||
        source.candyMachineAddress !== machine.publicKey ||
        source.candyGuardAddress !== String(guard[0])
      ) {
        throw new NftOperationPermanentError(
          'NFT_PREPARATION_IDENTITY_MISMATCH',
          'Season NFT persisted preparation addresses do not match durable keys.',
        );
      }
      const expectedPreparationKeys = {
        [collection.publicKey]: collection.relativePath,
        [machine.publicKey]: machine.relativePath,
      };
      const preparationKeys = source.preparationKeys;
      const actualPreparationKeys = Object.entries(preparationKeys);
      if (
        actualPreparationKeys.length !== 2 ||
        Object.entries(expectedPreparationKeys).some(
          ([address, relativePath]) =>
            preparationKeys[address] !== relativePath,
        )
      ) {
        throw new NftOperationPermanentError(
          'NFT_PREPARATION_IDENTITY_MISMATCH',
          'Season NFT persisted preparation key references do not match durable keys.',
        );
      }
      return {
        source,
        umi,
        service,
        collection: collection.signer,
        machine: machine.signer,
        guard,
        lock,
      };
    } catch (error: unknown) {
      if (error instanceof PreparationKeyStoreError) {
        throw new NftOperationPermanentError(error.code, error.message, {
          cause: error,
        });
      }
      throw error;
    }
  }

  private async progress(
    identity: ReleaseIdentity,
    accounts: ReleaseAccounts,
    checkpoint: BlockhashCheckpoint,
  ): Promise<void> {
    const { source, umi, service } = identity;
    assertCollection(source, accounts, service.publicKey, identity.lock, umi);
    if (source.stage === 'METADATA') {
      if (!accounts.collection) {
        await this.prepareOperation(
          identity,
          setupOperationKey('collection', 0),
          'SETUP_COLLECTION',
          core.createCollection(umi, {
            collection: identity.collection,
            updateAuthority: service.publicKey,
            payer: service,
            name: source.name,
            uri: source.metadataUri,
            plugins: [{ type: 'ImmutableMetadata' }],
          }),
          checkpoint,
        );
        return;
      }
      await this.advance(identity, 'METADATA', 'COLLECTION');
      return;
    }
    assertMachineAndGuard(
      source,
      accounts,
      service.publicKey,
      identity.lock,
      umi,
    );
    if (source.stage === 'COLLECTION') {
      if (!accounts.machine && !accounts.guard) {
        await this.prepareOperation(
          identity,
          setupOperationKey('machine', 0),
          'SETUP_MACHINE',
          await buildMachineAndGuard({
            umi,
            service,
            collection: identity.collection.publicKey,
            machine: identity.machine,
            name: source.name,
            metadataUri: source.metadataUri,
            eligibleCount: source.eligibleCount,
            merkleRoot: source.merkleRoot,
            rentLamports: checkpoint.rentLamports!,
          }),
          checkpoint,
        );
        return;
      }
      await this.advance(identity, 'COLLECTION', 'MACHINE');
      return;
    }
    const verification = lockVerification(source, accounts, identity.lock, umi);
    if (canOpenClaims(verification)) {
      await this.advance(identity, 'MACHINE', 'LOCKED');
      return;
    }
    const machine = accounts.machine!;
    const collection = accounts.collection!;
    const guard = accounts.guard!;
    if (String(machine.authority) === String(service.publicKey)) {
      await this.prepareOperation(
        identity,
        setupOperationKey('lock', 0),
        'SETUP_LOCK',
        candy.setCandyMachineAuthority(umi, {
          candyMachine: identity.machine.publicKey,
          authority: service,
          newAuthority: identity.lock,
        }),
        checkpoint,
      );
      return;
    }
    if (String(collection.updateAuthority) === String(service.publicKey)) {
      await this.prepareOperation(
        identity,
        setupOperationKey('lock', 1),
        'SETUP_LOCK',
        buildCollectionAuthorityLock({
          umi,
          collection: identity.collection.publicKey,
          authority: service,
          lockAuthority: identity.lock,
        }),
        checkpoint,
      );
      return;
    }
    if (
      String(guard.authority) === String(service.publicKey) &&
      isSome(guard.guards.startDate)
    ) {
      await this.prepareOperation(
        identity,
        setupOperationKey('lock', 2),
        'SETUP_LOCK',
        buildFinalGuardLock({
          umi,
          authority: service,
          candyGuard: identity.guard,
          lockAuthority: identity.lock,
          merkleRoot: source.merkleRoot,
        }),
        checkpoint,
      );
      return;
    }
    throw new NftOperationPermanentError(
      'NFT_LOCK_STATE_INVALID',
      'Season NFT authority lock state is inconsistent.',
    );
  }

  private async prepareOperation(
    identity: ReleaseIdentity,
    operationKey: string,
    kind: 'SETUP_COLLECTION' | 'SETUP_MACHINE' | 'SETUP_LOCK',
    builder: TransactionBuilder,
    checkpoint: BlockhashCheckpoint,
  ): Promise<void> {
    const existing = await this.nftTransactions.findByOperation({
      network: identity.source.network,
      releaseId: identity.source.releaseId,
      operationKey,
    });
    if (existing?.state === 'PREPARED') {
      await this.promotePrepared(identity.umi, existing);
      return;
    }
    if (existing && ['FINALIZED', 'RECONCILED'].includes(existing.state)) {
      throw new NftOperationPermanentError(
        'NFT_FINALIZED_EFFECT_MISSING',
        'A finalized setup transaction has no matching finalized account effect.',
      );
    }
    if (existing && !['FAILED', 'EXPIRED'].includes(existing.state)) return;
    const transaction = await builder
      .setBlockhash({
        blockhash: checkpoint.blockhash,
        lastValidBlockHeight: Number(checkpoint.lastValidBlockHeight),
      })
      .buildAndSign(identity.umi);
    const signedBytes = Buffer.from(
      identity.umi.transactions.serialize(transaction),
    );
    const messageHash = createHash('sha256')
      .update(transaction.serializedMessage)
      .digest('hex');
    const preparedInput = {
      network: identity.source.network,
      releaseId: identity.source.releaseId,
      operationKey,
      kind,
      messageHash,
      serializedTransaction: signedBytes,
      recentBlockhash: checkpoint.blockhash,
      lastValidBlockHeight: checkpoint.lastValidBlockHeight,
    } as const;
    const prepared = await withDbOnlyRetry(() =>
      this.transactions.run((databaseTransaction) =>
        existing
          ? this.nftTransactions.replaceExpired(
              { transactionId: existing.id, replacement: preparedInput },
              databaseTransaction,
            )
          : this.nftTransactions.insertPrepared(
              preparedInput,
              databaseTransaction,
            ),
      ),
    );
    const durable = await this.nftTransactions.findDispatchable(
      prepared.transactionId,
    );
    if (!durable)
      throw new Error('Prepared season NFT transaction disappeared.');
    if (durable.state === 'PREPARED')
      await this.promotePrepared(identity.umi, durable);
    this.checkpoints.delete(identity.source.releaseId);
  }

  private async promotePrepared(
    umi: Umi,
    transaction: DispatchableNftTransaction,
  ): Promise<void> {
    const decoded = umi.transactions.deserialize(
      transaction.serializedTransaction,
    );
    const messageHash = createHash('sha256')
      .update(decoded.serializedMessage)
      .digest('hex');
    const signature = bs58.encode(decoded.signatures[0]);
    await withDbOnlyRetry(() =>
      this.transactions.run((databaseTransaction) =>
        this.nftTransactions.acceptSigned(
          {
            transactionId: transaction.id,
            expectedMessageHash: messageHash,
            signedBytes: transaction.serializedTransaction,
            signature,
          },
          databaseTransaction,
        ),
      ),
    );
  }

  private async advance(
    identity: ReleaseIdentity,
    expectedStage: 'METADATA' | 'COLLECTION' | 'MACHINE',
    nextStage: 'COLLECTION' | 'MACHINE' | 'LOCKED',
  ): Promise<void> {
    const now = new Date();
    await withDbOnlyRetry(() =>
      this.transactions.run((databaseTransaction) =>
        this.releases.advanceStage(
          {
            releaseId: identity.source.releaseId,
            expectedVersion: identity.source.version,
            expectedStage,
            nextStage,
            ...(nextStage === 'COLLECTION'
              ? { collectionAddress: identity.source.collectionAddress! }
              : {}),
            ...(nextStage === 'MACHINE'
              ? {
                  candyMachineAddress: identity.source.candyMachineAddress!,
                  candyGuardAddress: identity.source.candyGuardAddress!,
                }
              : {}),
            ...(nextStage === 'LOCKED' ? { lockedAt: now, readyAt: now } : {}),
          },
          databaseTransaction,
        ),
      ),
    );
    this.checkpoints.delete(identity.source.releaseId);
  }

  private operationEffect(
    operationKey: string,
    identity: ReleaseIdentity,
    accounts: ReleaseAccounts,
  ): boolean {
    assertCollection(
      identity.source,
      accounts,
      identity.service.publicKey,
      identity.lock,
      identity.umi,
    );
    if (operationKey === setupOperationKey('collection', 0))
      return accounts.collection !== null;
    assertMachineAndGuard(
      identity.source,
      accounts,
      identity.service.publicKey,
      identity.lock,
      identity.umi,
    );
    if (operationKey === setupOperationKey('machine', 0)) {
      return accounts.machine !== null && accounts.guard !== null;
    }
    if (operationKey === setupOperationKey('lock', 0)) {
      return String(accounts.machine?.authority) === String(identity.lock);
    }
    if (operationKey === setupOperationKey('lock', 1)) {
      return (
        String(accounts.collection?.updateAuthority) === String(identity.lock)
      );
    }
    if (operationKey === setupOperationKey('lock', 2)) {
      return canOpenClaims(
        lockVerification(
          identity.source,
          accounts,
          identity.lock,
          identity.umi,
        ),
      );
    }
    return false;
  }
}

/** Production dispatcher adapter exposes each status/effect/height request independently. */
@Injectable()
export class SolanaNftChainRpc extends NftChainRpc {
  constructor(
    private readonly transport: SeasonNftRpcTransport,
    private readonly releaseChain: SeasonReleaseChain,
    private readonly claimEffects: NftClaimEffectRpc,
  ) {
    super();
  }

  async sendSignedTransaction(
    bytes: Buffer,
    signal: AbortSignal,
  ): Promise<string> {
    return this.transport.sendTransaction(bytes, signal);
  }

  async inspectTransactions(): Promise<never> {
    throw new Error(
      'Production NFT inspection must use request-level scheduling.',
    );
  }

  override inspectSignatures = async (
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ): Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'signature' | 'errorCode'
    >[]
  > => {
    const signed = transactions.filter(
      (
        transaction,
      ): transaction is DispatchableNftTransaction & { signature: string } =>
        transaction.signature !== null,
    );
    const statuses = await this.transport.getSignatureStatuses(
      signed.map(({ signature }) => signature),
      signal,
    );
    const statusById = new Map(
      signed.map((transaction, index) => [transaction.id, statuses[index]]),
    );
    return transactions.map((transaction) => {
      const status = statusById.get(transaction.id);
      const failed = status?.error !== null && status?.error !== undefined;
      return {
        transactionId: transaction.id,
        signature: failed
          ? 'FAILED'
          : status?.confirmationStatus === 'finalized'
            ? 'FINALIZED'
            : status?.confirmationStatus === 'confirmed'
              ? 'CONFIRMED'
              : 'ABSENT',
        ...(failed ? { errorCode: 'NFT_TRANSACTION_FAILED' } : {}),
      };
    });
  };

  override inspectAccountEffects = (
    transactions: readonly DispatchableNftTransaction[],
    signal: AbortSignal,
  ): Promise<
    readonly Pick<
      NftTransactionInspection,
      'transactionId' | 'accountEvidence' | 'reconciliationEvidence'
    >[]
  > => {
    if (transactions.every(({ kind }) => kind?.startsWith('SETUP_')))
      return this.releaseChain.inspectEffects(transactions, signal);
    if (transactions.every(({ kind }) => kind?.startsWith('USER_')))
      return this.claimEffects.inspect(transactions, signal);
    throw new Error('NFT account effect batch mixes setup and user work.');
  };

  override getFinalizedBlockHeight = (signal: AbortSignal): Promise<bigint> => {
    return this.transport.getFinalizedBlockHeight(signal);
  };
}

/** Enabled startup consumes one shared-limiter read and rejects endpoints for another Solana network. */
@Injectable()
export class SeasonNftRpcStartupValidator {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly transport: SeasonNftRpcTransport,
  ) {}

  async validate(scheduler: NftRpcScheduler): Promise<void> {
    const network = this.config.get('seasonNft.network', { infer: true });
    if (!network)
      throw new Error('Season NFT configured network is unavailable.');
    const genesisHash = await scheduler.enqueue({
      kind: 'RELEASE_PREPARE',
      rpcType: 'READ',
      run: (signal) => this.transport.getGenesisHash(signal),
    });
    if (genesisHash !== EXPECTED_GENESIS_HASHES[network]) {
      throw new Error(
        'Season NFT RPC does not match the configured network genesis hash.',
      );
    }
  }
}
