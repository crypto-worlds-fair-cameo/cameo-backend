import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { getSeasonStatus } from '../../../seasons/resources/season/season-state';
import {
  CanvasAccess,
  type CanvasViewerAccess,
} from '../canvas-access/canvas-access';
import { CanvasDefinition } from '../canvas-definition/canvas-definition';
import {
  parseCanvasKey,
  type CanvasTarget,
} from '../canvas-definition/canvas-target';
import { CanvasDrawing } from '../canvas-drawing/canvas-drawing';
import type {
  CanvasConnectionLease,
  CanvasVisibilitySnapshot,
  LifecycleChange,
} from '../canvas-drawing/canvas-runtime-registry';
import {
  CanvasStrokeError,
  type CanvasAckCallback,
  type StrokePreview,
} from '../canvas-stroke/canvas-stroke';
import {
  canvasRoom,
  type CanvasConnectionReset,
  type CanvasNamespace,
  type CanvasSocket,
  type SeasonConnectionReady,
  type SeasonStateEvent,
} from './canvas-events';

export type CanvasBinding = Readonly<{
  socket: CanvasSocket;
  target: CanvasTarget;
  viewerId: string | undefined;
  isCreator: boolean;
  room: string;
  lease: CanvasConnectionLease;
  visibilityGeneration: number;
  onClientEvent: (event: string) => void;
}>;

