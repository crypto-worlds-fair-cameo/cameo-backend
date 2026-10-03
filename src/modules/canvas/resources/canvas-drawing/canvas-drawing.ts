import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  CanvasStrokeError,
  STROKE_LIMITS,
  type AppendStrokeInput,
  type AppendStrokeResult,
  type CanvasSyncPage,
  type StrokePreview,
  type SyncCanvasInput,
} from '../canvas-stroke/canvas-stroke';

type StrokeState = { last: StrokePreview; signature: string };

/** 한 프로세스의 좌표 묶음과 획별 인증 상태를 보관하며 재시작 시 모두 초기화한다. */
@Injectable()
export class CanvasDrawing implements OnModuleDestroy {
  private readonly epoch = randomUUID();
  private readonly previews: StrokePreview[] = [];
  private readonly strokes = new Map<string, StrokeState>();
  private readonly authorizations = new Map<
    string,
    { clientStrokeId: string; userId: string }
  >();
  private bytes = 0;

  /** 같은 연결·같은 획의 시작에서 확인한 사용자만 중간 전송에 재사용한다. */
  cachedUser(connectionId: string, clientStrokeId: string): string | undefined {
    const cached = this.authorizations.get(connectionId);
    return cached?.clientStrokeId === clientStrokeId
      ? cached.userId
      : undefined;
  }

  /** 순서대로 받은 묶음만 메모리에 추가하고 동일한 재전송은 원래 결과를 반환한다. */
  append(
    connectionId: string,
    userId: string,
    input: AppendStrokeInput,
  ): AppendStrokeResult {
    const key = `${userId}:${input.clientStrokeId}`;
    const previous = this.strokes.get(key);
    const signature = JSON.stringify(input);
    if (previous) {
      // 브러시는 획 도중 바꾸지 않고, 완료를 포함한 마지막 묶음의 재전송은 중복 반영하지 않는다.
      if (JSON.stringify(previous.last.brush) !== JSON.stringify(input.brush))
        throw new CanvasStrokeError(
          'INVALID_STROKE',
          'Brush cannot change during a stroke.',
        );
      if (input.chunkIndex === previous.last.chunkIndex) {
        if (signature !== previous.signature)
          throw new CanvasStrokeError(
            'INVALID_STROKE',
            'Chunk index has already been used with different data.',
          );
        return { accepted: false, preview: previous.last };
      }
      if (previous.last.isFinal)
        throw new CanvasStrokeError(
          'STROKE_CLOSED',
          'Stroke has already ended.',
        );
      if (input.chunkIndex !== previous.last.chunkIndex + 1)
        throw new CanvasStrokeError(
          'INVALID_STROKE',
          'Stroke chunks must be sent in order.',
        );
    } else if (input.chunkIndex !== 0 || input.points.length === 0) {
      // 최초 묶음은 좌표를 포함한 0번이어야 누락 없이 재생할 수 있다.
      throw new CanvasStrokeError(
        'INVALID_STROKE',
        'Stroke must start with chunk zero and at least one point.',
      );
    }
    const preview: StrokePreview = {
      canvasKey: 'main',
      userId,
      epoch: this.epoch,
      sequence: String(this.previews.length + 1),
      ...input,
    };
    const bytes = Buffer.byteLength(JSON.stringify(preview));
    // 이전 그림을 조용히 버리지 않고 용량 초과를 거절해 sync의 전체 복구 의미를 유지한다.
    if (
      this.previews.length >= STROKE_LIMITS.retainedChunks ||
      this.bytes + bytes > STROKE_LIMITS.retainedBytes
    )
      throw new CanvasStrokeError(
        'CANVAS_CAPACITY_REACHED',
        'Canvas memory capacity has been reached.',
      );
    this.previews.push(preview);
    this.bytes += bytes;
    this.strokes.set(key, { last: preview, signature });
    if (input.isFinal) this.authorizations.delete(connectionId);
    else
      this.authorizations.set(connectionId, {
        clientStrokeId: input.clientStrokeId,
        userId,
      });
    return { accepted: true, preview };
  }

  /** 동일한 메모리 세대의 순서 범위만 복구하며 재시작 전 cursor는 처음부터 다시 읽는다. */
  page(input: SyncCanvasInput & { limit: number }): CanvasSyncPage {
    const reset = input.epoch !== this.epoch;
    const after = reset ? 0n : BigInt(input.afterSequence);
    const head =
      !reset && input.throughSequence !== undefined
        ? BigInt(input.throughSequence)
        : BigInt(this.previews.length);
    if (after > head || head > BigInt(this.previews.length))
      throw new CanvasStrokeError(
        'INVALID_SYNC',
        'Canvas sync cursor is invalid.',
      );
    const previews: StrokePreview[] = [];
    let bytes = 0;
    for (
      let index = Number(after);
      index < Number(head) && previews.length < input.limit;
      index++
    ) {
      const preview = this.previews[index];
      const size = Buffer.byteLength(JSON.stringify(preview));
      if (previews.length > 0 && bytes + size > STROKE_LIMITS.syncPageBytes)
        break;
      previews.push(preview);
      bytes += size;
    }
    const nextSequence = previews.at(-1)?.sequence ?? String(after);
    return {
      canvasKey: 'main',
      epoch: this.epoch,
      reset,
      previews,
      headSequence: String(head),
      nextSequence,
      hasMore: BigInt(nextSequence) < head,
    };
  }

  /** 연결 종료 시 인증 캐시만 지우고 다른 사용자가 복구할 좌표는 유지한다. */
  disconnect(connectionId: string): void {
    this.authorizations.delete(connectionId);
  }

  /** 프로세스의 그림과 연결 권한은 영속화하지 않고 모듈 종료 시 함께 비운다. */
  onModuleDestroy(): void {
    this.previews.length = 0;
    this.strokes.clear();
    this.authorizations.clear();
    this.bytes = 0;
  }
}
