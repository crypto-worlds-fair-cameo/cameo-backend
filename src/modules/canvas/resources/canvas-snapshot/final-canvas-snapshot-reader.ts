import { Injectable } from '@nestjs/common';
import {
  CanvasSnapshotFiles,
  CanvasSnapshotFileValidationError,
} from './canvas-snapshot-files';
import {
  CanvasSnapshotRepository,
  FinalReadyCanvasSnapshotMetadataError,
} from './canvas-snapshot.repository';

export type FinalSnapshot = Readonly<{
  canvasId: string;
  snapshotId: string;
  throughSequence: bigint;
  pngBytes: Uint8Array;
  imageSha256: string;
  byteLength: bigint;
}>;

/** 확정 스냅샷의 DB 경계와 저장 PNG를 검증해 NFT 모듈에 읽기 전용 결과만 제공한다. */
export class FinalCanvasSnapshotInvalidError extends Error {
  readonly code = 'NFT_FINAL_SNAPSHOT_INVALID';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = FinalCanvasSnapshotInvalidError.name;
  }
}

@Injectable()
export class FinalCanvasSnapshotReader {
  constructor(
    private readonly snapshots: CanvasSnapshotRepository,
    private readonly files: CanvasSnapshotFiles,
  ) {}

  /** FINAL+READY가 없으면 null을 반환하고, 있으면 현재 head와 PNG 원본까지 검증한다. */
  async read(canvasId: string): Promise<FinalSnapshot | null> {
    let found;
    try {
      found = await this.snapshots.findFinalReady(canvasId);
    } catch (error: unknown) {
      if (!(error instanceof FinalReadyCanvasSnapshotMetadataError))
        throw error;
      throw new FinalCanvasSnapshotInvalidError(
        'Final canvas snapshot metadata is invalid.',
        { cause: error },
      );
    }
    // FINAL+READY 행이 없는 시즌만 아직 준비되지 않은 결과로 취급한다.
    if (!found) return null;

    const { snapshot, lastChunkSequence } = found;
    const expectedImageKey = `snapshots/seasons/${canvasId.toLowerCase()}/${snapshot.id.toLowerCase()}/image.png`;
    if (
      snapshot.canvasId !== canvasId ||
      snapshot.imageKey !== expectedImageKey
    ) {
      throw new FinalCanvasSnapshotInvalidError(
        'Final canvas snapshot does not match its canvas.',
      );
    }
    const throughSequence = BigInt(snapshot.throughSequence);
    if (throughSequence !== BigInt(lastChunkSequence)) {
      throw new FinalCanvasSnapshotInvalidError(
        'Final canvas snapshot does not match the current chunk head.',
      );
    }

    try {
      // 파일 I/O와 SHA-256 계산은 NFT freeze 트랜잭션을 열기 전에 끝낸다.
      const pngBytes = await this.files.readImage(snapshot);
      return {
        canvasId,
        snapshotId: snapshot.id,
        throughSequence,
        pngBytes,
        imageSha256: snapshot.imageSha256,
        byteLength: BigInt(pngBytes.byteLength),
      };
    } catch (error: unknown) {
      if (!(error instanceof CanvasSnapshotFileValidationError)) throw error;
      const detail = error instanceof Error ? error.message.toLowerCase() : '';
      const reason = detail.includes('hash') ? 'hash' : 'file';
      throw new FinalCanvasSnapshotInvalidError(
        `Final canvas snapshot ${reason} is invalid.`,
        { cause: error },
      );
    }
  }
}
