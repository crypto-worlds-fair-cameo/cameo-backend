import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '../../../../business-error';
import type { AllConfigType } from '../../../../config/config.type';
import { DEFAULT_RUNTIME_LIMITS } from '../../../../config/realtime.config';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type {
  CanvasKey,
  CanvasTarget,
} from '../canvas-definition/canvas-target';
import { SeasonCanvasQuery } from '../canvas-access/season-canvas-query';
import {
  CanvasStrokeError,
  STROKE_LIMITS,
} from '../canvas-stroke/canvas-stroke';
import { CanvasChunkRepository } from './canvas-chunk.repository';
import {
  CanvasRuntime,
  type CanvasRuntimeBudget,
  type CanvasRuntimeLimits,
} from './canvas-runtime';
import type { LifecycleSnapshot } from './canvas-drawing';

const MAIN_PENDING_RESERVE = 16 * 1024 * 1024;
const MAIN_CACHE_RESERVE = 24 * 1024 * 1024;
const SEASON_RUNTIME_LIMITS: CanvasRuntimeLimits = {
  pendingBytes: 4 * 1024 * 1024,
  pendingChunks: 1024,
  recentBytes: 2 * 1024 * 1024,
  recentChunks: 512,
  stateBytes: 1024 * 1024,
  stateCount: 256,
};
const MAIN_RUNTIME_LIMITS: CanvasRuntimeLimits = {
  pendingBytes: STROKE_LIMITS.pendingBytes,
  pendingChunks: STROKE_LIMITS.pendingChunks,
  recentBytes: STROKE_LIMITS.recentBytes,
  recentChunks: STROKE_LIMITS.recentChunks,
  stateBytes: STROKE_LIMITS.stateBytes,
  stateCount: STROKE_LIMITS.stateCount,
};

type EntryState = 'active' | 'retiring';
type LifecycleRecovery = {
  kind: 'cancel' | 'end';
  recover: () => Promise<void>;
  attempt: number;
  nextAttemptAt: number;
};
export type CanvasVisibility = 'PUBLIC' | 'PENDING' | 'CANCELLED';
export type CanvasVisibilitySnapshot = Readonly<{
  visibility: CanvasVisibility;
  generation: number;
}>;
type EntryBase = {
  key: CanvasKey;
  state: EntryState;
  leases: number;
  operations: number;
  operationWaiters?: Set<() => void>;
  lastUsedAt: number;
  maintenance?: Promise<void>;
  lifecycleRecovery?: LifecycleRecovery;
  lifecycleGeneration: number;
  lifecycleSignature?: string;
  lifecycleClosed?: boolean;
  stateObservationGeneration?: number;
  visibility: CanvasVisibility;
  visibilityGeneration: number;
};
type RuntimeEntry = EntryBase & {
  kind: 'runtime';
  target: CanvasTarget;
  runtime?: CanvasRuntime;
  initialization: Promise<CanvasRuntime>;
};
type ControlEntry = EntryBase & {
  kind: 'control';
  gate: Promise<unknown>;
};
type RegistryEntry = RuntimeEntry | ControlEntry;

export type CanvasConnectionLease = Readonly<{
  runtime: CanvasRuntime;
  observeLifecycle: (state: LifecycleSnapshot) => void;
  release: () => void;
}>;

export type LifecycleChange = Readonly<{
  canvasId: string;
  kind: 'state' | 'visibility';
  state: LifecycleSnapshot;
}>;

export class LifecycleRegistryError extends Error {}

/** target별 runtime 초기화, 동일 gate, lease와 프로세스 전체 메모리 예산을 소유한다. */
@Injectable()
export class CanvasRuntimeRegistry {
  private readonly logger = new Logger(CanvasRuntimeRegistry.name);
  private readonly entries = new Map<CanvasKey, RegistryEntry>();
  private mainRuntime?: CanvasRuntime;
  private mainInitialization?: Promise<CanvasRuntime>;
  private seasonRuntimeCount = 0;
  private controlEntryCount = 0;
  private pendingOperations = 0;
  private mainOperations = 0;
  private readonly mainOperationWaiters = new Set<() => void>();
  private mainPendingBytes = 0;
  private seasonPendingBytes = 0;
  private mainCacheBytes = 0;
  private seasonCacheBytes = 0;
  private readonly maximumSeasonRuntimes: number;
  private readonly maximumPendingBytes: number;
  private readonly maximumCacheBytes: number;
  private readonly idleMilliseconds: number;
  private readonly maximumPendingOperations: number;
  private readonly maximumSeasonOperations: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly lifecycleListeners = new Set<
    (change: LifecycleChange) => void
  >();
  private closing = false;
  private stateSweep?: Promise<void>;
  private shutdownWork?: Promise<void>;

