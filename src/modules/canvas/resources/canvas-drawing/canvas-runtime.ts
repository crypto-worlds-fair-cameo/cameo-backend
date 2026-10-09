import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Logger } from '@nestjs/common';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type { CanvasTarget } from '../canvas-definition/canvas-target';
import {
  CanvasStrokeError,
  STROKE_LIMITS,
  type AppendStrokeInput,
  type AppendStrokeResult,
  type CanvasSyncPage,
  type StrokePreview,
  type SyncCanvasInput,
} from '../canvas-stroke/canvas-stroke';
import {
  CanvasChunkRepository,
  type StoredChunk,
} from './canvas-chunk.repository';

export type StrokeState = StoredChunk & { signature: string; bytes: number };
export type PreparedStroke = {
  isNewStroke: boolean;
  accepted: boolean;
  usageId?: string;
  preview: StrokePreview;
  deferred?: boolean;
  commit: (usageId?: string, persisted?: boolean) => AppendStrokeResult;
  cancel: () => void;
};

export type CanvasRuntimeLimits = Readonly<{
  pendingBytes: number;
  pendingChunks: number;
  recentBytes: number;
  recentChunks: number;
  stateBytes: number;
  stateCount: number;
}>;

export type CanvasRuntimeBudget = Readonly<{
  reservePending: (bytes: number) => boolean;
  releasePending: (bytes: number) => void;
  reserveCache: (bytes: number) => boolean;
  releaseCache: (bytes: number) => void;
}>;

export type CanvasRuntimeState = 'OPEN' | 'DRAINING' | 'CLOSED' | 'RECONCILING';

type PendingReservation = { bytes: number };
type QueuedChunk = StoredChunk & { reservation: PendingReservation };

/** 캔버스 하나의 순서, 저장 대기열, 복구 상태와 제한된 캐시를 소유한다. */
export class CanvasRuntime {
  private readonly logger: Logger;
  private readonly epoch = randomUUID();
  private canvasId = '';
  private head = 0n;
  private persistedHead = 0n;
  private readonly queue: QueuedChunk[] = [];
  private queueBytes = 0;
  private readonly pendingReservations = new Set<PendingReservation>();
  private readonly recent = new Map<string, StrokePreview>();
  private recentBytes = 0;
  readonly strokes = new Map<string, StrokeState>();
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
  private commitRecoveryPending = false;
  private readonly activeConnections = new Set<string>();
  private lifecycleState: CanvasRuntimeState = 'OPEN';

  constructor(
    target: CanvasTarget,
    private readonly chunks: CanvasChunkRepository,
    private readonly transactions: TransactionRunner,
    private readonly limits: CanvasRuntimeLimits,
    private readonly budget: CanvasRuntimeBudget,
  ) {
    this.target = target;
    this.logger = new Logger(`CanvasRuntime:${target.key}`);
  }

  target: CanvasTarget;

  /** DB의 저장 경계를 읽고 캔버스별 메모리 순서를 초기화한다. */
  async initialize(): Promise<void> {
    // 기존 main 초기화 wrapper를 유지해 startup 검사와 fault injection 경로를 바꾸지 않는다.
    const state =
      this.target.kind === 'main'
        ? await this.chunks.initialize()
        : await this.chunks.initializeTarget(this.target);
    // main wrapper가 찾은 실제 DB id를 이후 binding과 target 검증에 사용하는 runtime target에 반영한다.
    if (this.target.kind === 'main')
      this.target = { ...this.target, id: state.canvasId };
    this.canvasId = state.canvasId;
    this.head = this.persistedHead = BigInt(state.headSequence);
    // 시즌 runtime은 registry의 단일 sweep가 관리하고 main만 기존 주기 타이머를 유지한다.
    if (this.target.kind === 'main') this.scheduleFlush();
  }

