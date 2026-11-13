import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { SeasonNftStorageFund } from '../../resources/nft-media/season-nft-storage-fund';
import type {
  SeasonNftNetwork,
  SeasonNftTransactionKind,
} from '../../resources/season-nft/season-nft';
import { SeasonNftInternalErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { SeasonNftRepository } from '../../resources/season-nft/season-nft.repository';
import { CreatorSignaturePresence } from '../../resources/solana-nft/creator-signature-presence';
import {
  CREATOR_AWAITING_SIGNATURE,
  creatorApprovalStep,
  creatorWalletApprovalCount,
} from '../../resources/solana-nft/creator-signature-wait';
import { NftTransactionRepository } from '../../resources/solana-nft/nft-transaction.repository';
import { SeasonNftRpcTransport } from '../../resources/solana-nft/season-release-chain';
import { NftServerCosigner } from '../../resources/solana-nft/server-cosigner';
import {
  isSignedTransactionRejection,
  signedTransactionRejection,
  validateWalletSignedTransaction,
} from '../../resources/solana-nft/signed-transaction-validator';
import { MAX_CREATOR_ALLOCATION } from '../../resources/season-nft/season-nft-eligibility';
import {
  SeasonNftMintQuery,
  type SeasonNftMintSeason,
} from './season-nft-mint.query';

const MAX_SUPPLY = BigInt(Number.MAX_SAFE_INTEGER);
/** 컬렉션, 발행 장치, 잠금. 잠금 3종은 확인 한 번에 서명한다. */
const SETUP_TRANSACTION_COUNT = 3n;
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
  /** 지금 지갑 확인이 전체 중 몇 번째인지. 확인할 거래가 없으면 null. */
  step: number | null;
  collectionAddress: string | null;
  pendingTransaction: Readonly<{
    transactionId: string;
    serializedTransactionBase64: string;
    purpose: 'SETUP' | 'CREATOR_MINT';
  }> | null;
  pendingTransactions: readonly Readonly<{
    transactionId: string;
    serializedTransactionBase64: string;
    purpose: 'SETUP' | 'CREATOR_MINT';
  }>[];
}>;