  constructor(
    private readonly chunks: CanvasChunkRepository,
    private readonly transactions: TransactionRunner,
    config: ConfigService<AllConfigType>,
    private readonly seasonCanvases?: SeasonCanvasQuery,
  ) {
    // 기존 test config처럼 새 키가 없으면 공개 기본값을 채우되, 환경 파서는 입력 오류를 별도로 거절한다.
    this.maximumSeasonRuntimes =
      config.get('realtime.maxSeasonRuntimes', { infer: true }) ??
      DEFAULT_RUNTIME_LIMITS.maxSeasonRuntimes;
    this.maximumPendingBytes =
      config.get('realtime.pendingBytes', { infer: true }) ??
      DEFAULT_RUNTIME_LIMITS.pendingBytes;
    this.maximumCacheBytes =
      config.get('realtime.cacheBytes', { infer: true }) ??
      DEFAULT_RUNTIME_LIMITS.cacheBytes;
    this.idleMilliseconds =
      config.get('realtime.runtimeIdleMs', { infer: true }) ??
      DEFAULT_RUNTIME_LIMITS.runtimeIdleMs;
    this.maximumPendingOperations =
      config.get('realtime.maxPendingOperations', { infer: true }) ??
      DEFAULT_RUNTIME_LIMITS.maxPendingOperations;
    this.maximumSeasonOperations =
      config.get('realtime.maxSeasonOperations', { infer: true }) ??
      DEFAULT_RUNTIME_LIMITS.maxSeasonOperations;
    this.sweepTimer = setInterval(() => this.sweep(), 1000);
    this.sweepTimer.unref();
  }

  /** main runtime을 한 번 초기화하고 모든 기존 facade 호출이 같은 객체를 사용하게 한다. */
  initializeMain(): Promise<CanvasRuntime> {
    if (this.closing) return Promise.reject(this.unavailable());
    if (this.mainRuntime) return Promise.resolve(this.mainRuntime);
    if (this.mainInitialization) return this.mainInitialization;
    const target: CanvasTarget = {
      id: '',
      key: 'main',
      kind: 'main',
      width: 10_000,
      height: 10_000,
      strokeLimitPerUser: 1,
      startsAt: null,
      endsAt: null,
    };
    const runtime = new CanvasRuntime(
      target,
      this.chunks,
      this.transactions,
      MAIN_RUNTIME_LIMITS,
      this.budget('main'),
    );
    this.mainInitialization = runtime
      .initialize()
      .then(() => {
        this.mainRuntime = runtime;
        return runtime;
      })
      .catch((error) => {
        this.mainInitialization = undefined;
        throw error;
      });
    return this.mainInitialization;
  }

  /** startup 이후 기존 main facade가 사용하는 상주 runtime을 반환한다. */
  main(): CanvasRuntime {
    if (!this.mainRuntime)
      throw new Error('Main canvas runtime is not initialized.');
    return this.mainRuntime;
  }

  /** main 입력도 종료 gate에 등록해 closing 이후 새 작업을 막고 진행 중 작업을 기다리게 한다. */
  async withMain<T>(work: (runtime: CanvasRuntime) => Promise<T>): Promise<T> {
    this.beginMainOperation();
    try {
      const runtime = await this.initializeMain();
      return await runtime.exclusive(() => work(runtime));
    } finally {
      this.endMainOperation();
    }
  }

  /** main sync를 입력 gate 밖에서 실행하되 정상 종료가 완료까지 기다리게 한다. */
  async withMainRead<T>(
    work: (runtime: CanvasRuntime) => Promise<T>,
  ): Promise<T> {
    this.beginMainOperation();
    try {
      return await work(await this.initializeMain());
    } finally {
      this.endMainOperation();
    }
  }

  /** target runtime을 lease하고 같은 entry gate 안에서 작업을 한 번 실행한다. */
  async withCanvas<T>(
    target: CanvasTarget,
    work: (runtime: CanvasRuntime) => Promise<T>,
  ): Promise<T> {
    if (target.kind === 'main') return this.withMain(work);
    const entry = this.acquireRuntimeEntry(target);
    try {
      this.beginOperation(entry, 'socket');
    } catch (error) {
      // 초기화가 이미 시작됐으면 거절한 호출과 별개로 rejection을 관찰해 unhandled 상태를 막는다.
      void entry.initialization.catch(() => {});
      throw error;
    }
    try {
      const runtime = await entry.initialization;
      return await runtime.exclusiveInput(() => work(runtime));
    } finally {
      this.endOperation(entry);
      this.release(entry);
    }
  }

  /** sync가 input gate를 잡지 않고도 runtime과 operation 슬롯을 완료까지 고정한다. */
  async withCanvasRead<T>(
    target: CanvasTarget,
    work: (runtime: CanvasRuntime) => Promise<T>,
  ): Promise<T> {
    if (target.kind === 'main') return this.withMainRead(work);
    const entry = this.acquireRuntimeEntry(target);
    try {
      this.beginOperation(entry, 'socket');
    } catch (error) {
      void entry.initialization.catch(() => {});
      throw error;
    }
    try {
      return await work(await entry.initialization);
    } finally {
      this.endOperation(entry);
      this.release(entry);
    }
  }

