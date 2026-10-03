import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { CanvasDrawing } from '../canvas-drawing/canvas-drawing';
import { CanvasAccess } from '../canvas-access/canvas-access';
import {
  CanvasStrokeError,
  type CanvasAckCallback,
  type StrokePreview,
} from '../canvas-stroke/canvas-stroke';
import {
  MAIN_CANVAS_ROOM,
  type CanvasConnectionReset,
  type CanvasNamespace,
  type CanvasSocket,
} from './canvas-events';

/** 한 프로세스의 캔버스 연결, 전송 제한, room 방송과 종료 시 자원 정리를 소유한다. */
@Injectable()
export class CanvasConnections implements BeforeApplicationShutdown {
  private readonly logger = new Logger(CanvasConnections.name);
  private readonly requests = new Map<
    string,
    Map<string, { startedAt: number; count: number; busy: boolean }>
  >();
  private namespace?: CanvasNamespace;
  private readonly connections = new Map<string, CanvasSocket>();
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private closing = false;

  constructor(
    private readonly access: CanvasAccess,
    private readonly drawing: CanvasDrawing,
  ) {}

  /** Gateway의 namespace를 연결하고 종료 중인 서버에는 새 합류를 허용하지 않는다. */
  initialize(namespace: CanvasNamespace): void {
    this.namespace = namespace;
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

  /**
   * 연결을 메인 room에 넣고 자기 연결을 포함한 초기 상태를 보낸다.
   * 쿠키는 기존 세션 인증으로 확인하며 클라이언트의 신원 주장은 사용하지 않는다.
   */
  async connect(socket: CanvasSocket): Promise<void> {
    if (!socket.connected || this.connections.has(socket.id)) return;
    if (this.closing) {
      this.reset(socket, {
        reason: 'server_shutdown',
        retryable: true,
        retryAfterMs: 1000,
      });
      return;
    }

    let access;
    try {
      access = await this.access.viewer(socket.handshake.headers.cookie);
    } catch {
      // 인증 저장소를 읽을 수 없으면 준비되지 않은 연결을 남기지 않고 재접속을 안내한다.
      this.reset(socket, {
        reason: 'server_shutdown',
        retryable: true,
        retryAfterMs: 1000,
      });
      return;
    }
    if (!socket.connected || this.closing) return;
    // 인증 대기 중 끊긴 연결은 집계하지 않고 준비된 연결만 room에 넣는다.
    void socket.join(MAIN_CANVAS_ROOM);
    this.connections.set(socket.id, socket);
    this.requests.set(socket.id, new Map());
    const onClientEvent = this.createMessageLimit(socket);
    socket.onAny(onClientEvent);
    socket.once('disconnect', () => {
      socket.offAny(onClientEvent);
      this.disconnect(socket.id);
    });

    socket.emit('connection:ready', {
      protocolVersion: 1,
      canvasKey: 'main',
      ...access,
      presence: { connectionCount: this.connections.size },
    });
    this.schedulePresence();
  }

  /** 중복 종료가 와도 한 번만 제거하고 남은 연결에 최신 집계값을 알린다. */
  private disconnect(connectionId: string): void {
    this.drawing.disconnect(connectionId);
    this.requests.delete(connectionId);
    if (!this.connections.delete(connectionId)) return;
    this.schedulePresence();
  }

  /** 잦은 접속 변화를 250ms 단위로 합치되, 새 변화가 기존 전송을 계속 미루지 않게 한다. */
  private schedulePresence(): void {
    if (this.closing || this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = undefined;
      this.namespace?.to(MAIN_CANVAS_ROOM).emit('canvas:presence', {
        canvasKey: 'main',
        connectionCount: this.connections.size,
      });
    }, 250);
    this.presenceTimer.unref();
  }

  /** 지원하지 않는 앱 이벤트는 무시하고 10초에 10개를 넘긴 연결만 종료한다. */
  private createMessageLimit(socket: CanvasSocket): (event: string) => void {
    let windowStartedAt = Date.now();
    let messages = 0;
    return (event) => {
      // 지원 이벤트는 별도의 빈도·동시 요청 제한을 적용한다.
      if (['stroke:append', 'canvas:sync'].includes(event)) return;
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

  /** 전송별 빈도와 동시에 처리할 요청 수를 제한하고 내부 오류를 공개 ACK로 바꾼다. */
  async respond<T>(
    socket: CanvasSocket,
    event: 'stroke:append' | 'canvas:sync',
    ack: CanvasAckCallback<T>,
    operation: () => Promise<T>,
  ): Promise<void> {
    // ACK 없는 요청은 실행하지 않아 좌표 묶음의 수신 결과를 확인할 수 있게 한다.
    if (typeof ack !== 'function') return;
    const windows = this.requests.get(socket.id);
    if (!windows || this.closing) {
      ack({
        ok: false,
        error: {
          code: 'REALTIME_UNAVAILABLE',
          message: 'Realtime service is temporarily unavailable.',
        },
      });
      return;
    }
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
      ack({ ok: true, data: await operation() });
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
      if (!socket.connected) this.drawing.disconnect(socket.id);
    }
  }

  /** 진행 중 좌표는 밀린 전송을 버릴 수 있고 마지막 묶음은 일반 방송으로 보낸다. */
  preview(socket: CanvasSocket, payload: StrokePreview): void {
    const room = socket.to(MAIN_CANVAS_ROOM);
    if (payload.isFinal) room.emit('stroke:preview', payload);
    else room.volatile.emit('stroke:preview', payload);
  }

  /** 알림 전달 여부와 관계없이 연결을 닫는다. 클라이언트는 disconnect로 종료를 확정한다. */
  private reset(socket: CanvasSocket, notice: CanvasConnectionReset): void {
    if (!socket.connected) return;
    socket.emit('connection:reset', notice);
    socket.disconnect(true);
  }

  /** Nest가 전송 서버를 닫기 전에 새 합류를 막고 관람 연결과 타이머를 정리한다. */
  beforeApplicationShutdown(): void {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.presenceTimer);
    this.presenceTimer = undefined;
    for (const socket of this.connections.values()) {
      this.reset(socket, {
        reason: 'server_shutdown',
        retryable: true,
        retryAfterMs: 1000,
      });
    }
    this.connections.clear();
  }
}
