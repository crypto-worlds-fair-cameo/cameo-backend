import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import {
  CanvasChunkRepository,
  type StoredChunk,
} from './canvas-chunk.repository';
import {
  CanvasStrokeError,
  STROKE_LIMITS,
  type AppendStrokeInput,
  type AppendStrokeResult,
  type CanvasSyncPage,
  type StrokePreview,
  type SyncCanvasInput,
} from '../canvas-stroke/canvas-stroke';

type StrokeState = StoredChunk & { signature: string; bytes: number };
export type PreparedStroke = {
  isNewStroke: boolean;
  accepted: boolean;
  usageId?: string;
  preview: StrokePreview;
  deferred?: boolean;
  commit: (usageId?: string, persisted?: boolean) => AppendStrokeResult;
  cancel: () => void;
};

/** 단일 서버의 순서와 제한된 저장 대기열·캐시를 소유하고 과거 그림은 DB에서 복구한다. */
@Injectable()
export class CanvasDrawing implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CanvasDrawing.name);
  private readonly epoch = randomUUID();
  private canvasId = '';
  private head = 0n;
  private persistedHead = 0n;
  private readonly queue: StoredChunk[] = [];
  private queueBytes = 0;
  private readonly recent = new Map<string, StrokePreview>();
  private recentBytes = 0;
  private readonly strokes = new Map<string, StrokeState>();
  private stateBytes = 0;
  private readonly authorizations = new Map<
    string,
    { clientStrokeId: string; userId: string }
  >();
  private appendWork: Promise<unknown> = Promise.resolve();
  private storageWork: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  private timerFlushRunning = false;
  private recovery?: () => Promise<void>;
  private recoveryWork?: Promise<void>;
  private readonly activeConnections = new Set<string>();

  constructor(
    private readonly chunks: CanvasChunkRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** DB의 저장 경계를 읽고 준비가 끝난 이후에만 소켓 서버가 열리게 한다. */
  async onModuleInit(): Promise<void> {
    const state = await this.chunks.initialize();
    this.canvasId = state.canvasId;
    this.head = this.persistedHead = BigInt(state.headSequence);
    this.scheduleFlush();
  }

  /** 순서 할당·첫 승인·완료 승인을 직렬화하며 실패한 작업은 다음 요청을 막지 않는다. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(this.unavailable());
    const result = this.appendWork.then(async () => {
      await this.ensureRecovered();
      return operation();
    });
    this.appendWork = result.catch(() => {});
    return result;
  }

  /** 같은 연결에서 시작을 승인한 획만 중간 전송에 인증 결과를 재사용한다. */
  cachedUser(connectionId: string, clientStrokeId: string): string | undefined {
    const state = this.authorizations.get(connectionId);
    return state?.clientStrokeId === clientStrokeId ? state.userId : undefined;
  }

  /** bounded 캐시, 미저장 대기열, DB 순서로 마지막 묶음을 찾아 재접속도 검증한다. */
  private async latest(
    userId: string,
    strokeId: string,
  ): Promise<StrokeState | undefined> {
    const key = `${userId}:${strokeId}`;
    const cached = this.strokes.get(key);
    if (cached) {
      this.strokes.delete(key);
      this.strokes.set(key, cached);
      return cached;
    }
    // 캐시에서 제거됐어도 미저장 좌표가 있으면 DB의 오래된 마지막 묶음을 사용하지 않는다.
    const pending = this.queue.findLast(
      (chunk) =>
        chunk.preview.userId === userId &&
        chunk.preview.clientStrokeId === strokeId,
    );
    const stored =
      pending ??
      (await this.chunks.latest(this.canvasId, userId, strokeId, this.epoch));
    if (!stored) return undefined;
    return this.rememberStroke(key, stored);
  }

  /** DB 승인 전에 순서·브러시·대기열 공간을 검사하고 commit 때만 새 좌표를 공개한다. */
  async prepare(
    connectionId: string,
    userId: string,
    input: AppendStrokeInput,
  ): Promise<PreparedStroke> {
    const key = `${userId}:${input.clientStrokeId}`;
    const previous = await this.latest(userId, input.clientStrokeId);
    const signature = this.signature(input);
    if (previous) {
      // 과거 묶음의 ACK가 유실됐어도 같은 데이터는 새 좌표나 사용으로 계산하지 않는다.
      if (input.chunkIndex < previous.preview.chunkIndex) {
        const pending = this.queue.find(
          (chunk) =>
            chunk.preview.userId === userId &&
            chunk.preview.clientStrokeId === input.clientStrokeId &&
            chunk.preview.chunkIndex === input.chunkIndex,
        );
        const original =
          pending ??
          (await this.chunks.byIndex(
            this.canvasId,
            userId,
            input.clientStrokeId,
            input.chunkIndex,
            this.epoch,
          ));
        if (!original || this.signature(original.preview) !== signature)
          throw new CanvasStrokeError(
            'INVALID_STROKE',
            'Chunk index has already been used with different data.',
          );
        return {
          isNewStroke: false,
          accepted: false,
          usageId: original.usageId,
          preview: original.preview,
          commit: () => ({ accepted: false, preview: original.preview }),
          cancel: () => {},
        };
      }
      if (!isDeepStrictEqual(previous.preview.brush, input.brush))
        throw new CanvasStrokeError(
          'INVALID_STROKE',
          'Brush cannot change during a stroke.',
        );
      // 같은 마지막 묶음은 원래 순서를 반환하되 내용이 달라진 재전송은 거절한다.
      if (input.chunkIndex === previous.preview.chunkIndex) {
        if (signature !== previous.signature)
          throw new CanvasStrokeError(
            'INVALID_STROKE',
            'Chunk index has already been used with different data.',
          );
        return {
          isNewStroke: false,
          accepted: false,
          usageId: previous.usageId,
          preview: previous.preview,
          commit: () => ({ accepted: false, preview: previous.preview }),
          cancel: () => {},
        };
      }
      // 완료된 획은 새 좌표를 받지 않으며 진행 중인 획은 연속된 다음 묶음만 받는다.
      if (previous.preview.isFinal)
        throw new CanvasStrokeError(
          'STROKE_CLOSED',
          'Stroke has already ended.',
        );
      if (input.chunkIndex !== previous.preview.chunkIndex + 1)
        throw new CanvasStrokeError(
          'INVALID_STROKE',
          'Stroke chunks must be sent in order.',
        );
    } else if (input.chunkIndex !== 0 || input.points.length === 0) {
      throw new CanvasStrokeError(
        'INVALID_STROKE',
        'Stroke must start with chunk zero and at least one point.',
      );
    }
    const preview: StrokePreview = {
      canvasKey: 'main',
      userId,
      epoch: this.epoch,
      sequence: String(this.head + 1n),
      ...input,
    };
    const bytes = this.size(preview);
    // 누적 그림이 아니라 미저장 대기열만 제한하며 최초 승인 전에 공간을 확인한다.
    if (
      this.queue.length >= STROKE_LIMITS.pendingChunks ||
      this.queueBytes + bytes > STROKE_LIMITS.pendingBytes
    )
      throw new CanvasStrokeError(
        'CANVAS_CAPACITY_REACHED',
        'Canvas storage queue is temporarily full.',
      );
    if (this.head >= 9223372036854775807n) throw this.unavailable();
    let valid = true;
    return {
      isNewStroke: previous === undefined,
      accepted: true,
      usageId: previous?.usageId,
      preview,
      cancel: () => {
        valid = false;
      },
      commit: (usageId = previous?.usageId, persisted = false) => {
        // 취소·재사용한 예약 또는 직렬화 범위 밖에서 변경된 순서는 공개하지 않는다.
        if (!valid || !usageId || BigInt(preview.sequence) !== this.head + 1n)
          throw this.unavailable();
        valid = false;
        this.head += 1n;
        const chunk = { usageId, preview };
        if (!persisted) {
          this.queue.push(chunk);
          this.queueBytes += bytes;
        }
        this.rememberPreview(preview);
        this.rememberStroke(key, chunk);
        // 완료된 연결의 권한은 해제하고 진행 중인 획은 연결당 하나만 캐시한다.
        if (input.isFinal) this.authorizations.delete(connectionId);
        else if (this.activeConnections.has(connectionId))
          this.authorizations.set(connectionId, {
            clientStrokeId: input.clientStrokeId,
            userId,
          });
        if (
          this.queue.length >= STROKE_LIMITS.flushChunks ||
          this.queueBytes >= STROKE_LIMITS.flushBytes
        )
          this.scheduleFlush(0);
        return { accepted: true, preview };
      },
    };
  }

  /** 저장 작업만 직렬화한다. 일반 flush의 DB 대기 중에도 중간 append는 계속 수신한다. */
  private store<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageWork.then(operation);
    this.storageWork = result.catch(() => {});
    return result;
  }

  /** 요청 시점의 대기열 prefix만 저장하고 성공한 좌표만 대기열에서 제거한다. */
  private async flushLocked(): Promise<void> {
    const batch = this.queue.slice(0, STROKE_LIMITS.flushChunks);
    if (batch.length === 0) return;
    await this.transactions.run((tx) =>
      this.chunks.save(this.canvasId, batch, String(this.persistedHead), tx),
    );
    this.persistedHead = BigInt(batch.at(-1)!.preview.sequence);
    this.queue.splice(0, batch.length);
    for (const chunk of batch) this.queueBytes -= this.size(chunk.preview);
  }

  /** 주기 저장·종료·완료 처리에서 같은 prefix를 중복 저장하지 않게 한다. */
  flush(): Promise<void> {
    return this.store(async () => {
      await this.ensureRecovered();
      // 호출 당시의 head까지만 저장해 계속 그리는 유저가 flush를 끝없이 연장하지 못하게 한다.
      const through = this.head;
      while (this.persistedHead < through) await this.flushLocked();
    });
  }

  /** 이전 좌표를 저장한 다음 마지막 좌표와 완료 기록을 함께 커밋하고 완료 ACK를 허용한다. */
  finish(
    approve: (
      tx: TransactionContext,
    ) => Promise<{ prepared: PreparedStroke; usageId: string }>,
  ): Promise<AppendStrokeResult> {
    return this.store(async () => {
      while (this.queue.length > 0) await this.flushLocked();
      let prepared: PreparedStroke | undefined;
      let approval: { prepared: PreparedStroke; usageId: string } | undefined;
      try {
        const approved = await this.transactions.run(async (tx) => {
          const result = await approve(tx);
          approval = result;
          prepared = result.prepared;
          if (prepared.accepted)
            await this.chunks.save(
              this.canvasId,
              [{ usageId: result.usageId, preview: prepared.preview }],
              String(this.persistedHead),
              tx,
            );
          return result;
        });
        const result = approved.prepared.commit(approved.usageId, true);
        // 재전송에는 새 순서가 없으므로 저장 경계도 변경하지 않는다.
        if (result.accepted) this.persistedHead = this.head;
        return result;
      } catch (error) {
        // COMMIT이 실제 성공했다면 DB의 정확한 마지막 묶음을 확인해 메모리 순서도 확정한다.
        if (approval && approval.prepared.accepted) {
          const { prepared: candidate, usageId } = approval;
          const recovered = await this.recoverCommit(
            candidate,
            usageId,
            true,
            async () => {
              const stored = await this.chunks.byIndex(
                this.canvasId,
                candidate.preview.userId,
                candidate.preview.clientStrokeId,
                candidate.preview.chunkIndex,
                this.epoch,
              );
              if (!stored) return false;
              if (
                stored.usageId !== usageId ||
                stored.preview.sequence !== candidate.preview.sequence ||
                this.signature(stored.preview) !==
                  this.signature(candidate.preview)
              )
                throw this.unavailable();
              return true;
            },
          );
          if (recovered) return recovered;
        }
        throw error;
      } finally {
        if (!prepared?.deferred) prepared?.cancel();
      }
    });
  }

  /** 커밋 결과를 확인할 수 없는 동안 새 순서 할당을 막고 다음 요청·flush에서 다시 확인한다. */
  async recoverCommit(
    prepared: PreparedStroke,
    usageId: string,
    persisted: boolean,
    check: () => Promise<boolean>,
  ): Promise<AppendStrokeResult | undefined> {
    let result: AppendStrokeResult | undefined;
    const reconcile = async () => {
      if (await check()) {
        result = prepared.commit(usageId, persisted);
        if (persisted && result.accepted) this.persistedHead = this.head;
      } else prepared.cancel();
      prepared.deferred = false;
    };
    try {
      await reconcile();
      return result;
    } catch (error) {
      prepared.deferred = true;
      this.recovery = reconcile;
      throw error;
    }
  }

  /** 요청과 저장 타이머가 동시에 복구를 시도해 한 좌표를 두 번 확정하지 않게 한다. */
  private async ensureRecovered(): Promise<void> {
    if (!this.recovery) return;
    if (!this.recoveryWork) {
      const recover = this.recovery;
      this.recoveryWork = recover()
        .then(() => {
          this.recovery = undefined;
        })
        .finally(() => {
          this.recoveryWork = undefined;
        });
    }
    await this.recoveryWork;
  }

  /** 1초 또는 누적량 기준으로 저장하며 실패한 좌표는 다음 주기에 그대로 재시도한다. */
  private scheduleFlush(delay: number = STROKE_LIMITS.flushIntervalMs): void {
    if (this.closing || this.timerFlushRunning) return;
    if (delay === 0) clearTimeout(this.timer);
    else if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerFlushRunning = true;
      void this.flush()
        .catch((error) =>
          this.logger.error(
            'Canvas chunk flush failed; queued coordinates retained.',
            error instanceof Error ? error.stack : String(error),
          ),
        )
        .finally(() => {
          this.timerFlushRunning = false;
          this.scheduleFlush();
        });
    }, delay);
    this.timer.unref();
  }

  /** 저장 경계를 고정한 DB prefix와 메모리 tail을 합쳐 기존 페이지 계약으로 반환한다. */
  async page(
    input: SyncCanvasInput & { limit: number },
  ): Promise<CanvasSyncPage> {
    await this.ensureRecovered();
    const reset = input.epoch !== this.epoch;
    const after = reset ? 0n : BigInt(input.afterSequence);
    const head =
      !reset && input.throughSequence !== undefined
        ? BigInt(input.throughSequence)
        : this.head;
    if (after > head || head > this.head)
      throw new CanvasStrokeError(
        'INVALID_SYNC',
        'Canvas sync cursor is invalid.',
      );
    const boundary = this.persistedHead < head ? this.persistedHead : head;
    // DB 대기 중 flush가 대기열을 비워도 이 페이지의 tail 참조는 유지된다.
    const tail = this.queue
      .filter(
        (chunk) =>
          BigInt(chunk.preview.sequence) > after &&
          BigInt(chunk.preview.sequence) <= head,
      )
      .slice(0, input.limit)
      .map((chunk) => chunk.preview);
    let prefix: StrokePreview[] = [];
    if (after < boundary) {
      const cached: StrokePreview[] = [];
      let cursor = after + 1n;
      while (cursor <= boundary && cached.length < input.limit) {
        const preview = this.recent.get(String(cursor));
        if (!preview) break;
        cached.push(preview);
        cursor++;
      }
      // 완전한 캐시 페이지가 아니면 DB가 같은 고정 prefix를 조회한다.
      prefix =
        cached.length === input.limit || cursor > boundary
          ? cached
          : await this.chunks.page(
              this.canvasId,
              String(after),
              String(boundary),
              input.limit,
              this.epoch,
            );
    }
    const previews: StrokePreview[] = [];
    let bytes = 0;
    for (const preview of [...prefix, ...tail]) {
      if (previews.length >= input.limit) break;
      const size = this.size(preview);
      if (previews.length > 0 && bytes + size > STROKE_LIMITS.syncPageBytes)
        break;
      // 저장 로그 또는 tail에 구멍이 있으면 불완전한 페이지를 성공 응답으로 숨기지 않는다.
      if (BigInt(preview.sequence) !== after + BigInt(previews.length) + 1n)
        throw this.unavailable();
      previews.push(preview);
      bytes += size;
    }
    if (previews.length === 0 && after < head) throw this.unavailable();
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

  /** 최근 좌표는 개수와 직렬화 크기 모두 제한하고 오래된 데이터는 DB에서 다시 읽는다. */
  private rememberPreview(preview: StrokePreview): void {
    this.recent.set(preview.sequence, preview);
    this.recentBytes += this.size(preview);
    while (
      this.recent.size > STROKE_LIMITS.recentChunks ||
      this.recentBytes > STROKE_LIMITS.recentBytes
    ) {
      const oldest = this.recent.keys().next().value!;
      this.recentBytes -= this.size(this.recent.get(oldest)!);
      this.recent.delete(oldest);
    }
  }

  /** 마지막 묶음과 서명도 제한하며 캐시 제거 후에는 대기열 또는 DB로 재구성한다. */
  private rememberStroke(key: string, chunk: StoredChunk): StrokeState {
    const old = this.strokes.get(key);
    if (old) {
      this.stateBytes -= old.bytes;
      this.strokes.delete(key);
    }
    const { clientStrokeId, chunkIndex, brush, points, isFinal } =
      chunk.preview;
    const signature = this.signature({
      clientStrokeId,
      brush,
      points,
      chunkIndex,
      isFinal,
    });
    const state = {
      ...chunk,
      signature,
      bytes: this.size(chunk.preview) + Buffer.byteLength(signature),
    };
    this.strokes.set(key, state);
    this.stateBytes += state.bytes;
    while (
      this.strokes.size > STROKE_LIMITS.stateCount ||
      this.stateBytes > STROKE_LIMITS.stateBytes
    ) {
      const oldest = this.strokes.keys().next().value!;
      this.stateBytes -= this.strokes.get(oldest)!.bytes;
      this.strokes.delete(oldest);
    }
    return state;
  }

  /** JSONB가 객체 키를 정렬해도 같은 브러시·좌표의 재전송 서명은 변하지 않는다. */
  private signature(input: AppendStrokeInput): string {
    const b = input.brush;
    return JSON.stringify([
      input.clientStrokeId,
      input.chunkIndex,
      input.isFinal,
      [
        b.type,
        b.size,
        b.color,
        b.opacity,
        b.version,
        b.angle ?? null,
        b.seed ?? null,
      ],
      input.points.map((p) => [p.x, p.y, p.t ?? null]),
    ]);
  }

  private size(preview: StrokePreview): number {
    return Buffer.byteLength(JSON.stringify(preview));
  }
  private unavailable(): CanvasStrokeError {
    return new CanvasStrokeError(
      'REALTIME_UNAVAILABLE',
      'Realtime service is temporarily unavailable.',
    );
  }

  /** 연결이 끊겨도 좌표는 저장 대기열에 남기고 인증 캐시만 제거한다. */
  disconnect(connectionId: string): void {
    this.activeConnections.delete(connectionId);
    this.clearAuthorization(connectionId);
  }

  /** 인증 재검사 실패는 현재 획의 권한만 비우고 살아 있는 연결은 유지한다. */
  clearAuthorization(connectionId: string): void {
    this.authorizations.delete(connectionId);
  }

  /** 준비된 실제 연결만 등록해 지연된 커밋 복구가 종료된 연결의 인증 캐시를 만들지 않게 한다. */
  connected(connectionId: string): void {
    this.activeConnections.add(connectionId);
  }

  /** 새 수신을 막고 진행 중 승인과 저장을 마친 뒤 메모리와 타이머를 정리한다. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.appendWork;
    try {
      await this.flush();
    } catch (error) {
      this.logger.error(
        'Canvas shutdown flush failed; unpersisted coordinates could not be saved.',
        error instanceof Error ? error.stack : String(error),
      );
    }
    this.queue.length = 0;
    this.queueBytes = 0;
    this.recent.clear();
    this.recentBytes = 0;
    this.strokes.clear();
    this.stateBytes = 0;
    this.authorizations.clear();
    this.activeConnections.clear();
    this.recovery = undefined;
  }
}