  /** 연결 생존 기간의 lease를 반환하고 release를 여러 번 호출해도 한 번만 해제한다. */
  async leaseConnection(
    target: CanvasTarget,
    connectionId: string,
    allowControlPromotion: boolean,
    enter: (
      lease: CanvasConnectionLease,
      visibility: CanvasVisibilitySnapshot,
    ) => Promise<void>,
  ): Promise<void> {
    if (target.kind === 'main') {
      this.beginMainOperation();
      try {
        const runtime = await this.initializeMain();
        let released = false;
        const lease = {
          runtime,
          observeLifecycle: () => {},
          release: () => {
            if (released) return;
            released = true;
            runtime.disconnect(connectionId);
          },
        };
        try {
          await runtime.exclusive(async () => {
            runtime.connected(connectionId);
            await enter(lease, { visibility: 'PUBLIC', generation: 0 });
          });
        } catch (error) {
          lease.release();
          throw error;
        }
      } finally {
        this.endMainOperation();
      }
      return;
    }
    const entry = this.acquireRuntimeEntry(target, allowControlPromotion);
    try {
      this.beginOperation(entry, 'socket');
    } catch (error) {
      void entry.initialization.catch(() => {});
      throw error;
    }
    let lease: CanvasConnectionLease | undefined;
    try {
      const runtime = await entry.initialization;
      let released = false;
      lease = {
        runtime,
        observeLifecycle: (state) =>
          this.observeConnectionLifecycle(entry, state),
        release: () => {
          if (released) return;
          released = true;
          runtime.disconnect(connectionId);
          this.release(entry);
        },
      };
      await runtime.exclusive(async () => {
        runtime.connected(connectionId);
        await enter(lease!, this.visibilityOf(entry));
      });
      return;
    } catch (error) {
      // 초기화·room 합류 실패 모두 연결 표시와 entry lease를 한 번만 반환한다.
      if (lease) lease.release();
      else this.release(entry);
      throw error;
    } finally {
      this.endOperation(entry);
      // promotion 초기화 실패로 control로 돌아온 clean entry도 마지막 operation 뒤 제거한다.
      this.removeCleanControlEntry(entry);
    }
  }

  /** 최종 캡처 전에 기존 lifecycle gate에서 승인 처리를 배출하고 미저장 좌표를 flush한다. */
  async prepareFinalSnapshot(canvasId: string): Promise<void> {
    const inspect = async () => {
      const state = await this.seasonCanvases?.observe(canvasId, undefined);
      if (!state || state.cancelledAt || !this.isClosed(state))
        throw new Error('Season is not eligible for a final snapshot.');
      return state;
    };
    await this.withLifecycle(
      canvasId,
      'end',
      async () => ({ result: undefined, state: await inspect() }),
      inspect,
    );
  }

  /** lifecycle 작업은 기존 runtime gate를 재사용하고 무접속 시즌에는 control entry만 만든다. */
  async withLifecycle<T>(
    canvasId: string,
    kind: 'cancel' | 'end',
    apply: () => Promise<{ result: T; state: LifecycleSnapshot }>,
    inspect: () => Promise<LifecycleSnapshot>,
  ): Promise<T> {
    if (this.closing) throw new LifecycleRegistryError();
    const key = `season:${canvasId.toLowerCase()}` as const;
    let entry = this.entries.get(key);
    if (!entry) entry = this.createControlEntry(key);
    entry.leases += 1;
    try {
      this.beginOperation(entry, 'lifecycle');
    } catch (error) {
      // 새 control entry가 admission에서 거절되면 같은 요청 안에서 즉시 슬롯을 반환한다.
      this.removeCleanControlEntry(entry);
      if (entry.kind === 'runtime') void entry.initialization.catch(() => {});
      throw error;
    }
    const execute = async (runtime: CanvasRuntime | undefined) => {
      // 미확정 inspect가 남은 entry는 오래된 결과와 새 lifecycle을 섞지 않는다.
      if (entry.lifecycleRecovery) throw new LifecycleRegistryError();
      entry.lifecycleGeneration += 1;
      if (kind === 'end') {
        // end gate부터 새 입력을 막고, apply transaction 전에 기존 승인 head를 저장한다.
        runtime?.beginDraining();
      } else {
        // 취소 gate가 시작되는 즉시 기존 sync 세대와 공개 연결 승인을 무효화한다.
        this.setVisibility(entry, 'PENDING');
      }
      try {
        if (kind === 'end') await runtime?.flush();
        const applied = await apply();
        this.applyLifecycleSnapshot(entry, canvasId, kind, applied.state);
        return applied.result;
      } catch (error) {
        // apply 결과가 불명확하면 primary를 읽고, 읽기도 실패한 entry는 sweep 복구까지 유지한다.
        try {
          this.applyLifecycleSnapshot(entry, canvasId, kind, await inspect());
        } catch {
          runtime?.markReconciling();
          const recovery: LifecycleRecovery = {
            kind,
            attempt: 0,
            nextAttemptAt: Date.now() + 1000,
            recover: async () => {
              const state = await inspect();
              this.applyLifecycleSnapshot(entry, canvasId, kind, state);
            },
          };
          entry.lifecycleRecovery = recovery;
          throw new LifecycleRegistryError();
        }
        // 확정된 업무 거절은 유지하고, 미반영이 확인된 인프라 실패는 공개 503으로 바꾼다.
        if (error instanceof BusinessError) throw error;
        throw new LifecycleRegistryError();
      }
    };
    try {
      if (entry.kind === 'runtime') {
        const runtime = await entry.initialization;
        return await runtime.exclusive(() => execute(runtime));
      }
      // control gate에 예약한 작업은 중간에 runtime 승격이 시작돼도 cold 작업으로 끝내 cycle을 만들지 않는다.
      const gate = entry.gate;
      const result = gate.then(() => execute(undefined));
      entry.gate = result.catch(() => {});
      return await result;
    } finally {
      this.endOperation(entry);
      this.release(entry);
      this.removeCleanControlEntry(entry);
    }
  }