  /** 순서 할당·첫 승인·완료 승인을 직렬화하며 실패한 작업은 다음 요청을 막지 않는다. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueInput(async () => {
      await this.ensureRecovered();
      return operation();
    });
  }

  /** append gate에 작업을 연결하되 recovery 실행 여부는 호출 경로가 결정한다. */
  private enqueueInput<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(this.unavailable());
    const result = this.appendWork.then(operation);
    this.appendWork = result.catch(() => {});
    return result;
  }

  /** 시즌 입력은 같은 gate에서 복구와 lifecycle 상태를 확인한 뒤에만 실행한다. */
  exclusiveInput<T>(operation: () => Promise<T>): Promise<T> {
    // main에는 시즌 lifecycle 상태를 적용하지 않아 기존 입력·fault injection 흐름을 유지한다.
    if (this.target.kind === 'main') return this.exclusive(operation);
    return this.enqueueInput(async () => {
      // COMMIT 복구는 registry 유지보수만 실행하며 새 append는 중복 확인을 시작하지 않는다.
      if (this.state === 'CLOSED') throw this.inactiveSeason();
      if (this.state !== 'OPEN') throw this.unavailable();
      return operation();
    });
  }

  /** 조기 종료가 gate를 얻은 시점부터 새 입력을 막고 기존 승인분 저장을 준비한다. */
  beginDraining(): void {
    if (this.target.kind === 'season') this.lifecycleState = 'DRAINING';
  }

  /** DB에서 종료·취소를 확인한 runtime을 관람·sync 전용 상태로 전환한다. */
  markClosed(): void {
    if (this.target.kind === 'season') this.lifecycleState = 'CLOSED';
  }

  /** DB 결과를 확인할 수 없는 동안 새 입력과 idle eviction을 함께 막는다. */
  markReconciling(): void {
    if (this.target.kind === 'season') this.lifecycleState = 'RECONCILING';
  }

  /** 명확히 미반영이고 아직 종료 전인 시즌만 새 입력을 받을 수 있게 복원한다. */
  markOpen(): void {
    // 종료 사실은 되돌릴 수 없으므로 이전에 읽은 active snapshot이 CLOSED를 다시 열지 못하게 한다.
    if (this.target.kind === 'season' && this.lifecycleState !== 'CLOSED')
      this.lifecycleState = 'OPEN';
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
      (await this.chunks.latest(
        this.canvasId,
        userId,
        strokeId,
        this.epoch,
        this.target.key,
      ));
    if (!stored) return undefined;
    return this.rememberStroke(key, stored);
  }

  /** DB 승인 전에 순서·브러시·pending 공간을 예약하고 commit 때만 새 좌표를 공개한다. */
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
            this.target.key,
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
      canvasKey: this.target.key,
      userId,
      epoch: this.epoch,
      sequence: String(this.head + 1n),
      ...input,
    };
    const bytes = this.size(preview);
    // 방별 상한과 registry 전체 예산을 모두 예약한 좌표만 비동기 승인 단계로 보낸다.
    if (
      this.queue.length >= this.limits.pendingChunks ||
      this.queueBytes + bytes > this.limits.pendingBytes ||
      !this.budget.reservePending(bytes)
    )
      throw new CanvasStrokeError(
        'CANVAS_CAPACITY_REACHED',
        'Canvas storage queue is temporarily full.',
      );
    if (this.head >= 9223372036854775807n) {
      this.budget.releasePending(bytes);
      throw this.unavailable();
    }
    const reservation = { bytes };
    this.pendingReservations.add(reservation);
    let valid = true;
    const releaseReservation = () => {
      this.releasePendingReservation(reservation);
    };
    return {
      isNewStroke: previous === undefined,
      accepted: true,
      usageId: previous?.usageId,
      preview,
      cancel: () => {
        if (!valid) return;
        valid = false;
        releaseReservation();
      },
      commit: (usageId = previous?.usageId, persisted = false) => {
        // 취소·재사용한 예약 또는 직렬화 범위 밖에서 변경된 순서는 공개하지 않는다.
        if (!valid || !usageId || BigInt(preview.sequence) !== this.head + 1n)
          throw this.unavailable();
        valid = false;
        this.head += 1n;
        const chunk = { usageId, preview };
        if (persisted) releaseReservation();
        else {
          // 미저장 queue가 reservation을 이어받고 flush 성공 시 반환한다.
          this.queue.push({ ...chunk, reservation });
          this.queueBytes += bytes;
        }
        this.rememberPreview(preview);
        this.rememberStroke(key, chunk);
        // 완료된 연결의 권한은 해제하고 진행 중인 획은 연결당 하나만 캐시한다.
        if (input.isFinal) this.authorizations.delete(connectionId);
        else if (
          this.target.kind === 'main' &&
          this.activeConnections.has(connectionId)
        )
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

  /** 요청 시점의 대기열 prefix만 저장하고 성공한 좌표와 pending 예약만 제거한다. */
  private async flushLocked(): Promise<void> {
    const batch = this.queue.slice(0, STROKE_LIMITS.flushChunks);
    if (batch.length === 0) return;
    await this.transactions.run((transaction) =>
      this.chunks.save(
        this.canvasId,
        batch,
        String(this.persistedHead),
        transaction,
        this.target.key,
      ),
    );
    this.persistedHead = BigInt(batch.at(-1)!.preview.sequence);
    this.queue.splice(0, batch.length);
    for (const chunk of batch) {
      const bytes = this.size(chunk.preview);
      this.queueBytes -= bytes;
      this.releasePendingReservation(chunk.reservation);
    }
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
      transaction: TransactionContext,
    ) => Promise<{ prepared: PreparedStroke; usageId: string }>,
  ): Promise<AppendStrokeResult> {
    return this.store(async () => {
      while (this.queue.length > 0) await this.flushLocked();
      let prepared: PreparedStroke | undefined;
      let approval: { prepared: PreparedStroke; usageId: string } | undefined;
      try {
        const approved = await this.transactions.run(async (transaction) => {
          const result = await approve(transaction);
          approval = result;
          prepared = result.prepared;
          if (prepared.accepted)
            await this.chunks.save(
              this.canvasId,
              [{ usageId: result.usageId, preview: prepared.preview }],
              String(this.persistedHead),
              transaction,
              this.target.key,
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
                this.target.key,
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

  /** 시즌 final은 storage lane에서 기존 queue를 저장하고 prepare를 끝낸 뒤 승인 transaction을 연다. */
  finishPrepared(
    prepare: () => Promise<PreparedStroke>,
    approve: (
      prepared: PreparedStroke,
      transaction: TransactionContext,
    ) => Promise<string>,
  ): Promise<AppendStrokeResult> {
    return this.store(async () => {
      await this.ensureRecovered();
      while (this.queue.length > 0) await this.flushLocked();
      let prepared: PreparedStroke | undefined;
      let approval: { prepared: PreparedStroke; usageId: string } | undefined;
      try {
        // prepare의 DB 조회와 pending 예약은 사용자·세션·시즌 잠금을 잡기 전에 끝낸다.
        prepared = await prepare();
        const usageId = await this.transactions.run(
          async (transaction) => {
            const approvedUsageId = await approve(prepared!, transaction);
            approval = { prepared: prepared!, usageId: approvedUsageId };
            if (prepared!.accepted)
              await this.chunks.save(
                this.canvasId,
                [{ usageId: approvedUsageId, preview: prepared!.preview }],
                String(this.persistedHead),
                transaction,
                this.target.key,
              );
            return approvedUsageId;
          },
          { isolationLevel: 'read committed' },
        );
        const result = prepared.commit(usageId, true);
        if (result.accepted) this.persistedHead = this.head;
        return result;
      } catch (error) {
        // final COMMIT 응답이 유실되면 이 canvas의 정확한 청크만 확인해 승인 예약을 복구한다.
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
                this.target.key,
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
        // 결과 미확정 recovery가 소유한 예약은 유지하고, 그 외 실패 예약만 즉시 반환한다.
        if (!prepared?.deferred) prepared?.cancel();
      }
    });
  }

  /** 커밋 결과를 확인할 수 없는 동안 예약과 runtime을 유지하고 다음 작업에서 다시 확인한다. */
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
      // deferred 시즌 복구는 최신 DB lifecycle을 확인할 때까지 입력 차단 상태를 유지한다.
      if (this.target.kind === 'main' || !this.commitRecoveryPending)
        this.commitRecoveryPending = false;
    };
    try {
      await reconcile();
      return result;
    } catch (error) {
      prepared.deferred = true;
      if (this.target.kind === 'season') this.commitRecoveryPending = true;
      this.recovery = reconcile;
      throw error;
    }
  }

  /** 요청과 sweep가 동시에 복구를 시도해 한 좌표를 두 번 확정하지 않게 한다. */
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

  /** registry 유지보수가 보관된 chunk COMMIT 결과를 한 번만 확인한다. */
  recoverPendingCommit(): Promise<void> {
    return this.ensureRecovered();
  }

  /** 복구 뒤 최신 시즌 상태 적용이 끝나면 새 입력이 OPEN/CLOSED 상태를 보게 한다. */
  confirmCommitRecovery(): void {
    this.commitRecoveryPending = false;
  }

  /** main은 1초 또는 누적량 기준으로 저장하며 실패한 좌표는 다음 주기에 재시도한다. */
  private scheduleFlush(delay: number = STROKE_LIMITS.flushIntervalMs): void {
    if (this.target.kind !== 'main' || this.closing || this.timerFlushRunning)
      return;
    if (delay === 0) clearTimeout(this.timer);
    else if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerFlushRunning = true;
      void this.flush()
        .catch((error) => this.logFailure('periodic_flush', error))
        .finally(() => {
          this.timerFlushRunning = false;
          this.scheduleFlush();
        });
    }, delay);
    this.timer.unref();
  }

  /** 저장 경계를 고정한 DB prefix와 메모리 tail을 합쳐 대상 캔버스 페이지로 반환한다. */
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
              this.target.key,
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
      canvasKey: this.target.key,
      epoch: this.epoch,
      reset,
      previews,
      headSequence: String(head),
      nextSequence,
      hasMore: BigInt(nextSequence) < head,
    };
  }

  /** 최근 좌표는 방별·전체 cache 예산 안에서만 보관하고 부족하면 DB 재조회에 맡긴다. */
  private rememberPreview(preview: StrokePreview): void {
    const bytes = this.size(preview);
    const existing = this.recent.get(preview.sequence);
    if (existing) {
      const oldBytes = this.size(existing);
      this.recent.delete(preview.sequence);
      this.recentBytes -= oldBytes;
      this.budget.releaseCache(oldBytes);
    }
    if (bytes > this.limits.recentBytes) return;
    while (
      this.recent.size >= this.limits.recentChunks ||
      this.recentBytes + bytes > this.limits.recentBytes
    )
      this.removeOldestPreview();
    // cache 부족은 durable commit 결과를 바꾸지 않고 이번 삽입만 생략한다.
    if (!this.budget.reserveCache(bytes)) return;
    this.recent.set(preview.sequence, preview);
    this.recentBytes += bytes;
  }

  /** 마지막 묶음도 방별·전체 cache 예산 안에서만 유지하고 호출 결과는 항상 반환한다. */
  private rememberStroke(key: string, chunk: StoredChunk): StrokeState {
    const old = this.strokes.get(key);
    if (old) {
      this.stateBytes -= old.bytes;
      this.strokes.delete(key);
      this.budget.releaseCache(old.bytes);
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
    if (state.bytes > this.limits.stateBytes) return state;
    while (
      this.strokes.size >= this.limits.stateCount ||
      this.stateBytes + state.bytes > this.limits.stateBytes
    )
      this.removeOldestStroke();
    // cache 예산이 없으면 현재 요청만 state를 사용하고 다음 요청은 queue나 DB에서 복구한다.
    if (!this.budget.reserveCache(state.bytes)) return state;
    this.strokes.set(key, state);
    this.stateBytes += state.bytes;
    return state;
  }

  private removeOldestPreview(): void {
    const oldest = this.recent.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    const bytes = this.size(this.recent.get(oldest)!);
    this.recent.delete(oldest);
    this.recentBytes -= bytes;
    this.budget.releaseCache(bytes);
  }

  private removeOldestStroke(): void {
    const oldest = this.strokes.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    const bytes = this.strokes.get(oldest)!.bytes;
    this.strokes.delete(oldest);
    this.stateBytes -= bytes;
    this.budget.releaseCache(bytes);
  }

  private releasePendingReservation(reservation: PendingReservation): void {
    if (!this.pendingReservations.delete(reservation)) return;
    this.budget.releasePending(reservation.bytes);
  }

  /** JSONB가 객체 키를 정렬해도 같은 브러시·좌표의 재전송 서명은 변하지 않는다. */
  private signature(input: AppendStrokeInput): string {
    const brush = input.brush;
    return JSON.stringify([
      input.clientStrokeId,
      input.chunkIndex,
      input.isFinal,
      [
        brush.type,
        brush.size,
        brush.color,
        brush.opacity,
        brush.version,
        brush.angle ?? null,
        brush.seed ?? null,
      ],
      input.points.map((point) => [point.x, point.y, point.t ?? null]),
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

  private inactiveSeason(): CanvasStrokeError {
    return new CanvasStrokeError('SEASON_NOT_ACTIVE', 'Season is not active.');
  }

  /** 운영 로그에는 캔버스와 실패 단계만 식별하고 인증값이나 그림 payload는 넣지 않는다. */
  private logFailure(stage: string, error: unknown): void {
    const description =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'Non-Error rejection';
    this.logger.error(
      `Canvas runtime failure canvasId=${this.canvasId || this.target.id || this.target.key} stage=${stage} error=${description}`,
      error instanceof Error ? error.stack : undefined,
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

  /** 준비된 실제 연결만 등록해 지연된 복구가 종료된 연결의 인증 캐시를 만들지 않게 한다. */
  connected(connectionId: string): void {
    this.activeConnections.add(connectionId);
  }

  /** sweep가 pending·복구·연결이 있는 runtime을 제거하지 않게 현재 상태를 공개한다. */
  get evictionBlocked(): boolean {
    return (
      this.queue.length > 0 ||
      this.pendingReservations.size > 0 ||
      this.recovery !== undefined ||
      this.recoveryWork !== undefined ||
      this.commitRecoveryPending ||
      this.activeConnections.size > 0 ||
      this.lifecycleState === 'DRAINING' ||
      this.lifecycleState === 'RECONCILING'
    );
  }

  /** registry가 lifecycle snapshot을 적용할 때 현재 조정 상태를 비교한다. */
  get state(): CanvasRuntimeState {
    return this.commitRecoveryPending ? 'RECONCILING' : this.lifecycleState;
  }

  /** COMMIT 복구 상태와 별개로 DB에서 확인한 종료 여부를 registry가 단조롭게 적용하게 한다. */
  get lifecycleClosed(): boolean {
    return this.lifecycleState === 'CLOSED';
  }

  /** 상태 이벤트가 같은 runtime의 epoch와 승인 head를 동기적으로 읽게 한다. */
  get boundary(): Readonly<{ epoch: string; headSequence: string }> {
    return { epoch: this.epoch, headSequence: String(this.head) };
  }

  /** bootstrap이 DB 저장 완료 경계 이하 스냅샷만 선택하도록 현재 저장 경계를 노출한다. */
  get persistedHeadSequence(): string {
    return String(this.persistedHead);
  }

  get needsMaintenance(): boolean {
    return (
      this.queue.length > 0 ||
      this.recovery !== undefined ||
      this.commitRecoveryPending
    );
  }

  get needsCommitRecovery(): boolean {
    return this.commitRecoveryPending;
  }

  /** registry sweep가 시즌의 복구를 먼저 확인하고 남은 queue를 저장한다. */
  async maintain(): Promise<void> {
    await this.flush();
  }

  /** 새 수신을 막고 저장 결과와 무관하게 budget을 반환하며, 저장 실패는 호출자에게 전달한다. */
  async close(flushPending: boolean): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.appendWork;
    let flushError: unknown;
    if (flushPending) {
      try {
        await this.flush();
      } catch (error) {
        // 다른 runtime도 종료할 수 있도록 정리는 계속하되 registry가 실패를 보고하게 한다.
        flushError = error;
      }
    }
    // recovery가 끝나지 않아 queue로 이동하지 않은 prepare 예약도 종료 시 모두 반환한다.
    for (const reservation of this.pendingReservations)
      this.releasePendingReservation(reservation);
    this.queue.length = 0;
    this.queueBytes = 0;
    for (const preview of this.recent.values())
      this.budget.releaseCache(this.size(preview));
    this.recent.clear();
    this.recentBytes = 0;
    for (const state of this.strokes.values())
      this.budget.releaseCache(state.bytes);
    this.strokes.clear();
    this.stateBytes = 0;
    this.authorizations.clear();
    this.activeConnections.clear();
    this.recovery = undefined;
    this.commitRecoveryPending = false;
    if (flushError !== undefined) throw flushError;
  }
}
