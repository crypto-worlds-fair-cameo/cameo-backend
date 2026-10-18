import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createNoopSigner,
  generateSigner,
  lamports,
  none,
  publicKey,
  signerIdentity,
  some,
  dateTime,
  type TransactionBuilder,
  type Umi,
} from '@metaplex-foundation/umi';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import * as core from '@metaplex-foundation/mpl-core';
import * as candy from '@metaplex-foundation/mpl-core-candy-machine';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { CanvasSnapshotFiles } from '../../../canvas/resources/canvas-snapshot/canvas-snapshot-files';
import type { SeasonNftNetwork } from '../../resources/season-nft/season-nft';
import { SeasonNftInternalErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { SeasonNftRepository } from '../../resources/season-nft/season-nft.repository';
import { NftTransactionRepository } from '../../resources/solana-nft/nft-transaction.repository';
import { SeasonNftRpcTransport } from '../../resources/solana-nft/season-release-chain';
import { validateSignedClaimTransaction } from '../../resources/solana-nft/signed-transaction-validator';
import { MAX_CREATOR_ALLOCATION } from '../../resources/season-nft/season-nft-eligibility';
import {
  SeasonNftMintQuery,
  type SeasonNftMintSeason,
} from './season-nft-mint.query';

const MAX_SUPPLY = BigInt(Number.MAX_SAFE_INTEGER);
const SETUP_TRANSACTION_COUNT = 5n;
const FEE_BUFFER_LAMPORTS = 15_000n;
// Core SDK는 컬렉션과 에셋 계정 크기를 bytesCreatedOnChain에 넣지 않는다.
const COLLECTION_ACCOUNT_SPACE = 600;
const ASSET_ACCOUNT_SPACE = 400;

export type SeasonNftMintView = Readonly<{
  seasonId: string;
  status:
    'NONE' | 'WAITING_SNAPSHOT' | 'PREPARING' | 'READY' | 'EMPTY' | 'BLOCKED';
  network: SeasonNftNetwork;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  eligibleCount: number;
  minSupply: string;
  supply: string;
  creatorAllocation: string;
  strokeCount: string;
  imageUrl: string | null;
  estimatedLamports: string | null;
  walletAddress: string;
  mintedCount: string;
  signatureCount: number;
  collectionAddress: string | null;
  pendingTransaction: Readonly<{
    transactionId: string;
    serializedTransactionBase64: string;
    purpose: 'SETUP' | 'CREATOR_MINT';
  }> | null;
}>;

function parseSupply(value: string): bigint {
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) {
    throw new BusinessError(ErrorCodes.NftMintSupplyTooSmall);
  }
  const supply = BigInt(value);
  if (supply <= 0n || supply > MAX_SUPPLY) {
    throw new BusinessError(ErrorCodes.NftMintSupplyTooSmall);
  }
  return supply;
}

function accountSpaces(builder: TransactionBuilder): number[] {
  return builder.items
    .map((item) => item.bytesCreatedOnChain)
    .filter((size) => size > 0);
}