  /** 새 시즌 runtime 슬롯을 초기화 시작 전에 차감하고 실패하면 map과 슬롯을 함께 반환한다. */
  private acquireRuntimeEntry(
    target: CanvasTarget,
    allowControlPromotion = false,
  ): RuntimeEntry {
    if (this.closing) throw this.unavailable();
    this.assertSeasonTarget(target);
    const existing = this.entries.get(target.key);
    if (existing) {
      if (existing.state !== 'active') throw this.unavailable();
      if (existing.kind === 'control') {
        // PENDING 취소 중에도 개설자 연결은 같은 entry identity와 gate를 runtime으로 승격한다.
        if (!allowControlPromotion) throw this.unavailable();
        return this.promoteControlEntry(existing, target);
      }
      if (existing.kind !== 'runtime') throw this.unavailable();
      existing.leases += 1;
      existing.lastUsedAt = Date.now();
      return existing;
    }
    if (this.seasonRuntimeCount >= this.maximumSeasonRuntimes)
      throw this.unavailable();
    this.seasonRuntimeCount += 1;
    const runtime = new CanvasRuntime(
      target,
      this.chunks,
      this.transactions,
      SEASON_RUNTIME_LIMITS,
      this.budget('season'),
    );
    const entry: RuntimeEntry = {
      kind: 'runtime',
      key: target.key,
      target,
      state: 'active',
      leases: 1,
      operations: 0,
      lastUsedAt: Date.now(),
      visibility: 'PUBLIC',
      visibilityGeneration: 0,
      lifecycleGeneration: 0,
      initialization: Promise.resolve(runtime),
    };
    entry.initialization = runtime
      .initialize()
      .then(() => {
        entry.runtime = runtime;
        return runtime;
      })
      .catch(async (error) => {
        // 초기화 실패 entry만 제거해 같은 key로 이미 교체된 객체를 지우지 않는다.
        if (this.entries.get(entry.key) === entry) {
          entry.state = 'retiring';
          this.entries.delete(entry.key);
          this.seasonRuntimeCount -= 1;
        }
        await runtime.close(false);
        throw error;
      });
    this.entries.set(entry.key, entry);
    return entry;
  }

  /** control entry 객체를 유지한 채 runtime을 붙이고 기존 gate를 첫 runtime 작업의 barrier로 옮긴다. */
  private promoteControlEntry(
    control: ControlEntry,
    target: CanvasTarget,
  ): RuntimeEntry {
    if (this.seasonRuntimeCount >= this.maximumSeasonRuntimes)
      throw this.unavailable();
    this.seasonRuntimeCount += 1;
    control.leases += 1;
    control.lastUsedAt = Date.now();
    const previousGate = control.gate;
    const runtime = new CanvasRuntime(
      target,
      this.chunks,
      this.transactions,
      SEASON_RUNTIME_LIMITS,
      this.budget('season'),
    );
    const entry = control as unknown as RuntimeEntry;
    Object.assign(entry, {
      kind: 'runtime',
      target,
      initialization: Promise.resolve(runtime),
    });
    delete (entry as RuntimeEntry & { gate?: Promise<unknown> }).gate;
    entry.initialization = runtime
      .initialize()
      .then(async () => {
        // 승격 전 control 작업을 같은 순서에서 끝낸 뒤 새 runtime gate를 공개한다.
        await runtime.exclusive(async () => previousGate.then(() => {}));
        // control entry가 미확정 결과를 보관 중이면 승격된 runtime도 입력을 열지 않는다.
        if (entry.lifecycleRecovery) runtime.markReconciling();
        else if (entry.lifecycleClosed) runtime.markClosed();
        entry.runtime = runtime;
        // 초기화와 기존 gate가 모두 끝날 때까지 control 슬롯도 예약해 상한을 넘지 않는다.
        this.controlEntryCount -= 1;
        return runtime;
      })
      .catch(async (error) => {
        await runtime.close(false);
        // 초기화 실패는 같은 객체를 control entry로 복원해 미확정 recovery를 계속 보관한다.
        if (this.entries.get(entry.key) === entry) {
          this.seasonRuntimeCount -= 1;
          Object.assign(entry, { kind: 'control', gate: previousGate });
          delete (entry as Partial<RuntimeEntry>).target;
          delete (entry as Partial<RuntimeEntry>).runtime;
          delete (entry as Partial<RuntimeEntry>).initialization;
        }
        throw error;
      });
    return entry;
  }

  /** control entry는 runtime 슬롯과 별도로 제한해 무접속 lifecycle 요청의 누적을 막는다. */
  private createControlEntry(key: CanvasKey): ControlEntry {
    if (this.controlEntryCount >= this.maximumPendingOperations)
      throw new LifecycleRegistryError();
    this.controlEntryCount += 1;
    const entry: ControlEntry = {
      kind: 'control',
      key,
      state: 'active',
      leases: 0,
      operations: 0,
      lastUsedAt: Date.now(),
      gate: Promise.resolve(),
      visibility: 'PUBLIC',
      visibilityGeneration: 0,
      lifecycleGeneration: 0,
    };
    this.entries.set(key, entry);
    return entry;
  }

  /** 실행+대기 작업 수를 즉시 차감하고 초과 요청을 별도 queue에 넣지 않는다. */
  private beginOperation(
    entry: RegistryEntry,
    kind: 'socket' | 'lifecycle',
  ): void {
    if (
      this.pendingOperations >= this.maximumPendingOperations ||
      entry.operations >= this.maximumSeasonOperations
    ) {
      this.release(entry);
      if (kind === 'lifecycle') throw new LifecycleRegistryError();
      throw new CanvasStrokeError('RATE_LIMITED', 'Too many canvas requests.');
    }
    this.pendingOperations += 1;
    entry.operations += 1;
  }

