import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import type { CanvasTarget } from '../../resources/canvas-definition/canvas-target';
import { CanvasDrawing } from '../../resources/canvas-drawing/canvas-drawing';
import type { CanvasRuntime } from '../../resources/canvas-drawing/canvas-runtime';
import type { BootstrapCanvasInput } from '../../resources/canvas-stroke/canvas-stroke';
import {
  type CanvasBootstrapPayload,
  type CanvasBootstrapSnapshot,
} from '../../resources/canvas-snapshot/canvas-snapshot';
import { CanvasSnapshotRepository } from '../../resources/canvas-snapshot/canvas-snapshot.repository';
import { CanvasSnapshotFiles } from '../../resources/canvas-snapshot/canvas-snapshot-files';

/** bootstrap은 같은 runtime의 epoch/head와 스냅샷 경계를 함께 고정해 반환한다. */
@Injectable()
export class BootstrapCanvasUseCase {
  constructor(
    private readonly drawing: CanvasDrawing,
    private readonly snapshots: CanvasSnapshotRepository,
    private readonly files: CanvasSnapshotFiles,
    private readonly config: ConfigService<AllConfigType>,
  ) {}

  async execute(
    input: BootstrapCanvasInput,
    target: CanvasTarget,
    runtime: CanvasRuntime,
  ): Promise<CanvasBootstrapPayload> {
    return this.drawing.readCanvas(target, async (leasedRuntime) => {
      if (leasedRuntime !== runtime || leasedRuntime.target.key !== target.key)
        throw new Error('Canvas binding target does not match its runtime.');
      const fallback = (): CanvasBootstrapPayload => {
        const { epoch, headSequence } = leasedRuntime.boundary;
        return {
          canvasKey: target.key,
          epoch,
          snapshot: null,
          baseSequence: '0',
          headSequence,
        };
      };
      const enabled =
        this.config.get('canvasSnapshot.enabled', { infer: true }) === true;
      if (!enabled || !input.preferSnapshot) return fallback();

      const persistedHead = leasedRuntime.persistedHeadSequence;
      const candidate = await this.snapshots.latestReadyForBootstrap(
        target,
        input.rendererVersion,
        persistedHead,
      );
      if (!candidate) return fallback();

      // bootstrap은 존재·크기만 확인하고, 누락된 결과는 이후 요청이 다시 고르지 않게 무효화한다.
      const checked = await this.files.validate(candidate, false);
      if (!checked) {
        await this.snapshots.invalidate(candidate.id);
        return fallback();
      }

      // 파일 I/O 뒤 같은 runtime의 최신 E/H와 저장 경계를 다시 읽어 한 응답의 순서 관계를 확인한다.
      const { epoch, headSequence } = leasedRuntime.boundary;
      const currentPersistedHead = leasedRuntime.persistedHeadSequence;
      if (
        BigInt(candidate.throughSequence) > BigInt(currentPersistedHead) ||
        BigInt(currentPersistedHead) > BigInt(headSequence)
      )
        throw new Error('Canvas bootstrap boundary changed inconsistently.');

      const snapshot: CanvasBootstrapSnapshot = {
        snapshotId: candidate.id,
        canvasKey: target.key,
        throughSequence: candidate.throughSequence,
        imageUrl: this.files.publicUrl(candidate.imageKey),
        imageSha256: candidate.imageSha256,
        width: candidate.width,
        height: candidate.height,
        rendererVersion: candidate.rendererVersion,
        continuationStateUrl: this.files.publicUrl(candidate.continuationKey),
        continuationStateSha256: candidate.continuationSha256,
        capturedAt: candidate.capturedAt.toISOString(),
      };
      return {
        canvasKey: target.key,
        epoch,
        snapshot,
        baseSequence: candidate.throughSequence,
        headSequence,
      };
    });
  }
}
