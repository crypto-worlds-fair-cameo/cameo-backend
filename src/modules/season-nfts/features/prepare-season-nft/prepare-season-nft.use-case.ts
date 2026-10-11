import { createHash } from 'node:crypto';
import { publicKey, type PublicKey } from '@metaplex-foundation/umi';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import bs58 from 'bs58';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import {
  FinalCanvasSnapshotInvalidError,
  FinalCanvasSnapshotReader,
} from '../../../canvas/resources/canvas-snapshot/final-canvas-snapshot-reader';
import { SeasonNftInternalErrorCodes } from '../../resources/season-nft/season-nft.error-codes';
import { SeasonNftRepository } from '../../resources/season-nft/season-nft.repository';
import type { SeasonNftNetwork } from '../../resources/season-nft/season-nft';
import {
  buildAssetName,
  serializeSeasonMetadata,
} from '../../resources/nft-media/season-nft-metadata';
import {
  TurboMediaPermanentError,
  TurboMediaPublisher,
} from '../../resources/nft-media/turbo-media-publisher';
import { withDbOnlyRetry } from '../../resources/nft-worker/db-only-retry';
import {
  SeasonNftCandidatesQuery,
  type SeasonNftEligibilitySourceRow,
} from './season-nft-candidates.query';
import { SeasonNftMerkleArtifacts } from './season-nft-merkle-artifacts';

export type PrepareSeasonNftResult = Readonly<{
  releaseId: string;
  status: 'WAITING_SNAPSHOT' | 'FROZEN' | 'EMPTY' | 'BLOCKED' | 'RETRY';
}>;

export type PrepareSeasonNftMediaResult = Readonly<{
  releaseId: string;
  status:
    | 'WAITING_SNAPSHOT'
    | 'IMAGE'
    | 'METADATA'
    | 'READY'
    | 'EMPTY'
    | 'BLOCKED'
    | 'RETRY';
}>;

type ValidEligibility = Readonly<{
  userId: string;
  walletAccountId: string;
  walletAddress: string;
  publicKey: PublicKey;
}>;

function validateEligibility(
  rows: readonly SeasonNftEligibilitySourceRow[],
): ValidEligibility[] | null {
  if (rows.length > 100) return null;
  const wallets = new Set<string>();
  const valid: ValidEligibility[] = [];
  for (const row of rows) {
    if (
      row.participantUserId !== row.userId ||
      row.walletAccountId === null ||
      row.walletAddress === null ||
      row.verifiedWalletId !== row.walletAccountId ||
      row.walletUserId !== row.userId ||
      row.verifiedAddress !== row.walletAddress ||
      row.chainNamespace !== 'solana' ||
      wallets.has(row.walletAddress)
    ) {
      return null;
    }
    try {
      if (bs58.decode(row.walletAddress).length !== 32) return null;
      valid.push({
        userId: row.userId,
        walletAccountId: row.walletAccountId,
        walletAddress: row.walletAddress,
        publicKey: publicKey(row.walletAddress),
      });
    } catch {
      return null;
    }
    wallets.add(row.walletAddress);
  }
  // SDK 입력 순서는 locale 설정과 무관한 Base58 ASCII 코드 단위로 고정한다.
  return valid.sort((left, right) =>
    left.walletAddress < right.walletAddress
      ? -1
      : left.walletAddress > right.walletAddress
        ? 1
        : 0,
  );
}