  private endOperation(entry: RegistryEntry): void {
    this.pendingOperations -= 1;
    entry.operations -= 1;
    entry.lastUsedAt = Date.now();
    if (entry.operations === 0 && entry.operationWaiters) {
      for (const resolve of entry.operationWaiters) resolve();
      entry.operationWaiters.clear();
      entry.operationWaiters = undefined;
    }
  }

  private beginMainOperation(): void {
    if (this.closing) throw this.unavailable();
    this.mainOperations += 1;
  }

  private endMainOperation(): void {
    this.mainOperations -= 1;
    if (this.mainOperations !== 0) return;
    for (const resolve of this.mainOperationWaiters) resolve();
    this.mainOperationWaiters.clear();
  }

  private waitForOperations(entry: RegistryEntry): Promise<void> {
    if (entry.operations === 0) return Promise.resolve();
    return new Promise((resolve) => {
      (entry.operationWaiters ??= new Set()).add(resolve);
    });
  }

  private waitForMainOperations(): Promise<void> {
    if (this.mainOperations === 0) return Promise.resolve();
    return new Promise((resolve) => this.mainOperationWaiters.add(resolve));
  }

  private release(entry: RegistryEntry): void {
    if (entry.leases > 0) entry.leases -= 1;
    entry.lastUsedAt = Date.now();
  }

  /** normal control 작업은 즉시 제거하고 결과 미확정 entry만 sweep 복구까지 보관한다. */
  private removeCleanControlEntry(entry: RegistryEntry): void {
    if (
      entry.kind !== 'control' ||
      entry.leases !== 0 ||
      entry.operations !== 0 ||
      entry.lifecycleRecovery ||
      this.entries.get(entry.key) !== entry
    )
      return;
    entry.state = 'retiring';
    this.entries.delete(entry.key);
    this.controlEntryCount -= 1;
  }

  /** 확정 DB snapshot으로 runtime 입력 상태·취소 공개범위·상태 알림을 함께 갱신한다. */
  private applyLifecycleSnapshot(
    entry: RegistryEntry,
    canvasId: string,
    kind: 'cancel' | 'end',
    state: LifecycleSnapshot,
  ): void {
    const closed = this.isClosed(state);
    entry.lifecycleClosed = closed;
    if (entry.kind === 'runtime' && entry.runtime) {
      if (closed) entry.runtime.markClosed();
      else entry.runtime.markOpen();
    }
    // 취소 표식은 모든 관찰 경로에서 비공개로 만들고, 미반영 취소만 PUBLIC으로 복원한다.
    if (state.cancelledAt !== null) this.setVisibility(entry, 'CANCELLED');
    else if (kind === 'cancel') this.setVisibility(entry, 'PUBLIC');
    entry.lifecycleSignature = this.lifecycleSignature(state);
    entry.lifecycleGeneration += 1;
    this.notifyLifecycle({
      canvasId,
      kind:
        state.cancelledAt !== null || kind === 'cancel'
          ? 'visibility'
          : 'state',
      state,
    });
  }

  /** final ready가 읽은 DB 상태를 event 기준으로 seed해 예약→진행 경계를 놓치지 않는다. */
  private observeConnectionLifecycle(
    entry: RegistryEntry,
    state: LifecycleSnapshot,
  ): void {
    if (
      this.entries.get(entry.key) !== entry ||
      entry.lifecycleRecovery ||
      entry.kind !== 'runtime' ||
      !entry.runtime
    )
      return;
    const closed = this.isClosed(state);
    // handshake 전에 시작한 조회가 늦게 끝나도 이미 확인한 종료 상태와 알림을 덮지 않는다.
    if (!closed && entry.runtime.lifecycleClosed) return;
    const signature = this.lifecycleSignature(state);
    const previous = entry.lifecycleSignature;
    entry.lifecycleClosed = closed;
    entry.lifecycleSignature = signature;
    entry.lifecycleGeneration += 1;
    if (closed) entry.runtime.markClosed();
    else entry.runtime.markOpen();
    if (state.cancelledAt !== null && entry.visibility !== 'CANCELLED')
      this.setVisibility(entry, 'CANCELLED');
    // 기존 관람자가 있으면 새 연결이 먼저 본 시작·종료 경계도 room 상태 알림으로 공개한다.
    if (previous !== undefined && previous !== signature)
      this.notifyLifecycle({
        canvasId: entry.target.id,
        kind: state.cancelledAt === null ? 'state' : 'visibility',
        state,
      });
  }

  /** ACK 직전 검사에서 읽을 현재 공개 세대를 동기적으로 반환한다. */
  visibility(canvasId: string): CanvasVisibilitySnapshot {
    const entry = this.entries.get(`season:${canvasId.toLowerCase()}`);
    return entry
      ? this.visibilityOf(entry)
      : { visibility: 'PUBLIC', generation: 0 };
  }

  /** lifecycle 변경 listener는 동기 호출되며 실패한 listener가 확정 상태를 되돌리지 못하게 한다. */
  onLifecycleChange(listener: (change: LifecycleChange) => void): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /** resident runtime의 현재 epoch와 승인 head를 DB 호출 없이 읽는다. */
  boundary(
    canvasId: string,
  ): { epoch: string; headSequence: string } | undefined {
    const entry = this.entries.get(`season:${canvasId.toLowerCase()}`);
    return entry?.kind === 'runtime' ? entry.runtime?.boundary : undefined;
  }