/** 개설자가 고른 수량으로 시즌 NFT 발행을 시작하고, 체인 거래 서명을 접수한다. */
@Injectable()
export class RequestSeasonNftMintUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly transactions: TransactionRunner,
    private readonly seasons: SeasonNftMintQuery,
    private readonly releases: SeasonNftRepository,
    private readonly nftTransactions: NftTransactionRepository,
    private readonly transport: SeasonNftRpcTransport,
    private readonly snapshots: CanvasSnapshotFiles,
  ) {}

  async preview(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
    supplyText?: string,
  ): Promise<SeasonNftMintView> {
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    const actor = await this.actor(token);
    const source = await this.seasons.load(seasonId, actor.network);
    return this.view(source, actor, supplyText);
  }

  async request(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
    supplyText: string,
    description?: string,
  ): Promise<SeasonNftMintView> {
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    const actor = await this.actor(token);
    const nftDescription = this.description(description);
    const source = await this.transactions.run(async (transaction) => {
      const locked = await this.seasons.load(
        seasonId,
        actor.network,
        transaction,
        true,
      );
      this.assertCanMint(locked, actor.userId, actor.walletAddress);
      const supply = this.supplyFor(locked!, supplyText);
      const release = locked!.release;
      if (!release) {
        await this.releases.insertMintRequest(
          {
            seasonId,
            network: actor.network,
            supply,
            creatorWalletAddress: actor.walletAddress,
            nftDescription,
          },
          transaction,
        );
      } else if (
        release.supply !== supply ||
        release.nftDescription !== nftDescription
      ) {
        const revised = await this.releases.reviseMintRequest(
          {
            releaseId: release.id,
            expectedVersion: release.version,
            supply,
            nftDescription,
            resumeBlocked:
              release.lastErrorCode ===
              SeasonNftInternalErrorCodes.SupplyBelowEligible,
          },
          transaction,
        );
        if (!revised.updated) {
          throw new BusinessError(ErrorCodes.NftNotReady);
        }
      }
      return this.seasons.load(seasonId, actor.network, transaction, true);
    });
    return this.view(source, actor, supplyText);
  }

  async submit(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
    transactionId: string,
    signedTransactionBase64: string,
  ): Promise<Readonly<{ accepted: boolean; signature: string }>> {
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );
    const actor = await this.actor(token);
    const owned = await this.transactions.run((transaction) =>
      this.seasons.findOwnedSetup({ seasonId, transactionId }, transaction),
    );
    if (!owned || owned.creatorId !== actor.userId) {
      throw new BusinessError(ErrorCodes.NftMintNotCreator);
    }
    if (owned.network !== actor.network) {
      throw new BusinessError(ErrorCodes.NftServiceUnavailable);
    }
    if (owned.creatorWalletAddress !== actor.walletAddress) {
      throw new BusinessError(ErrorCodes.NftWalletMismatch);
    }
    let validated;
    try {
      validated = validateSignedClaimTransaction({
        preparedBytes: owned.serializedTransaction,
        submittedBase64: signedTransactionBase64,
        expectedPayer: actor.walletAddress,
        expectedMessageHash: owned.messageHash,
      });
    } catch {
      throw new BusinessError(ErrorCodes.NftTransactionInvalid);
    }
    const accepted = await this.transactions.run((transaction) =>
      this.nftTransactions.acceptSigned(
        {
          transactionId,
          expectedMessageHash: owned.messageHash,
          signedBytes: validated.signedBytes,
          signature: validated.signature,
        },
        transaction,
      ),
    );
    if (!accepted.accepted && accepted.signature !== validated.signature) {
      throw new BusinessError(ErrorCodes.NftTransactionInvalidState);
    }
    return { accepted: true, signature: accepted.signature };
  }

  private async actor(token: string | undefined): Promise<
    Readonly<{
      userId: string;
      walletAddress: string;
      network: SeasonNftNetwork;
    }>
  > {
    const enabled = this.config.get('seasonNft.enabled', { infer: true });
    const network = this.config.get('seasonNft.network', { infer: true });
    if (!enabled || (network !== 'devnet' && network !== 'mainnet-beta')) {
      throw new BusinessError(ErrorCodes.NftServiceUnavailable);
    }
    const authentication = await this.transactions.run((transaction) =>
      this.authenticator.authenticate(token, transaction),
    );
    if (authentication.outcome !== 'authenticated') {
      throw new BusinessError(
        authentication.outcome === 'invalid'
          ? ErrorCodes.AuthSessionInvalid
          : ErrorCodes.AuthUserUnavailable,
      );
    }
    return {
      userId: authentication.user.id,
      walletAddress: authentication.walletAddress,
      network,
    };
  }

  private description(value: string | undefined): string | null {
    const trimmed = value?.trim() ?? '';
    if (!trimmed) return null;
    if (trimmed.length > 1000) {
      throw new BusinessError(ErrorCodes.NftTransactionInvalid);
    }
    return trimmed;
  }

  private assertCanMint(
    source: SeasonNftMintSeason | null,
    userId: string,
    walletAddress: string,
  ): void {
    if (!source) throw new BusinessError(ErrorCodes.SeasonNotFound);
    if (source.creatorId !== userId) {
      throw new BusinessError(ErrorCodes.NftMintNotCreator);
    }
    if (source.cancelled) {
      throw new BusinessError(ErrorCodes.NftSeasonUnavailable);
    }
    if (!source.ended) throw new BusinessError(ErrorCodes.NftMintNotEnded);
    if (source.creatorWalletAddress !== walletAddress) {
      throw new BusinessError(ErrorCodes.NftWalletMismatch);
    }
    if (source.release?.supply === null) {
      throw new BusinessError(ErrorCodes.NftNotReady);
    }
  }

  private supplyFor(source: SeasonNftMintSeason, supplyText: string): bigint {
    const eligible = BigInt(source.eligibility.length);
    if (eligible < 1n) throw new BusinessError(ErrorCodes.NftNotEligible);
    const supply = parseSupply(supplyText);
    if (supply < eligible) {
      throw new BusinessError(ErrorCodes.NftMintSupplyTooSmall);
    }
    if (supply - eligible + 1n > BigInt(MAX_CREATOR_ALLOCATION)) {
      throw new BusinessError(ErrorCodes.NftMintAllocationTooLarge);
    }
    return supply;
  }

  private async view(
    source: SeasonNftMintSeason | null,
    actor: Readonly<{
      userId: string;
      walletAddress: string;
      network: SeasonNftNetwork;
    }>,
    supplyText: string | undefined,
  ): Promise<SeasonNftMintView> {
    if (!source) throw new BusinessError(ErrorCodes.SeasonNotFound);
    if (source.creatorId !== actor.userId) {
      throw new BusinessError(ErrorCodes.NftMintNotCreator);
    }
    const eligibleCount = source.eligibility.length;
    const stored = source.release?.supply ?? null;
    const supply =
      stored ??
      (supplyText
        ? parseSupply(supplyText)
        : BigInt(Math.max(eligibleCount, 1)));
    const allocation =
      supply - BigInt(Math.max(eligibleCount, 1)) + 1n > 0n
        ? supply - BigInt(Math.max(eligibleCount, 1)) + 1n
        : 1n;
    const imageUrl = this.imageUrl(source.imageKey);
    const estimatedLamports =
      source.release === null &&
      eligibleCount > 0 &&
      allocation <= BigInt(MAX_CREATOR_ALLOCATION)
        ? await this.estimate(Number(allocation))
        : null;
    const pending = source.pendingTransaction;
    return {
      seasonId: source.seasonId,
      status: source.release?.state ?? 'NONE',
      network: actor.network,
      title: source.title,
      description: source.release?.nftDescription ?? source.description ?? '',
      startsAt: source.startsAt.toISOString(),
      endsAt: source.endsAt.toISOString(),
      eligibleCount,
      minSupply: String(Math.max(eligibleCount, 1)),
      supply: supply.toString(),
      creatorAllocation: allocation.toString(),
      strokeCount: source.strokeCount.toString(),
      imageUrl,
      estimatedLamports,
      walletAddress: source.creatorWalletAddress ?? actor.walletAddress,
      mintedCount: (source.release?.creatorMintedCount ?? 0n).toString(),
      signatureCount: Number(allocation) + Number(SETUP_TRANSACTION_COUNT),
      collectionAddress:
        source.release?.state === 'READY'
          ? source.release.collectionAddress
          : null,
      pendingTransaction: pending
        ? {
            transactionId: pending.id,
            serializedTransactionBase64:
              pending.serializedTransaction.toString('base64'),
            purpose:
              pending.kind === 'SETUP_CREATOR_MINT' ? 'CREATOR_MINT' : 'SETUP',
          }
        : null,
    };
  }

  private imageUrl(key: string | null): string | null {
    if (!key) return null;
    try {
      return this.snapshots.publicUrl(key);
    } catch {
      return null;
    }
  }

  /** 컬렉션, 기계, 개설자 NFT 임대료와 거래 수수료를 더해 예상 비용을 만든다. */
  private async estimate(allocation: number): Promise<string | null> {
    try {
      const umi = createUmi('http://127.0.0.1')
        .use(core.mplCore())
        .use(candy.mplCandyMachine());
      const service = generateSigner(umi);
      umi.use(signerIdentity(service));
      const creator = generateSigner(umi).publicKey;
      const payer = createNoopSigner(creator);
      const collection = generateSigner(umi);
      const machine = generateSigner(umi);
      const asset = generateSigner(umi);
      const quoting = Object.assign(Object.create(umi), umi, {
        rpc: Object.assign(Object.create(umi.rpc), umi.rpc, {
          getRent: async () => lamports(1n),
        }),
      }) as Umi;
      const collectionBuilder = core.createCollection(quoting, {
        collection,
        updateAuthority: service.publicKey,
        payer,
        name: 'Season',
        uri: 'https://arweave.net/example',
        plugins: [{ type: 'ImmutableMetadata' }],
      });
      const machineBuilder = await candy.create(quoting, {
        candyMachine: machine,
        collection: collection.publicKey,
        collectionUpdateAuthority: service,
        payer,
        authority: service.publicKey,
        itemsAvailable: allocation,
        maxEditionSupply: 0,
        isMutable: false,
        hiddenSettings: some({
          name: 'Season',
          uri: 'https://arweave.net/example',
          hash: new Uint8Array(32),
        }),
        configLineSettings: none(),
        guards: { startDate: some({ date: dateTime(0n) }) },
        groups: [],
      });
      const mintBuilder = candy.mintV1(quoting, {
        candyMachine: machine.publicKey,
        candyGuard: publicKey(machine.publicKey),
        payer,
        minter: payer,
        owner: creator,
        asset,
        collection: collection.publicKey,
        mintArgs: {},
      });
      const spaces = [
        ...accountSpaces(collectionBuilder),
        ...accountSpaces(machineBuilder),
      ];
      if (accountSpaces(collectionBuilder).length === 0) {
        spaces.push(COLLECTION_ACCOUNT_SPACE);
      }
      const mintSpaces = accountSpaces(mintBuilder);
      if (mintSpaces.length === 0) mintSpaces.push(ASSET_ACCOUNT_SPACE);
      const signal = AbortSignal.timeout(8_000);
      let total = 0n;
      for (const space of spaces) {
        total += await this.transport.getRent(space, signal);
      }
      const mintRent = await mintSpaces.reduce(
        async (sum, space) =>
          (await sum) + (await this.transport.getRent(space, signal)),
        Promise.resolve(0n),
      );
      total += mintRent * BigInt(allocation);
      total +=
        FEE_BUFFER_LAMPORTS * (BigInt(allocation) + SETUP_TRANSACTION_COUNT);
      return total.toString();
    } catch {
      return null;
    }
  }
}