/** 확인할 거래가 있을 때만 몇 번째 확인인지 계산한다. */
function approvalStep(
  kind: SeasonNftTransactionKind | undefined,
  allocation: number,
  mintedCount: number,
  paysStorage: boolean,
): number | null {
  if (
    kind !== 'SETUP_STORAGE_FUND' &&
    kind !== 'SETUP_COLLECTION' &&
    kind !== 'SETUP_MACHINE' &&
    kind !== 'SETUP_GUARD' &&
    kind !== 'SETUP_LOCK' &&
    kind !== 'SETUP_CREATOR_MINT'
  ) {
    return null;
  }
  return creatorApprovalStep({
    allocation,
    mintedCount,
    paysStorage,
    setupCount: Number(SETUP_TRANSACTION_COUNT),
    pendingKind: kind,
  });
}

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
  private readonly logger = new Logger(RequestSeasonNftMintUseCase.name);
  private quoteCache?: Readonly<{ key: string; at: number; value: string }>;

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly transactions: TransactionRunner,
    private readonly seasons: SeasonNftMintQuery,
    private readonly releases: SeasonNftRepository,
    private readonly nftTransactions: NftTransactionRepository,
    private readonly transport: SeasonNftRpcTransport,
    private readonly snapshots: CanvasSnapshotFiles,
    private readonly presence: CreatorSignaturePresence,
    private readonly cosigner: NftServerCosigner,
    @Optional() private readonly storageFund?: SeasonNftStorageFund,
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
      const frozen = release != null && release.eligibleCount !== null;
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
        (release.nftDescription !== nftDescription && !frozen)
      ) {
        const revised = await this.releases.reviseMintRequest(
          {
            releaseId: release.id,
            expectedVersion: release.version,
            supply,
            nftDescription,
            creatorWalletAddress: actor.walletAddress,
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
    let walletSigned;
    try {
      walletSigned = validateWalletSignedTransaction({
        preparedBytes: owned.serializedTransaction,
        submittedBase64: signedTransactionBase64,
        expectedPayer: actor.walletAddress,
        expectedMessageHash: owned.messageHash,
      });
    } catch (error: unknown) {
      this.rejectSignature(transactionId, error);
    }
    if (owned.state === 'EXPIRED' || owned.state === 'FAILED') {
      throw new BusinessError(ErrorCodes.NftTransactionExpired);
    }
    // 지갑이 먼저 서명한 뒤에 컬렉션·발행 장치·NFT·서비스 서명을 서버가 채운다.
    let validated;
    try {
      validated = await this.cosigner.complete({
        network: owned.network,
        releaseId: owned.releaseId,
        operationKey: owned.operationKey,
        collectionAddress: owned.collectionAddress,
        candyMachineAddress: owned.candyMachineAddress,
        validated: walletSigned,
      });
    } catch (error: unknown) {
      // 서버 열쇠를 읽지 못한 실패는 제출한 거래의 잘못이 아니므로 그대로 올린다.
      if (!isSignedTransactionRejection(error)) throw error;
      this.rejectSignature(transactionId, error);
    }
    if (validated.messageHash !== owned.messageHash) {
      this.logger.log({
        event: 'season_nft.wallet_guard_accepted',
        transactionId,
        walletGuardCount: validated.walletGuardCount,
      });
    }
    const accepted = await this.transactions.run((transaction) =>
      this.nftTransactions.acceptSigned(
        {
          transactionId,
          expectedMessageHash: owned.messageHash,
          signedMessageHash: validated.messageHash,
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

  /** 서명 bytes와 인증 정보 없이 고정된 검증 실패 사유만 기록해 지갑 호환성을 진단한다. */
  private rejectSignature(transactionId: string, error: unknown): never {
    this.logger.warn({
      event: 'season_nft.signature_rejected',
      transactionId,
      reason: signedTransactionRejection(error),
    });
    throw new BusinessError(ErrorCodes.NftTransactionInvalid);
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
    if (source.release) {
      this.presence.mark(source.release.id);
      if (source.release.lastErrorCode === CREATOR_AWAITING_SIGNATURE) {
        await this.releases.resumeCreatorSignature({
          releaseId: source.release.id,
        });
      }
    }
    const eligibleCount = source.eligibility.length;
    const stored = source.release?.supply ?? null;
    // 서명을 하기 전에는 방금 고른 수량으로 견적을 다시 낸다.
    // 컬렉션 주소는 서명 전에 미리 저장되므로, 그 주소만으로 수량을 잠그지 않는다.
    const supplyLocked =
      (source.release?.creatorMintedCount ?? 0n) > 0n ||
      (source.release?.supplyCommitted ?? false);
    const requested =
      !supplyLocked && supplyText ? this.supplyFor(source, supplyText) : null;
    const supply = requested ?? stored ?? BigInt(Math.max(eligibleCount, 1));
    const allocation =
      supply - BigInt(Math.max(eligibleCount, 1)) + 1n > 0n
        ? supply - BigInt(Math.max(eligibleCount, 1)) + 1n
        : 1n;
    const imageUrl = this.imageUrl(source.imageKey);
    // 연습망(devnet)은 그림을 이 서버 주소로 쓰므로 파일 저장 비용 거래가 없다.
    const paysStorage = actor.network !== 'devnet';
    const estimatedLamports =
      eligibleCount > 0 && allocation <= BigInt(MAX_CREATOR_ALLOCATION)
        ? await this.estimate(
            Number(allocation),
            paysStorage ? source.imageBytes : null,
            paysStorage,
          )
        : null;
    const pending = source.pendingTransactions.map((item) => ({
      transactionId: item.id,
      serializedTransactionBase64:
        item.serializedTransaction.toString('base64'),
      purpose:
        item.kind === 'SETUP_CREATOR_MINT'
          ? ('CREATOR_MINT' as const)
          : ('SETUP' as const),
    }));
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
      signatureCount: creatorWalletApprovalCount({
        allocation: Number(allocation),
        setupCount: Number(SETUP_TRANSACTION_COUNT),
        paysStorage,
      }),
      step: approvalStep(
        source.pendingTransactions[0]?.kind,
        Number(allocation),
        Number(source.release?.creatorMintedCount ?? 0n),
        paysStorage,
      ),
      collectionAddress:
        source.release?.state === 'READY'
          ? source.release.collectionAddress
          : null,
      pendingTransaction: pending[0] ?? null,
      pendingTransactions: pending,
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
  private async estimate(
    allocation: number,
    imageBytes: bigint | null,
    paysStorage: boolean,
  ): Promise<string | null> {
    const key = `${allocation}:${imageBytes ?? ''}:${paysStorage}`;
    if (
      this.quoteCache?.key === key &&
      Date.now() - this.quoteCache.at < 60_000
    ) {
      return this.quoteCache.value;
    }
    const value = await this.quote(allocation, imageBytes, paysStorage);
    if (value !== null) this.quoteCache = { key, at: Date.now(), value };
    return value;
  }

  private async quote(
    allocation: number,
    imageBytes: bigint | null,
    paysStorage: boolean,
  ): Promise<string | null> {
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
        FEE_BUFFER_LAMPORTS *
        (BigInt(allocation) +
          SETUP_TRANSACTION_COUNT +
          (paysStorage ? 1n : 0n));
      if (
        imageBytes !== null &&
        imageBytes > 0n &&
        imageBytes <= BigInt(Number.MAX_SAFE_INTEGER) &&
        this.storageFund
      ) {
        const storage = await this.storageFund.quoteLamports(
          Number(imageBytes),
        );
        if (storage !== null) total += storage;
      }
      return total.toString();
    } catch {
      return null;
    }
  }
}