  private visibilityOf(entry: RegistryEntry): CanvasVisibilitySnapshot {
    return {
      visibility: entry.visibility,
      generation: entry.visibilityGeneration,
    };
  }

  private setVisibility(
    entry: RegistryEntry,
    visibility: CanvasVisibility,
  ): void {
    entry.visibility = visibility;
    entry.visibilityGeneration += 1;
  }

  private isClosed(state: LifecycleSnapshot): boolean {
    return (
      state.cancelledAt !== null ||
      state.forceEndedAt !== null ||
      state.observedAt.getTime() >= state.endsAt.getTime()
    );
  }

  /** 시각 자체가 아니라 공개 상태 경계를 signature에 넣어 매초 중복 알림을 피한다. */
  private lifecycleSignature(state: LifecycleSnapshot): string {
    const observed = state.observedAt.getTime();
    const status =
      state.cancelledAt !== null
        ? 'cancelled'
        : state.forceEndedAt !== null || observed >= state.endsAt.getTime()
          ? 'ended'
          : observed < state.startsAt.getTime()
            ? 'scheduled'
            : 'active';
    return [
      status,
      state.startsAt.toISOString(),
      state.endsAt.toISOString(),
      state.cancelledAt?.toISOString() ?? '',
      state.forceEndedAt?.toISOString() ?? '',
    ].join(':');
  }

