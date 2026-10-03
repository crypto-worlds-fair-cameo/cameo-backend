import type { Namespace, Socket } from 'socket.io';
import type {
  AppendStrokeInput,
  AppendStrokeResult,
  CanvasAckCallback,
  CanvasSyncPage,
  StrokePreview,
  SyncCanvasInput,
} from '../canvas-stroke/canvas-stroke';

export const MAIN_CANVAS_ROOM = 'canvas:main';

export type CanvasPresence = {
  canvasKey: 'main';
  connectionCount: number;
};

export type CanvasConnectionReady = {
  protocolVersion: 1;
  canvasKey: 'main';
  viewer:
    | { status: 'guest'; userId: null }
    | { status: 'authenticated'; userId: string };
  canDraw: boolean;
  presence: { connectionCount: number };
};

export type CanvasConnectionReset =
  | { reason: 'server_shutdown'; retryable: true; retryAfterMs: 1000 }
  | { reason: 'connection_policy'; retryable: false; retryAfterMs: 0 };

export interface CanvasServerEvents {
  'connection:ready': (payload: CanvasConnectionReady) => void;
  'canvas:presence': (payload: CanvasPresence) => void;
  'connection:reset': (payload: CanvasConnectionReset) => void;
  'stroke:preview': (payload: StrokePreview) => void;
}

/** 모든 클라이언트 요청은 성공·거절을 ACK로 확인한다. */
export interface CanvasClientEvents {
  'stroke:append': (
    payload: AppendStrokeInput,
    ack: CanvasAckCallback<AppendStrokeResult>,
  ) => void;
  'canvas:sync': (
    payload: SyncCanvasInput,
    ack: CanvasAckCallback<CanvasSyncPage>,
  ) => void;
}
export type CanvasSocket = Socket<CanvasClientEvents, CanvasServerEvents>;
export type CanvasNamespace = Namespace<CanvasClientEvents, CanvasServerEvents>;