/** 한 프로세스의 server binding, 전송 제한, 방별 방송과 lease 정리를 소유한다. */
@Injectable()
export class CanvasConnections
  implements OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(CanvasConnections.name);
  private readonly requests = new Map<
    string,
    Map<string, { startedAt: number; count: number; busy: boolean }>
  >();
  private namespace?: CanvasNamespace;
  private readonly bindings = new Map<string, CanvasBinding>();
  private readonly connecting = new Set<string>();
  private readonly pendingPresenceRooms = new Set<string>();
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private unsubscribeLifecycle?: () => void;
  private closing = false;

  constructor(
    private readonly access: CanvasAccess,
    private readonly drawing: CanvasDrawing,
    private readonly definitions: CanvasDefinition,
  ) {}

  /** Gateway namespace와 lifecycle 알림을 연결하고 종료 중인 서버에는 새 합류를 허용하지 않는다. */
  initialize(namespace: CanvasNamespace): void {
    this.namespace = namespace;
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = this.drawing.onLifecycleChange((change) =>
      this.handleLifecycleChange(change),
    );
    namespace.use((_socket, next) => {
      if (this.closing) {
        next(
          Object.assign(
            new Error('Realtime service is temporarily unavailable.'),
            {
              data: {
                code: 'REALTIME_UNAVAILABLE',
                retryable: true,
                retryAfterMs: 1000,
              },
            },
          ),
        );
        return;
      }
      next();
    });
  }

  /** handshake key를 server target에 묶고 같은 gate 안에서 공개 재검사·room 합류·ready를 끝낸다. */
  async connect(socket: CanvasSocket): Promise<void> {
    if (
      !socket.connected ||
      this.bindings.has(socket.id) ||
      this.connecting.has(socket.id)
    )
      return;
    if (this.closing) {
      this.reset(socket, {
        reason: 'server_shutdown',
        retryable: true,
        retryAfterMs: 1000,
      });
      return;
    }

    this.connecting.add(socket.id);
    // 초기화나 room 합류 중 disconnect도 뒤늦게 얻은 lease를 즉시 반환하게 한다.
    socket.once('disconnect', () => this.disconnect(socket.id));
    try {
      let key;
      try {
        key = parseCanvasKey(socket.handshake.auth?.canvasKey);
      } catch {
        this.reset(socket, {
          reason: 'invalid_canvas_key',
          retryable: false,
          retryAfterMs: 0,
        });
        return;
      }

      const target = await this.definitions.resolve(key);
      if (!target) {
        this.reset(socket, {
          reason: 'canvas_unavailable',
          retryable: false,
          retryAfterMs: 0,
        });
        return;
      }
      const initialAccess = await this.access.viewer(
        socket.handshake.headers.cookie,
        target,
      );
      const viewerId = initialAccess.viewer.userId ?? undefined;
      const isCreator = initialAccess.season?.isCreator ?? false;
      const room = canvasRoom(target.key);

      await this.drawing.leaseConnection(
        target,
        socket.id,
        isCreator,
        async (lease, visibility) => {
          this.assertConnected(socket);
          this.assertVisibility(visibility, isCreator);

          // runtime 초기화 뒤 최신 DB 공개범위를 읽어 취소가 room 합류를 앞지르게 한다.
          let readyAccess = initialAccess;
          if (target.kind === 'season') {
            const season = await this.access.season(target.id, viewerId);
            readyAccess = this.withSeason(initialAccess, season);
          }
          this.assertConnected(socket);
          await socket.join(room);
          this.assertConnected(socket);

          // join 대기 중 다른 프로세스가 취소했어도 binding과 ready를 공개하지 않는다.
          if (target.kind === 'season') {
            const season = await this.access.season(target.id, viewerId);
            readyAccess = this.withSeason(initialAccess, season);
          }
          this.assertConnected(socket);
          const currentVisibility = this.drawing.visibility(target.id);
          this.assertVisibility(currentVisibility, isCreator);
          if (currentVisibility.generation !== visibility.generation)
            throw this.unavailable();
          if (target.kind === 'season') {
            const season = readyAccess.season!;
            // final DB 관찰 상태를 runtime에 seed해 첫 batch가 시작 경계를 이미 지난 경우도 비교할 수 있게 한다.
            lease.observeLifecycle({
              creatorId: season.creatorId,
              startsAt: season.startsAt,
              endsAt: season.endsAt,
              cancelledAt: season.cancelledAt,
              forceEndedAt: season.forceEndedAt,
              observedAt: season.observedAt,
            });
          }

          const onClientEvent = this.createMessageLimit(socket);
          const binding: CanvasBinding = {
            socket,
            target,
            viewerId,
            isCreator,
            room,
            lease,
            visibilityGeneration: currentVisibility.generation,
            onClientEvent,
          };
          this.bindings.set(socket.id, binding);
          this.requests.set(socket.id, new Map());
          socket.onAny(onClientEvent);
          this.emitReady(binding, readyAccess);
          this.schedulePresence(room);
        },
      );
    } catch (error) {
      if (!socket.connected) return;
      if (!(error instanceof CanvasStrokeError))
        this.logger.error(
          'Canvas connection initialization failed.',
          error instanceof Error ? error.stack : String(error),
        );
      const unavailable =
        error instanceof CanvasStrokeError && error.code === 'CANVAS_NOT_FOUND'
          ? ({
              reason: 'canvas_unavailable',
              retryable: false,
              retryAfterMs: 0,
            } as const)
          : ({
              reason: 'realtime_unavailable',
              retryable: true,
              retryAfterMs: 1000,
            } as const);
      this.reset(socket, unavailable);
    } finally {
      this.connecting.delete(socket.id);
    }
  }

  /** gateway가 payload 대신 사용할 살아 있는 server binding을 반환한다. */
  binding(socket: CanvasSocket): CanvasBinding {
    const binding = this.bindings.get(socket.id);
    if (!binding || !socket.connected) throw this.unavailable();
    if (binding.target.kind === 'season')
      this.assertVisibility(
        this.drawing.visibility(binding.target.id),
        binding.isCreator,
      );
    return binding;
  }

  /** lease를 먼저 반환한 뒤 binding과 제한 상태를 제거하고 해당 방의 presence를 갱신한다. */
  private disconnect(connectionId: string): void {
    const binding = this.bindings.get(connectionId);
    if (!binding) return;
    binding.socket.offAny(binding.onClientEvent);
    binding.lease.release();
    this.requests.delete(connectionId);
    this.bindings.delete(connectionId);
    this.schedulePresence(binding.room);
  }

  /** 여러 방의 잦은 변화를 250ms 단위로 합쳐 각 room의 준비 완료 연결 수를 보낸다. */
  private schedulePresence(room: string): void {
    if (this.closing) return;
    this.pendingPresenceRooms.add(room);
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      const rooms = [...this.pendingPresenceRooms];
      this.pendingPresenceRooms.clear();
      for (const pendingRoom of rooms) {
        const bindings = [...this.bindings.values()].filter(
          (binding) => binding.room === pendingRoom,
        );
        const key = bindings[0]?.target.key;
        // 빈 방에는 받을 연결이 없고 key를 client 입력에서 다시 만들지 않는다.
        if (!key) continue;
        this.namespace?.to(pendingRoom).emit('canvas:presence', {
          canvasKey: key,
          connectionCount: bindings.length,
        });
      }
    }, 250);
    this.presenceTimer.unref();
  }

  /** 지원하지 않는 앱 이벤트는 무시하고 10초에 10개를 넘긴 연결만 종료한다. */
  private createMessageLimit(socket: CanvasSocket): (event: string) => void {
    let windowStartedAt = Date.now();
    let messages = 0;
    return (event) => {
      // 지원 이벤트는 별도의 빈도·동시 요청 제한을 적용한다.
      if (['stroke:append', 'canvas:sync', 'canvas:bootstrap'].includes(event))
        return;
      const now = Date.now();
      if (now - windowStartedAt >= 10_000) {
        windowStartedAt = now;
        messages = 0;
      }
      messages += 1;
      if (messages > 10) {
        this.reset(socket, {
          reason: 'connection_policy',
          retryable: false,
          retryAfterMs: 0,
        });
      }
    };
  }

  /** 전송별 빈도와 동시 요청을 제한하고 sync ACK 직전 binding 세대를 다시 확인한다. */
  async respond<T>(
    socket: CanvasSocket,
    event: 'stroke:append' | 'canvas:sync' | 'canvas:bootstrap',
    ack: CanvasAckCallback<T>,
    operation: () => Promise<T>,
  ): Promise<void> {
    // ACK 없는 요청은 실행하지 않아 좌표 묶음의 수신 결과를 확인할 수 있게 한다.
    if (typeof ack !== 'function') return;
    const binding = this.bindings.get(socket.id);
    const windows = this.requests.get(socket.id);
    if (!binding || !windows || this.closing) {
      ack({
        ok: false,
        error: {
          code: 'REALTIME_UNAVAILABLE',
          message: 'Realtime service is temporarily unavailable.',
        },
      });
      return;
    }
    const generation =
      binding.target.kind === 'season'
        ? this.drawing.visibility(binding.target.id).generation
        : 0;
    const now = Date.now();
    const duration = 1000;
    const maximum = event === 'stroke:append' ? 30 : 5;
    let state = windows.get(event);
    if (!state) {
      state = { startedAt: now, count: 0, busy: false };
      windows.set(event, state);
    }
    if (now - state.startedAt >= duration) {
      state.startedAt = now;
      state.count = 0;
    }
    state.count += 1;
    if (state.busy || state.count > maximum) {
      ack({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'Too many canvas requests.' },
      });
      return;
    }
    state.busy = true;
    try {
      const data = await operation();
      // 이 검사부터 ACK 호출까지 await하지 않아 취소 generation이 바뀐 결과를 내보내지 않는다.
      if (
        (event === 'canvas:sync' || event === 'canvas:bootstrap') &&
        !this.canAcknowledge(binding, generation)
      )
        throw this.unavailable();
      ack({ ok: true, data });
    } catch (error: unknown) {
      // 업무 거절만 공개하고 DB·네트워크 오류의 상세 내용은 서버 로그에 남긴다.
      if (!(error instanceof CanvasStrokeError))
        this.logger.error(
          'Canvas request failed.',
          error instanceof Error ? error.stack : String(error),
        );
      ack({
        ok: false,
        error:
          error instanceof CanvasStrokeError
            ? { code: error.code, message: error.message }
            : {
                code: 'REALTIME_UNAVAILABLE',
                message: 'Realtime service is temporarily unavailable.',
              },
      });
    } finally {
      state.busy = false;
      // 인증 대기 중 연결이 끊긴 경우에도 늦게 생성된 인증 캐시를 남기지 않는다.
      if (!socket.connected) binding.lease.runtime.disconnect(socket.id);
    }
  }

  /** 승인된 preview를 요청 시작 때 검증한 방에 전달하며, 제출자 연결 상태에는 의존하지 않는다. */
  preview(binding: CanvasBinding, payload: StrokePreview): void {
    const namespace = this.namespace;
    // 서버가 만든 preview가 binding과 다르거나 방송 서버가 없으면 다른 방으로 전달하지 않는다.
    if (!namespace || payload.canvasKey !== binding.target.key) return;
    // 취소가 확정된 시즌만 차단하고, 판정 대기 중인 PENDING에는 이미 승인된 좌표를 보존한다.
    if (
      binding.target.kind === 'season' &&
      this.drawing.visibility(binding.target.id).visibility === 'CANCELLED'
    )
      return;
    const room = namespace.to(binding.room).except(binding.socket.id);
    if (payload.isFinal) room.emit('stroke:preview', payload);
    else room.volatile.emit('stroke:preview', payload);
  }

  private canAcknowledge(binding: CanvasBinding, generation: number): boolean {
    if (
      !binding.socket.connected ||
      this.bindings.get(binding.socket.id) !== binding
    )
      return false;
    if (binding.target.kind === 'main') return true;
    const current = this.drawing.visibility(binding.target.id);
    return (
      current.generation === generation &&
      (binding.isCreator || current.visibility === 'PUBLIC')
    );
  }

  private emitReady(binding: CanvasBinding, access: CanvasViewerAccess): void {
    const connectionCount = [...this.bindings.values()].filter(
      (candidate) => candidate.room === binding.room,
    ).length;
    if (binding.target.kind === 'main') {
      // main protocolVersion 1 객체의 기존 필드와 의미는 그대로 유지한다.
      binding.socket.emit('connection:ready', {
        protocolVersion: 1,
        canvasKey: 'main',
        viewer: access.viewer,
        canDraw: access.canDraw,
        presence: { connectionCount },
      });
      return;
    }
    const season = access.season!;
    const ready: SeasonConnectionReady = {
      protocolVersion: 1,
      canvasKey: binding.target.key as `season:${string}`,
      viewer: access.viewer,
      canDraw: access.canDraw,
      presence: { connectionCount },
      season: {
        width: binding.target.width,
        height: binding.target.height,
        strokeLimitPerUser: binding.target.strokeLimitPerUser,
        startsAt: season.startsAt.toISOString(),
        endsAt: season.endsAt.toISOString(),
        cancelledAt: season.cancelledAt?.toISOString() ?? null,
        forceEndedAt: season.forceEndedAt?.toISOString() ?? null,
        status: season.status,
        isParticipant: season.isParticipant,
        isCreator: season.isCreator,
      },
      serverTime: season.observedAt.toISOString(),
    };
    binding.socket.emit('connection:ready', ready);
  }

  private withSeason(
    access: CanvasViewerAccess,
    season: NonNullable<CanvasViewerAccess['season']>,
  ): CanvasViewerAccess {
    const status = getSeasonStatus(season, season.observedAt);
    return {
      ...access,
      canDraw: this.access.canDrawSeason(access.viewer.userId ?? undefined, {
        status,
        isParticipant: season.isParticipant,
      }),
      season: {
        ...season,
        status,
        isCreator: access.viewer.userId === season.creatorId,
      },
    };
  }

  /** 취소 확정 시 비개설자를 회수하고 남은 공개 대상에 같은 runtime 상태를 알린다. */
  private handleLifecycleChange(change: LifecycleChange): void {
    const key = `season:${change.canvasId.toLowerCase()}` as const;
    const affected = [...this.bindings.values()].filter(
      (binding) => binding.target.key === key,
    );
    if (change.state.cancelledAt !== null) {
      for (const binding of affected) {
        if (!binding.isCreator)
          this.reset(binding.socket, {
            reason: 'canvas_unavailable',
            retryable: false,
            retryAfterMs: 0,
          });
      }
    }
    const boundary = this.drawing.boundary(change.canvasId);
    if (!boundary) return;
    const event: SeasonStateEvent = {
      canvasKey: key,
      status: getSeasonStatus(change.state, change.state.observedAt),
      startsAt: change.state.startsAt.toISOString(),
      endsAt: change.state.endsAt.toISOString(),
      cancelledAt: change.state.cancelledAt?.toISOString() ?? null,
      forceEndedAt: change.state.forceEndedAt?.toISOString() ?? null,
      serverTime: change.state.observedAt.toISOString(),
      ...boundary,
    };
    // 취소 확정 상태는 회수 후 남은 개설자 binding에만 보낸다.
    if (change.state.cancelledAt !== null) {
      for (const binding of this.bindings.values()) {
        if (binding.target.key === key && binding.isCreator)
          binding.socket.emit('season:state', event);
      }
      return;
    }
    // room 합류 중인 socket은 ready 전이므로 server binding이 끝난 연결에만 상태를 보낸다.
    for (const binding of affected) binding.socket.emit('season:state', event);
  }

  private assertVisibility(
    visibility: CanvasVisibilitySnapshot,
    isCreator: boolean,
  ): void {
    if (isCreator || visibility.visibility === 'PUBLIC') return;
    if (visibility.visibility === 'CANCELLED')
      throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
    throw this.unavailable();
  }

  private assertConnected(socket: CanvasSocket): void {
    if (!socket.connected || this.closing) throw this.unavailable();
  }

  private unavailable(): CanvasStrokeError {
    return new CanvasStrokeError(
      'REALTIME_UNAVAILABLE',
      'Realtime service is temporarily unavailable.',
    );
  }

  /** 알림 전달 여부와 관계없이 연결을 닫는다. 클라이언트는 disconnect로 종료를 확정한다. */
  private reset(socket: CanvasSocket, notice: CanvasConnectionReset): void {
    if (!socket.connected) return;
    socket.emit('connection:reset', notice);
    socket.disconnect(true);
  }

  /** runtime flush가 시작되기 전에 새 합류를 막고 연결 lease를 반환한다. */
  onModuleDestroy(): void {
    this.closeConnections();
  }

  /** Nest의 후속 종료 hook에서도 같은 정리를 멱등하게 보장한다. */
  beforeApplicationShutdown(): void {
    this.closeConnections();
  }

  private closeConnections(): void {
    if (this.closing) return;
    this.closing = true;
    this.unsubscribeLifecycle?.();
    this.unsubscribeLifecycle = undefined;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    this.pendingPresenceRooms.clear();
    for (const binding of Array.from(this.bindings.values())) {
      this.reset(binding.socket, {
        reason: 'server_shutdown',
        retryable: true,
        retryAfterMs: 1000,
      });
      this.disconnect(binding.socket.id);
    }
    this.connecting.clear();
  }
}
