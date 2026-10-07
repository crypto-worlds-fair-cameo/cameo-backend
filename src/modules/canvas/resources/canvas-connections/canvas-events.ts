import type { Namespace, Socket } from 'socket.io';
import type {
  AppendStrokeInput,
  AppendStrokeResult,
  CanvasAckCallback,
  CanvasSyncPage,
  StrokePreview,
  SyncCanvasInput,
} from '../canvas-stroke/canvas-stroke';
import type { CanvasKey } from '../canvas-definition/canvas-target';
import type { SeasonStatus } from '../../../seasons/resources/season/season-state';

export const MAIN_CANVAS_ROOM = 'canvas:main';

/** 정규화된 key를 Socket.IO room 이름으로 고정한다. */
export function canvasRoom(key: CanvasKey): string {
  return key === 'main' ? MAIN_CANVAS_ROOM : `canvas:${key}`;
}

export type CanvasPresence = {
  canvasKey: CanvasKey;
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

export type SeasonConnectionReady = {
  protocolVersion: 1;
  canvasKey: `season:${string}`;
  viewer:
    | { status: 'guest'; userId: null }
    | { status: 'authenticated'; userId: string };
  canDraw: boolean;
  presence: { connectionCount: number };
  season: {
    width: number;
    height: number;
    strokeLimitPerUser: number | null;
    startsAt: string;
    endsAt: string;
    cancelledAt: string | null;
    forceEndedAt: string | null;
    status: SeasonStatus;
    isParticipant: boolean;
    isCreator: boolean;
  };
  serverTime: string;
};

export type SeasonStateEvent = {
  canvasKey: `season:${string}`;
  status: SeasonStatus;
  startsAt: string;
  endsAt: string;
  cancelledAt: string | null;
  forceEndedAt: string | null;
  serverTime: string;
  epoch: string;
  headSequence: string;
};

export type CanvasConnectionReset =
  | { reason: 'server_shutdown'; retryable: true; retryAfterMs: 1000 }
  | { reason: 'connection_policy'; retryable: false; retryAfterMs: 0 }
  | { reason: 'invalid_canvas_key'; retryable: false; retryAfterMs: 0 }
  | { reason: 'canvas_unavailable'; retryable: false; retryAfterMs: 0 }
  | { reason: 'realtime_unavailable'; retryable: true; retryAfterMs: 1000 };

export interface CanvasServerEvents {
  'connection:ready': (
    payload: CanvasConnectionReady | SeasonConnectionReady,
  ) => void;
  'canvas:presence': (payload: CanvasPresence) => void;
  'connection:reset': (payload: CanvasConnectionReset) => void;
  'stroke:preview': (payload: StrokePreview) => void;
  'season:state': (payload: SeasonStateEvent) => void;
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
