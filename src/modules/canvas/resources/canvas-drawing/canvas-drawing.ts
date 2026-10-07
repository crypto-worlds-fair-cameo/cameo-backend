import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BusinessError } from '../../../../business-error';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { ErrorCodes } from '../../../../errors/error-codes';
import type { CanvasTarget } from '../canvas-definition/canvas-target';
import type {
  AppendStrokeInput,
  AppendStrokeResult,
  CanvasSyncPage,
  SyncCanvasInput,
} from '../canvas-stroke/canvas-stroke';
import type {
  CanvasRuntime,
  PreparedStroke,
  StrokeState,
} from './canvas-runtime';
import {
  CanvasRuntimeRegistry,
  LifecycleRegistryError,
  type CanvasConnectionLease,
  type CanvasVisibilitySnapshot,
  type LifecycleChange,
} from './canvas-runtime-registry';

export type { PreparedStroke } from './canvas-runtime';

export type LifecycleSnapshot = Readonly<{
  creatorId: string;
  startsAt: Date;
  endsAt: Date;
  cancelledAt: Date | null;
  forceEndedAt: Date | null;
  observedAt: Date;
}>;

export type LifecycleOperation<T> = Readonly<{
  kind: 'cancel' | 'end';
  apply: () => Promise<{ result: T; state: LifecycleSnapshot }>;
  inspect: () => Promise<LifecycleSnapshot>;
}>;

/** 기존 main API를 보존하고 target별 runtime 작업을 registry callback으로 제한한다. */
@Injectable()
export class CanvasDrawing implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly registry: CanvasRuntimeRegistry) {}

  /** main runtime을 startup 필수 자원으로 초기화한 뒤 소켓 서버가 열리게 한다. */
  async onModuleInit(): Promise<void> {
    await this.registry.initializeMain();
  }

  /** callback 동안 target runtime의 operation lease와 동일 entry gate를 유지한다. */
  withCanvas<T>(
    target: CanvasTarget,
    work: (runtime: CanvasRuntime) => Promise<T>,
  ): Promise<T> {
    return this.registry.withCanvas(target, work);
  }

  /** 연결 sync 동안 별도 operation lease를 유지하되 input gate는 점유하지 않는다. */
  readCanvas<T>(
    target: CanvasTarget,
    work: (runtime: CanvasRuntime) => Promise<T>,
  ): Promise<T> {
    return this.registry.withCanvasRead(target, work);
  }

  /** 시즌 상태 변경을 runtime 또는 control entry gate에서 실행하고 자원 부족을 HTTP 업무 오류로 바꾼다. */
  async withLifecycle<T>(
    canvasId: string,
    operation: LifecycleOperation<T>,
  ): Promise<T> {
    try {
      return await this.registry.withLifecycle(
        canvasId,
        operation.kind,
        operation.apply,
        operation.inspect,
      );
    } catch (error) {
      // registry 자원 부족과 DB 결과 미확정만 안정된 시즌 503 계약으로 공개한다.
      if (error instanceof LifecycleRegistryError)
        throw new BusinessError(ErrorCodes.SeasonTemporarilyUnavailable);
      throw error;
    }
  }

  /** 연결 gate 안에서 공개범위 확인·room 합류·binding 등록을 끝내고 생존 lease를 넘긴다. */
  leaseConnection(
    target: CanvasTarget,
    connectionId: string,
    allowControlPromotion: boolean,
    enter: (
      lease: CanvasConnectionLease,
      visibility: CanvasVisibilitySnapshot,
    ) => Promise<void>,
  ): Promise<void> {
    return this.registry.leaseConnection(
      target,
      connectionId,
      allowControlPromotion,
      enter,
    );
  }

  /** 시즌 취소와 같은 entry에 저장된 공개 상태와 ACK 세대를 동기적으로 읽는다. */
  visibility(canvasId: string): CanvasVisibilitySnapshot {
    return this.registry.visibility(canvasId);
  }

  /** lifecycle 확정 알림을 프로세스 내 연결 관리자에 동기로 전달한다. */
  onLifecycleChange(listener: (change: LifecycleChange) => void): () => void {
    return this.registry.onLifecycleChange(listener);
  }

  /** 상태 이벤트에 필요한 resident runtime 경계를 DB 대기 없이 반환한다. */
  boundary(
    canvasId: string,
  ): { epoch: string; headSequence: string } | undefined {
    return this.registry.boundary(canvasId);
  }

  /** 기존 검사가 main runtime의 bounded stroke cache를 읽는 호환 경로다. */
  get strokes(): ReadonlyMap<string, StrokeState> {
    return this.registry.main().strokes;
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.registry.withMain(() => operation());
  }

  cachedUser(connectionId: string, clientStrokeId: string): string | undefined {
    return this.registry.main().cachedUser(connectionId, clientStrokeId);
  }

  prepare(
    connectionId: string,
    userId: string,
    input: AppendStrokeInput,
  ): Promise<PreparedStroke> {
    return this.registry.main().prepare(connectionId, userId, input);
  }

  finish(
    approve: (
      transaction: TransactionContext,
    ) => Promise<{ prepared: PreparedStroke; usageId: string }>,
  ): Promise<AppendStrokeResult> {
    return this.registry.main().finish(approve);
  }

  recoverCommit(
    prepared: PreparedStroke,
    usageId: string,
    persisted: boolean,
    check: () => Promise<boolean>,
  ): Promise<AppendStrokeResult | undefined> {
    return this.registry
      .main()
      .recoverCommit(prepared, usageId, persisted, check);
  }

  flush(): Promise<void> {
    return this.registry.withMainRead((runtime) => runtime.flush());
  }

  page(
    input: SyncCanvasInput & { limit: number },
    runtime?: CanvasRuntime,
  ): Promise<CanvasSyncPage> {
    // server binding이 넘긴 runtime은 이미 연결 lease가 고정하므로 input gate 없이 page를 읽는다.
    if (runtime) return runtime.page(input);
    return this.registry.withMainRead((main) => main.page(input));
  }

  connected(connectionId: string): void {
    this.registry.main().connected(connectionId);
  }

  disconnect(connectionId: string): void {
    this.registry.main().disconnect(connectionId);
  }

  clearAuthorization(connectionId: string): void {
    this.registry.main().clearAuthorization(connectionId);
  }

  /** 서버 종료에서는 새 runtime 생성을 막고 모든 target의 pending 좌표 저장을 시도한다. */
  async onModuleDestroy(): Promise<void> {
    await this.registry.shutdown();
  }
}
