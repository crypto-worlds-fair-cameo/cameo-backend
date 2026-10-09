import { randomUUID } from 'node:crypto';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '../../../../config/config.type';
import { LoggerService } from '../../../../logging/logger.service';
import { CanvasDrawing } from '../canvas-drawing/canvas-drawing';
import { CanvasChunkRepository } from '../canvas-drawing/canvas-chunk.repository';
import type { CanvasTarget } from '../canvas-definition/canvas-target';
import { CanvasSnapshotRepository } from './canvas-snapshot.repository';
import {
  CanvasSnapshotPublicationRejected,
  type CanvasSnapshotPublishInput,
} from './canvas-snapshot';
import { CanvasSnapshotFiles } from './canvas-snapshot-files';
import {
  CanvasSnapshotRenderer,
  SNAPSHOT_RENDERER_VERSION,
} from './canvas-snapshot-renderer';

/** DB를 재탐색하는 단일 실행기다. 실패 작업 목록과 과거 좌표를 메모리에 누적하지 않는다. */
@Injectable()
export class CanvasSnapshotRunner
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private detach?: () => void;
  private closing = false;
  private work?: Promise<void>;
  private periodicRequested = false;
  private finalRequested = false;
  private bucket = -1;
  private nextFinal = 0;
  private activeId?: string;
  private inspectingFinal = false;
  private publication?: CanvasSnapshotPublishInput;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private failureWindow = 0;
  private failureCount = 0;
  private auditAfter?: string;

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly drawing: CanvasDrawing,
    private readonly chunks: CanvasChunkRepository,
    private readonly snapshots: CanvasSnapshotRepository,
    private readonly files: CanvasSnapshotFiles,
    private readonly renderer: CanvasSnapshotRenderer,
    private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get('canvasSnapshot.enabled', { infer: true }) !== true)
      return;
    await this.files.initialize();
    await this.renderer.initialize();
    this.detach = this.drawing.onLifecycleChange(() => {
      // 캡처 자체의 lifecycle 확인이 즉시 재시도를 반복하지 않게 한다.
      if (this.inspectingFinal || this.closing) return;
      this.finalRequested = true;
      this.schedule();
    });
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tick();
  }

  /** 주기 경계와 60초 종료 재탐색 요청을 각각 플래그 하나로 합친다. */
  private tick(): void {
    if (this.closing) return;
    const interval =
      this.config.get('canvasSnapshot.intervalSeconds', { infer: true }) ??
      3600;
    const now = Date.now();
    const bucket = Math.floor(now / 1000 / interval);
    if (bucket !== this.bucket) {
      this.bucket = bucket;
      this.periodicRequested = true;
    }
    if (now >= this.nextFinal) {
      this.nextFinal = now + 60_000;
      this.finalRequested = true;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.closing || this.work || this.retryTimer) return;
    if (!this.finalRequested && !this.periodicRequested && !this.publication)
      return;
    let failed = false;
    this.work = this.run()
      .catch((error) => {
        failed = true;
        this.failure(error);
      })
      .finally(() => {
        this.work = undefined;
        if (this.closing) return;
        // DB 미확정·대상 조회 장애는 tick이 즉시 재실행하지 못하게 제한된 backoff를 둔다.
        if (
          failed &&
          (this.publication || this.finalRequested || this.periodicRequested)
        ) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            this.schedule();
          }, 60_000);
          this.retryTimer.unref();
        } else {
          if (this.finalRequested || this.periodicRequested) this.schedule();
        }
      });
  }

  /** 종료 한 순회 뒤 주기 순회도 처리해 실패 시즌이 일반 캡처를 굶기지 않게 한다. */
  private async run(): Promise<void> {
    await this.confirmPublication();
    if (this.finalRequested) {
      await this.captureFinalTargets();
    }
    if (this.periodicRequested && !this.closing) {
      // 주기 순회 실패는 다음 bucket에서 다시 시도한다. 종료·DB 미확정만 별도 재시도한다.
      this.periodicRequested = false;
      // 초과 예산을 만든 오래된 orphan도 먼저 제거해 저장 작업이 스스로 회복할 수 있게 한다.
      await this.files.cleanup(
        (key) => this.snapshots.hasReference(key),
        this.publication?.id,
      );
      await this.files.refreshCapacity();
      await this.captureTargets(false);
      await this.audit();
    }
  }

  /** 대상 조회가 실패해도 종료 요청을 소모하지 않고 backoff 뒤 같은 순회를 다시 시도한다. */
  private async captureFinalTargets(): Promise<void> {
    this.finalRequested = false;
    try {
      await this.captureTargets(true);
    } catch (error) {
      this.finalRequested = true;
      throw error;
    }
  }

  private async captureTargets(final: boolean): Promise<void> {
    let after: string | undefined;
    while (!this.closing) {
      const targets = await this.snapshots.targets(after, final);
      if (!targets.length) break;
      for (const target of targets) {
        if (this.closing) return;
        try {
          await this.capture(target, final);
        } catch (error) {
          this.failure(error, target.id);
          // DB 확정이 불명확한 파일 하나를 보존하고 새 orphan 생성은 멈춘다.
          if (this.publication) throw error;
        }
        if (!final && this.finalRequested && !this.closing) {
          await this.captureFinalTargets();
        }
      }
      after = targets.at(-1)!.id;
    }
  }

  /** 종료 gate를 통과한 뒤 저장 경계를 고정한다. 렌더링 동안 입력 gate는 점유하지 않는다. */
  private async capture(target: CanvasTarget, final: boolean): Promise<void> {
    if (final) {
      this.inspectingFinal = true;
      try {
        await this.drawing.prepareFinalSnapshot(target.id);
      } finally {
        this.inspectingFinal = false;
      }
    }
    const { headSequence } = await this.chunks.initializeTarget(target);
    const existing = await this.snapshots.latestReadyForBootstrap(
      target,
      SNAPSHOT_RENDERER_VERSION,
      headSequence,
    );
    if (existing && existing.throughSequence === headSequence) {
      if (await this.files.validate(existing, true)) {
        if (final && !existing.isFinal)
          await this.snapshots.publish({
            ...existing,
            target,
            isFinal: true,
            imageBytes: Number(existing.imageBytes),
            continuationBytes: Number(existing.continuationBytes),
            continuationSchemaVersion: 1,
          });
        return;
      }
      await this.snapshots.invalidate(existing.id);
    }
    if (!final && headSequence === '0') return;
    const id = randomUUID();
    const capturedAt = new Date();
    this.activeId = id;
    try {
      const result = await this.renderer.render(target, headSequence);
      const continuation = Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          snapshotId: id,
          canvasKey: target.key,
          throughSequence: headSequence,
          rendererVersion: SNAPSHOT_RENDERER_VERSION,
          strokes: result.strokes,
        }),
      );
      if (this.closing) return;
      const output = await this.files.publish(
        target,
        id,
        headSequence,
        SNAPSHOT_RENDERER_VERSION,
        result.image,
        continuation,
        capturedAt,
      );
      if (this.closing) return;
      this.publication = {
        ...output,
        id,
        target,
        throughSequence: headSequence,
        rendererVersion: SNAPSHOT_RENDERER_VERSION,
        capturedAt,
        isFinal: final,
      };
      await this.confirmPublication();
      this.logger.log('Canvas snapshot published', {
        event: 'canvas.snapshot.published',
        canvasId: target.id,
        snapshotId: id,
        throughSequence: headSequence,
        final,
        elapsedMs: result.elapsedMs,
        peakBytes: result.peakBytes,
      });
    } finally {
      this.activeId = undefined;
    }
  }

  /** 파일 공개 뒤 DB 응답을 잃으면 같은 ID를 재확인하고 같은 메타데이터만 다시 확정한다. */
  private async confirmPublication(): Promise<void> {
    const pending = this.publication;
    if (!pending) return;
    try {
      const existing = await this.snapshots.findPublished(pending.id);
      if (existing?.status === 'INVALID') {
        this.publication = undefined;
        throw new CanvasSnapshotPublicationRejected(
          'Pending canvas snapshot was invalidated.',
        );
      }
      await this.snapshots.publish(pending);
      this.publication = undefined;
    } catch (error) {
      if (error instanceof CanvasSnapshotPublicationRejected)
        this.publication = undefined;
      throw error;
    }
  }

  /** 주기 감사는 청크 변화와 무관하게 종료 결과까지 검사한다. */
  private async audit(): Promise<void> {
    while (!this.closing) {
      const records = await this.snapshots.readyPage(this.auditAfter);
      if (!records.length) {
        this.auditAfter = undefined;
        return;
      }
      for (const record of records) {
        if (this.closing) return;
        try {
          if (!(await this.files.validate(record, true)))
            await this.snapshots.invalidate(record.id);
        } catch (error) {
          this.failure(error, record.canvasId);
        }
      }
      this.auditAfter = records.at(-1)!.id;
      // 긴 감사 도중의 종료 요청도 한 순회 처리한다.
      if (this.finalRequested && !this.closing) {
        await this.captureFinalTargets();
      }
      // 다음 주기가 도착하면 감사 cursor만 보존하고 새 캡처 순회에 양보한다.
      if (this.periodicRequested) return;
    }
  }

  private failure(error: unknown, canvasId?: string): void {
    const now = Date.now();
    if (now - this.failureWindow >= 60_000) {
      if (this.failureCount > 10)
        this.logger.warn('Canvas snapshot failures suppressed', {
          event: 'canvas.snapshot.failures.suppressed',
          count: this.failureCount - 10,
        });
      this.failureWindow = now;
      this.failureCount = 0;
    }
    // 저장소 전체 장애도 캔버스별 무제한 로그나 오류 목록으로 누적하지 않는다.
    if (++this.failureCount > 10) return;
    this.logger.error('Canvas snapshot operation failed', {
      event: 'canvas.snapshot.failed',
      canvasId,
      reason: error instanceof Error ? error.message : 'Unknown failure',
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    this.detach?.();
    await this.renderer.stop();
    await this.work;
  }
}
