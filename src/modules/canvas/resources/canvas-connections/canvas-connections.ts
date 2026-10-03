import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';
import {
  MAIN_CANVAS_ROOM,
  type CanvasConnectionReset,
  type CanvasNamespace,
  type CanvasSocket,
} from './canvas-events';

/** 한 프로세스의 관람 연결, 연결 수 알림과 종료 시 자원 정리를 소유한다. */
@Injectable()
export class CanvasConnections implements BeforeApplicationShutdown {
  private namespace?: CanvasNamespace;
  private readonly connections = new Map<string, CanvasSocket>();
  private presenceTimer?: ReturnType<typeof setTimeout>;
  private closing = false;

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
   * 인증 연동 전이므로 쿠키나 클라이언트의 신원 주장과 관계없이 관람자로 취급한다.
   */
  connect(socket: CanvasSocket): void {
    if (!socket.connected || this.connections.has(socket.id)) return;
    if (this.closing) {
      this.reset(socket, {
        reason: 'server_shutdown',
        retryable: true,
        retryAfterMs: 1000,
      });
      return;
    }

    // 기본 메모리 어댑터의 room 가입은 동기 처리된다. 초기 집계와 ready 사이에 대기하지 않는다.
    void socket.join(MAIN_CANVAS_ROOM);
    this.connections.set(socket.id, socket);
    const onClientEvent = this.createMessageLimit(socket);
    socket.onAny(onClientEvent);
    socket.once('disconnect', () => {
      socket.offAny(onClientEvent);
      this.disconnect(socket.id);
    });

    socket.emit('connection:ready', {
      protocolVersion: 1,
      canvasKey: 'main',
      viewer: { status: 'guest', userId: null },
      canDraw: false,
      presence: { connectionCount: this.connections.size },
    });
    this.schedulePresence();
  }

  /** 중복 종료가 와도 한 번만 제거하고 남은 연결에 최신 집계값을 알린다. */
  private disconnect(connectionId: string): void {
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
  private createMessageLimit(socket: CanvasSocket): () => void {
    let windowStartedAt = Date.now();
    let messages = 0;
    return () => {
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