  private notifyLifecycle(change: LifecycleChange): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(change);
      } catch (error) {
        this.logger.error(
          `Canvas lifecycle listener failed for season:${change.canvasId}.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  /** resident runtime에 최신 DB lifecycle을 적용하고 상태가 달라진 연결에 accepted head를 알린다. */
  private applyResidentSnapshot(
    entry: RuntimeEntry,
    canvasId: string,
    state: LifecycleSnapshot,
  ): void {
    const runtime = entry.runtime!;
    const signature = this.lifecycleSignature(state);
    const previous = entry.lifecycleSignature;
    const closed = this.isClosed(state);
    // DB에서 확인한 종료는 되돌릴 수 없으므로 지연된 active 조회 결과 전체를 버린다.
    if (!closed && runtime.lifecycleClosed) return;
    const becameClosed = closed && runtime.state !== 'CLOSED';
    if (closed) runtime.markClosed();
    else runtime.markOpen();
    if (state.cancelledAt !== null && entry.visibility !== 'CANCELLED')
      this.setVisibility(entry, 'CANCELLED');
    entry.lifecycleSignature = signature;
    entry.lifecycleClosed = closed;
    entry.lifecycleGeneration += 1;

    // 상태 알림은 저장 성공을 뜻하지 않으므로 dirty queue flush보다 먼저 accepted head를 공개한다.
    if (becameClosed || (previous !== undefined && previous !== signature))
      this.notifyLifecycle({
        canvasId,
        kind: state.cancelledAt === null ? 'state' : 'visibility',
        state,
      });
  }

  /** registry 한 곳에서 시즌 flush·복구·clean idle eviction을 매초 한 번씩 예약한다. */
  private sweep(): void {
    if (this.closing) return;
    const now = Date.now();
    this.scheduleStateSweep();
    for (const entry of this.entries.values()) {
      if (entry.state !== 'active' || entry.maintenance) continue;
      if (entry.lifecycleRecovery) {
        const recovery = entry.lifecycleRecovery;
        if (now < recovery.nextAttemptAt) continue;
        this.scheduleMaintenance(entry, 'lifecycle_recovery', () =>
          this.runEntryGate(entry, async () => {
            // 다른 경로가 recovery를 교체했다면 오래된 inspect 결과를 적용하지 않는다.
            if (entry.lifecycleRecovery !== recovery) return;
            try {
              await recovery.recover();
              if (entry.lifecycleRecovery === recovery)
                entry.lifecycleRecovery = undefined;
              this.removeCleanControlEntry(entry);
            } catch (error) {
              if (entry.lifecycleRecovery === recovery) {
                recovery.attempt += 1;
                const delays = [1000, 2000, 4000, 8000, 16000, 30000];
                recovery.nextAttemptAt =
                  Date.now() + delays[Math.min(recovery.attempt, 5)];
              }
              throw error;
            }
          }),
        );
        continue;
      }
      // batch 상태 query가 잡은 entry는 결과 적용이 끝날 때까지 일반 flush·eviction이 선점하지 않는다.
      if (entry.stateObservationGeneration !== undefined) continue;
      if (entry.kind === 'runtime' && entry.runtime?.needsCommitRecovery) {
        this.scheduleMaintenance(entry, 'commit_recovery', () =>
          this.runEntryGate(entry, async () => {
            const runtime = entry.runtime!;
            // chunk 결과를 먼저 확정하고, 새 DB 시각의 종료 상태까지 적용한 뒤 입력 차단을 해제한다.
            await runtime.recoverPendingCommit();
            if (!this.seasonCanvases) {
              runtime.confirmCommitRecovery();
              await runtime.flush();
              return;
            }
            const states = await this.seasonCanvases.states([entry.target.id]);
            const state = states.get(entry.target.id);
            if (!state) throw this.unavailable();
            this.applyResidentSnapshot(entry, entry.target.id, state);
            runtime.confirmCommitRecovery();
            if (runtime.needsMaintenance) await runtime.flush();
          }),
        );
        continue;
      }
      if (entry.kind === 'runtime' && entry.runtime?.needsMaintenance) {
        this.scheduleMaintenance(entry, 'flush', () =>
          entry.runtime!.maintain(),
        );
        continue;
      }
      if (
        entry.kind === 'runtime' &&
        entry.runtime &&
        entry.leases === 0 &&
        entry.operations === 0 &&
        !entry.runtime.evictionBlocked &&
        now - entry.lastUsedAt >= this.idleMilliseconds
      ) {
        // clean entry를 retiring으로 바꾸고 map에서 제거한 뒤 cache만 폐기한다.
        entry.state = 'retiring';
        this.entries.delete(entry.key);
        this.seasonRuntimeCount -= 1;
        void entry.runtime.close(false);
      }
    }
  }

  /** resident 시즌 상태를 한 DB query로 읽고 query 시작 뒤 바뀐 entry 결과는 버린다. */
  private scheduleStateSweep(): void {
    // 직접 생성하는 기존 main 검사에는 query 인자가 없으므로 시즌 resident가 있을 때만 사용한다.
    if (this.stateSweep || !this.seasonCanvases) return;
    const candidates = [...this.entries.values()].flatMap((entry) => {
      if (
        entry.state !== 'active' ||
        entry.kind !== 'runtime' ||
        !entry.runtime ||
        entry.maintenance ||
        entry.lifecycleRecovery ||
        entry.runtime.needsCommitRecovery ||
        entry.stateObservationGeneration !== undefined ||
        this.canEvict(entry, Date.now())
      )
        return [];
      const generation = entry.lifecycleGeneration;
      entry.stateObservationGeneration = generation;
      return [
        {
          entry,
          canvasId: entry.target.id,
          generation,
        },
      ];
    });
    if (candidates.length === 0) return;
    this.stateSweep = this.seasonCanvases
      .states(candidates.map((candidate) => candidate.canvasId))
      .then((states) => {
        if (this.closing) return;
        for (const candidate of candidates) {
          const { entry, canvasId, generation } = candidate;
          const state = states.get(canvasId);
          if (
            !state ||
            this.entries.get(entry.key) !== entry ||
            entry.state !== 'active' ||
            entry.lifecycleGeneration !== generation ||
            entry.lifecycleRecovery ||
            entry.maintenance ||
            entry.runtime?.needsCommitRecovery ||
            entry.stateObservationGeneration !== generation
          ) {
            if (entry.stateObservationGeneration === generation)
              entry.stateObservationGeneration = undefined;
            continue;
          }
          entry.stateObservationGeneration = undefined;
          this.scheduleMaintenance(entry, 'lifecycle_state_flush', () =>
            this.runEntryGate(entry, async () => {
              // DB query 뒤 lifecycle이 시작됐으면 오래된 active snapshot을 적용하지 않는다.
              if (
                this.entries.get(entry.key) !== entry ||
                entry.lifecycleGeneration !== generation ||
                entry.lifecycleRecovery ||
                entry.kind !== 'runtime' ||
                !entry.runtime ||
                entry.runtime.needsCommitRecovery
              )
                return;
              this.applyResidentSnapshot(entry, canvasId, state);
              let flushError: unknown;
              if (entry.runtime.needsMaintenance) {
                try {
                  // active queue와 종료된 부분 획 모두 현재 승인 head까지만 그대로 저장한다.
                  await entry.runtime.flush();
                } catch (error) {
                  flushError = error;
                }
              }
              if (flushError) throw flushError;
            }),
          );
        }
      })
      .catch((error) => {
        for (const canvasId of new Set(
          candidates.map((candidate) => candidate.canvasId),
        ))
          this.logFailure(canvasId, 'lifecycle_state_query', error);
      })
      .finally(() => {
        for (const { entry, generation } of candidates) {
          if (entry.stateObservationGeneration === generation)
            entry.stateObservationGeneration = undefined;
        }
        this.stateSweep = undefined;
      });
  }

  /** 내부 유지보수는 client operation 상한과 분리하되 entry당 하나만 실행한다. */
  private scheduleMaintenance(
    entry: RegistryEntry,
    stage: string,
    work: () => Promise<void>,
  ): void {
    if (this.closing) return;
    entry.leases += 1;
    entry.maintenance = work()
      .catch((error) => this.logFailure(this.canvasId(entry), stage, error))
      .finally(() => {
        entry.maintenance = undefined;
        // 내부 sweep 자체는 client 사용이 아니므로 idle 기준 시각을 연장하지 않고 pin만 반환한다.
        if (entry.leases > 0) entry.leases -= 1;
        this.removeCleanControlEntry(entry);
      });
  }

  private canEvict(entry: RuntimeEntry, now: number): boolean {
    return (
      entry.runtime !== undefined &&
      entry.leases === 0 &&
      entry.operations === 0 &&
      !entry.runtime.evictionBlocked &&
      now - entry.lastUsedAt >= this.idleMilliseconds
    );
  }

  /** 복구도 connect와 lifecycle이 공유하는 같은 entry gate에서 직렬화한다. */
  private async runEntryGate(
    entry: RegistryEntry,
    work: () => Promise<void>,
  ): Promise<void> {
    if (entry.kind === 'runtime') {
      const runtime = await entry.initialization;
      await runtime.exclusive(work);
      return;
    }
    const result = entry.gate.then(work);
    entry.gate = result.catch(() => {});
    await result;
  }

  /** main 예약분과 시즌 사용분을 분리해 한쪽의 미사용분을 다른 쪽에 빌려주지 않는다. */
  private budget(kind: CanvasTarget['kind']): CanvasRuntimeBudget {
    return {
      reservePending: (bytes) => {
        if (kind === 'main') {
          if (this.mainPendingBytes + bytes > MAIN_PENDING_RESERVE)
            return false;
          this.mainPendingBytes += bytes;
          return true;
        }
        if (
          this.seasonPendingBytes + bytes >
          this.maximumPendingBytes - MAIN_PENDING_RESERVE
        )
          return false;
        this.seasonPendingBytes += bytes;
        return true;
      },
      releasePending: (bytes) => {
        if (kind === 'main') this.mainPendingBytes -= bytes;
        else this.seasonPendingBytes -= bytes;
      },
      reserveCache: (bytes) => {
        if (kind === 'main') {
          if (this.mainCacheBytes + bytes > MAIN_CACHE_RESERVE) return false;
          this.mainCacheBytes += bytes;
          return true;
        }
        if (
          this.seasonCacheBytes + bytes >
          this.maximumCacheBytes - MAIN_CACHE_RESERVE
        )
          return false;
        this.seasonCacheBytes += bytes;
        return true;
      },
      releaseCache: (bytes) => {
        if (kind === 'main') this.mainCacheBytes -= bytes;
        else this.seasonCacheBytes -= bytes;
      },
    };
  }

  private assertSeasonTarget(target: CanvasTarget): void {
    if (
      target.kind !== 'season' ||
      target.key !== `season:${target.id.toLowerCase()}`
    )
      throw this.unavailable();
  }

  private unavailable(): CanvasStrokeError {
    return new CanvasStrokeError(
      'REALTIME_UNAVAILABLE',
      'Realtime service is temporarily unavailable.',
    );
  }

  private canvasId(entry: RegistryEntry): string {
    return entry.kind === 'runtime'
      ? entry.target.id
      : entry.key.slice('season:'.length);
  }

  /** 운영 로그에는 캔버스와 실패 단계만 식별하고 인증값이나 그림 payload는 넣지 않는다. */
  private logFailure(canvasId: string, stage: string, error: unknown): void {
    const description =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : 'Non-Error rejection';
    this.logger.error(
      `Canvas runtime failure canvasId=${canvasId || 'main'} stage=${stage} error=${description}`,
      error instanceof Error ? error.stack : undefined,
    );
  }

  /** 서버 종료에서는 새 작업을 막고 모든 runtime을 독립적으로 flush한 뒤 실패를 합쳐 반환한다. */
  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.closing = true;
    clearInterval(this.sweepTimer);
    this.shutdownWork = this.finishShutdown();
    return this.shutdownWork;
  }

  private async finishShutdown(): Promise<void> {
    const failures: unknown[] = [];
    if (this.stateSweep) {
      try {
        await this.stateSweep;
      } catch (error) {
        this.logFailure('registry', 'state_sweep', error);
        failures.push(error);
      }
    }
    const entries = [...this.entries.values()];
    for (const entry of entries) entry.state = 'retiring';
    this.entries.clear();
    const shutdowns = entries.map((entry) => this.closeEntry(entry));
    if (this.mainInitialization) {
      shutdowns.push(this.closeMain());
    }
    const results = await Promise.allSettled(shutdowns);
    for (const result of results)
      if (result.status === 'rejected') failures.push(result.reason);
    this.seasonRuntimeCount = 0;
    this.controlEntryCount = 0;
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `${failures.length} canvas shutdown operation(s) failed.`,
      );
  }

  private async closeEntry(entry: RegistryEntry): Promise<void> {
    const canvasId = this.canvasId(entry);
    const failures: unknown[] = [];
    await this.waitForOperations(entry);
    try {
      await entry.maintenance;
    } catch (error) {
      this.logFailure(canvasId, 'shutdown_maintenance', error);
      failures.push(error);
    }
    // closing 뒤 새 recovery를 시작하지 않으며, 미확정 lifecycle 결과는 정상 종료로 숨기지 않는다.
    if (entry.lifecycleRecovery) {
      const error = new Error(
        'Lifecycle recovery remained unresolved at shutdown.',
      );
      this.logFailure(canvasId, 'shutdown_recovery_pending', error);
      failures.push(error);
    }
    if (entry.kind === 'control') {
      try {
        await entry.gate;
      } catch (error) {
        this.logFailure(canvasId, 'shutdown_gate', error);
        failures.push(error);
      }
    } else {
      let runtime: CanvasRuntime | undefined;
      try {
        runtime = await entry.initialization;
      } catch (error) {
        this.logFailure(canvasId, 'shutdown_initialization', error);
        failures.push(error);
      }
      if (runtime) {
        try {
          await runtime.close(true);
        } catch (error) {
          this.logFailure(canvasId, 'shutdown_flush', error);
          failures.push(error);
        }
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Canvas shutdown failed for ${canvasId}.`,
      );
  }

  private async closeMain(): Promise<void> {
    await this.waitForMainOperations();
    let runtime: CanvasRuntime;
    try {
      runtime = await this.mainInitialization!;
    } catch (error) {
      this.logFailure('main', 'shutdown_initialization', error);
      throw error;
    }
    try {
      await runtime.close(true);
    } catch (error) {
      this.logFailure(runtime.target.id || 'main', 'shutdown_flush', error);
      throw error;
    }
  }
}