/** 최종 PNG와 자격 자료를 lock 밖에서 준비하고 commit 직전 원본 재검증을 조정한다. */
@Injectable()
export class PrepareSeasonNftUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly transactions: TransactionRunner,
    private readonly releases: SeasonNftRepository,
    private readonly candidates: SeasonNftCandidatesQuery,
    private readonly snapshots: FinalCanvasSnapshotReader,
    private readonly merkleArtifacts: SeasonNftMerkleArtifacts,
    @Optional() private readonly mediaPublisher?: TurboMediaPublisher,
  ) {}

  /** 정상 종료 시즌 하나를 idempotent release로 만들고 final snapshot이 있으면 한 번 동결한다. */
  async execute(seasonId: string): Promise<PrepareSeasonNftResult> {
    const enabled = this.config.get('seasonNft.enabled', { infer: true });
    const network = this.config.get('seasonNft.network', { infer: true });
    if (!enabled || !network)
      throw new Error('Season NFT preparation is disabled.');
    const candidate = await withDbOnlyRetry(() =>
      this.transactions.run((transaction) =>
        this.releases.insertCandidate(
          { seasonId, network: network as SeasonNftNetwork },
          transaction,
        ),
      ),
    );

    // 이미 동결하거나 차단한 release는 원본 파일과 변경된 시즌 값을 다시 읽지 않는다.
    if (candidate.state === 'EMPTY')
      return { releaseId: candidate.releaseId, status: 'EMPTY' };
    if (candidate.state === 'BLOCKED')
      return { releaseId: candidate.releaseId, status: 'BLOCKED' };
    if (candidate.stage !== 'SNAPSHOT')
      return { releaseId: candidate.releaseId, status: 'FROZEN' };

    let snapshot;
    try {
      snapshot = await this.snapshots.read(seasonId);
    } catch (error: unknown) {
      if (!(error instanceof FinalCanvasSnapshotInvalidError)) throw error;
      const blocked = await this.block(
        candidate.releaseId,
        candidate.version,
        SeasonNftInternalErrorCodes.FinalSnapshotInvalid,
        'Final canvas snapshot validation failed.',
      );
      return {
        releaseId: candidate.releaseId,
        status: blocked ? 'BLOCKED' : 'RETRY',
      };
    }
    if (!snapshot) {
      const deferred = await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.releases.deferSnapshot(
            {
              releaseId: candidate.releaseId,
              expectedVersion: candidate.version,
            },
            transaction,
          ),
        ),
      );
      return {
        releaseId: candidate.releaseId,
        status: deferred.updated ? 'WAITING_SNAPSHOT' : 'RETRY',
      };
    }

    const source = await this.candidates.readFreezeSource(seasonId);
    if (!source) {
      const blocked = await this.block(
        candidate.releaseId,
        candidate.version,
        SeasonNftInternalErrorCodes.SourceIneligible,
        'Season NFT source is no longer eligible.',
      );
      return {
        releaseId: candidate.releaseId,
        status: blocked ? 'BLOCKED' : 'RETRY',
      };
    }
    const eligibility = validateEligibility(source.eligibility);
    const keys = eligibility?.map((member) => member.publicKey) ?? [];
    // 유효 명단은 같은 SDK 계산을 두 번 대조한 뒤 첫 결과만 immutable freeze에 전달한다.
    const artifacts = eligibility ? this.merkleArtifacts.build(keys) : null;
    const claims =
      eligibility?.map((member, index) => ({
        userId: member.userId,
        walletAccountId: member.walletAccountId,
        walletAddress: member.walletAddress,
        merkleProof: artifacts?.merkleProofs[index] ?? [],
      })) ?? [];
    const merkleRoot = artifacts?.merkleRoot ?? null;

    const frozen = await withDbOnlyRetry(() =>
      this.transactions.run((transaction) =>
        this.releases.freeze(
          {
            releaseId: candidate.releaseId,
            expectedVersion: candidate.version,
            snapshotId: snapshot.snapshotId,
            throughSequence: snapshot.throughSequence,
            imageByteLength: snapshot.byteLength,
            imageSha256: snapshot.imageSha256,
            frozenTitle: source.title,
            frozenDescription: source.description,
            seasonEndedAt: source.endedAt,
            eligibilityRows: source.eligibility,
            merkleRoot,
            claims,
          },
          transaction,
        ),
      ),
    );
    // CAS 패배와 원본 변경 모두 이 worker의 계산 결과를 공개하지 않고 다시 읽게 한다.
    if (!frozen.updated)
      return { releaseId: candidate.releaseId, status: 'RETRY' };
    if (frozen.reason === 'BLOCKED')
      return { releaseId: candidate.releaseId, status: 'BLOCKED' };
    return {
      releaseId: candidate.releaseId,
      status: claims.length === 0 ? 'EMPTY' : 'FROZEN',
    };
  }

  /** frozen release의 현재 media stage 하나만 게시해 storage worker가 chain lane과 분리해 예약하게 한다. */
  async prepareMedia(
    releaseId: string,
    io: Readonly<{ signal: AbortSignal; assertMayStart: () => void }> = {
      signal: new AbortController().signal,
      assertMayStart: () => {},
    },
  ): Promise<PrepareSeasonNftMediaResult> {
    const enabled = this.config.get('seasonNft.enabled', { infer: true });
    if (!enabled) throw new Error('Season NFT preparation is disabled.');
    if (!this.mediaPublisher)
      throw new Error('Season NFT media publisher is unavailable.');
    const source = await this.releases.findMediaSource(releaseId);
    if (!source) throw new Error('Season NFT release was not found.');
    // EMPTY/WAITING/READY는 storage 작업 대상이 아니므로 snapshot·서명·업로드 전에 끝낸다.
    if (source.state === 'EMPTY') return { releaseId, status: 'EMPTY' };
    if (source.state === 'BLOCKED') return { releaseId, status: 'BLOCKED' };
    if (source.state === 'READY') return { releaseId, status: 'READY' };
    if (source.state === 'WAITING_SNAPSHOT')
      return { releaseId, status: 'WAITING_SNAPSHOT' };
    if (source.state !== 'PREPARING') return { releaseId, status: 'RETRY' };
    if (source.stage === 'IMAGE') return this.publishMetadata(source, io);
    if (source.stage === 'SNAPSHOT')
      return { releaseId, status: 'WAITING_SNAPSHOT' };
    if (source.stage !== 'FROZEN') return { releaseId, status: 'METADATA' };

    let snapshot;
    try {
      snapshot = await this.snapshots.read(source.seasonId);
    } catch (error: unknown) {
      if (!(error instanceof FinalCanvasSnapshotInvalidError)) throw error;
      return this.blockMedia(
        source.releaseId,
        source.version,
        SeasonNftInternalErrorCodes.FinalSnapshotInvalid,
        'Frozen canvas snapshot validation failed.',
      );
    }
    // media 재읽기는 frozen snapshot ID/head/hash/length와 모두 같아야 하며 새 final snapshot을 대체하지 않는다.
    if (
      !snapshot ||
      source.snapshotId === null ||
      source.throughSequence === null ||
      source.imageByteLength === null ||
      source.imageSha256 === null ||
      snapshot.snapshotId !== source.snapshotId ||
      snapshot.throughSequence !== source.throughSequence ||
      snapshot.byteLength !== source.imageByteLength ||
      snapshot.imageSha256 !== source.imageSha256
    ) {
      return this.blockMedia(
        source.releaseId,
        source.version,
        SeasonNftInternalErrorCodes.FinalSnapshotInvalid,
        'Frozen canvas snapshot identity changed before media publication.',
      );
    }
    const imageByteLength = source.imageByteLength;
    const imageSha256 = source.imageSha256;

    try {
      const published = await this.mediaPublisher.publish(
        {
          releaseId: source.releaseId,
          kind: 'IMAGE',
          bytes: snapshot.pngBytes,
          sha256: imageSha256,
        },
        io,
      );
      const advanced = await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.releases.advanceStage(
            {
              releaseId: source.releaseId,
              expectedVersion: source.version,
              expectedStage: 'FROZEN',
              nextStage: 'IMAGE',
              imageByteLength,
              imageSha256,
              imageUri: published.uri,
            },
            transaction,
          ),
        ),
      );
      return {
        releaseId: source.releaseId,
        status: advanced.updated ? 'IMAGE' : 'RETRY',
      };
    } catch (error: unknown) {
      if (!(error instanceof TurboMediaPermanentError)) throw error;
      return this.blockMedia(
        source.releaseId,
        source.version,
        error.code,
        error.message,
      );
    }
  }

  /** IMAGE checkpoint의 canonical URI로 deterministic JSON을 만들고 METADATA checkpoint 하나만 고정한다. */
  private async publishMetadata(
    source: NonNullable<
      Awaited<ReturnType<SeasonNftRepository['findMediaSource']>>
    >,
    io: Readonly<{ signal: AbortSignal; assertMayStart: () => void }>,
  ): Promise<PrepareSeasonNftMediaResult> {
    if (
      !this.mediaPublisher ||
      source.frozenTitle === null ||
      source.seasonEndedAt === null ||
      source.eligibleCount === null ||
      source.imageUri === null ||
      source.imageSha256 === null
    ) {
      return this.blockMedia(
        source.releaseId,
        source.version,
        SeasonNftInternalErrorCodes.MediaSourceInvalid,
        'Frozen metadata source is incomplete.',
      );
    }
    const frozenTitle = source.frozenTitle;
    const bytes = Buffer.from(
      serializeSeasonMetadata({
        seasonId: source.seasonId,
        title: frozenTitle,
        description: source.frozenDescription,
        endedAt: source.seasonEndedAt.toISOString(),
        contributors: source.eligibleCount,
        imageUri: source.imageUri,
        imageSha256: source.imageSha256,
      }),
    );
    const metadataSha256 = createHash('sha256').update(bytes).digest('hex');
    try {
      const published = await this.mediaPublisher.publish(
        {
          releaseId: source.releaseId,
          kind: 'METADATA',
          bytes,
          sha256: metadataSha256,
        },
        io,
      );
      const advanced = await withDbOnlyRetry(() =>
        this.transactions.run((transaction) =>
          this.releases.advanceStage(
            {
              releaseId: source.releaseId,
              expectedVersion: source.version,
              expectedStage: 'IMAGE',
              nextStage: 'METADATA',
              assetName: buildAssetName(frozenTitle),
              metadataSha256,
              metadataUri: published.uri,
            },
            transaction,
          ),
        ),
      );
      return {
        releaseId: source.releaseId,
        status: advanced.updated ? 'METADATA' : 'RETRY',
      };
    } catch (error: unknown) {
      if (!(error instanceof TurboMediaPermanentError)) throw error;
      return this.blockMedia(
        source.releaseId,
        source.version,
        error.code,
        error.message,
      );
    }
  }

  /** deterministic media 오류만 release에 기록하며 CAS 패배는 다음 worker 재조회로 넘긴다. */
  private async blockMedia(
    releaseId: string,
    expectedVersion: bigint,
    errorCode: string,
    errorMessage: string,
  ): Promise<PrepareSeasonNftMediaResult> {
    const blocked = await this.block(
      releaseId,
      expectedVersion,
      errorCode,
      errorMessage,
    );
    return { releaseId, status: blocked ? 'BLOCKED' : 'RETRY' };
  }

  /** snapshot 또는 시즌 원본 손상을 frozen 값 없이 BLOCKED 상태로 기록한다. */
  private async block(
    releaseId: string,
    expectedVersion: bigint,
    errorCode: string,
    errorMessage: string,
  ): Promise<boolean> {
    const result = await withDbOnlyRetry(() =>
      this.transactions.run((transaction) =>
        this.releases.block(
          {
            releaseId,
            expectedVersion,
            errorCode,
            errorMessage,
            nextAttemptAt: new Date(),
          },
          transaction,
        ),
      ),
    );
    return result.updated;
  }
}
