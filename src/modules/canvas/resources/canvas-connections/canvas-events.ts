import type { Namespace, Socket } from 'socket.io';

export const MAIN_CANVAS_ROOM = 'canvas:main';

export type CanvasPresence = {
  canvasKey: 'main';
  connectionCount: number;
};

export type CanvasConnectionReady = {
  protocolVersion: 1;
  canvasKey: 'main';
  viewer: { status: 'guest'; userId: null };
  canDraw: false;
  presence: { connectionCount: number };
};

export type CanvasConnectionReset =
  | { reason: 'server_shutdown'; retryable: true; retryAfterMs: 1000 }
  | { reason: 'connection_policy'; retryable: false; retryAfterMs: 0 };

export interface CanvasServerEvents {
  'connection:ready': (payload: CanvasConnectionReady) => void;
  'canvas:presence': (payload: CanvasPresence) => void;
  'connection:reset': (payload: CanvasConnectionReset) => void;
}

// 이번 단계는 서버 알림 수신만 제공하며, 클라이언트 앱 이벤트는 받지 않는다.
type CanvasClientEvents = Record<string, never>;
export type CanvasSocket = Socket<CanvasClientEvents, CanvasServerEvents>;
export type CanvasNamespace = Namespace<CanvasClientEvents, CanvasServerEvents>;
