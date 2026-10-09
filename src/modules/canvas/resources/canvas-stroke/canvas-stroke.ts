import type { CanvasKey } from '../canvas-definition/canvas-target';

/** 클라이언트 좌표와 브러시를 검증하고 소켓에 공개할 획 계약을 소유한다. */
export type StrokePoint = { x: number; y: number; t?: number };
export type StrokeBrush = {
  type: 'round' | 'flat' | 'airbrush';
  size: number;
  color: string;
  opacity: number;
  version: 1;
  angle?: number;
  seed?: number;
};
export type StrokeInput = {
  clientStrokeId: string;
  brush: StrokeBrush;
  points: StrokePoint[];
};
export type AppendStrokeInput = StrokeInput & {
  chunkIndex: number;
  isFinal: boolean;
};
export type StrokePreview = AppendStrokeInput & {
  canvasKey: CanvasKey;
  userId: string;
  epoch: string;
  sequence: string;
};
export type AppendStrokeResult = { accepted: boolean; preview: StrokePreview };
export type SyncCanvasInput = {
  epoch?: string;
  afterSequence: string;
  throughSequence?: string;
  limit?: number;
};
export type CanvasSyncPage = {
  canvasKey: CanvasKey;
  epoch: string;
  reset: boolean;
  previews: StrokePreview[];
  headSequence: string;
  nextSequence: string;
  hasMore: boolean;
};
export type BootstrapCanvasInput = {
  preferSnapshot: boolean;
  rendererVersion: string;
};
export type CanvasAck<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
export type CanvasAckCallback<T> = (response: CanvasAck<T>) => void;

export const STROKE_LIMITS = {
  appendPoints: 128,
  appendBytes: 8 * 1024,
  syncPageBytes: 128 * 1024,
  pendingBytes: 16 * 1024 * 1024,
  pendingChunks: 4096,
  recentBytes: 16 * 1024 * 1024,
  recentChunks: 4096,
  stateBytes: 8 * 1024 * 1024,
  stateCount: 2048,
  flushBytes: 1024 * 1024,
  flushChunks: 256,
  flushIntervalMs: 1000,
} as const;

/** 업무 거절만 공개 코드로 전달하며 내부 DB 오류는 소켓 경계에서 숨긴다. */
export class CanvasStrokeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
  );
}

/** 외부 값을 정규화하고 좌표를 선택한 캔버스 크기의 반열린 범위로 제한한다. */
export function parseAppend(
  value: unknown,
  dimensions: Readonly<{ width: number; height: number }> = {
    width: 10000,
    height: 10000,
  },
): AppendStrokeInput {
  const invalid = () => {
    throw new CanvasStrokeError('INVALID_STROKE', 'Stroke data is invalid.');
  };
  // 메시지 크기를 먼저 제한해 큰 배열을 순회하기 전에 요청을 거절한다.
  if (
    !record(value) ||
    Buffer.byteLength(JSON.stringify(value)) > STROKE_LIMITS.appendBytes
  )
    return invalid();
  if (
    typeof value.clientStrokeId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.clientStrokeId,
    )
  )
    return invalid();
  const source = value.brush;
  if (
    !record(source) ||
    typeof source.type !== 'string' ||
    !['round', 'flat', 'airbrush'].includes(source.type) ||
    source.version !== 1 ||
    !finite(source.size, 1, 200) ||
    !finite(source.opacity, 0.01, 1) ||
    typeof source.color !== 'string' ||
    !/^#[0-9a-f]{6}$/i.test(source.color)
  )
    return invalid();
  const brush: StrokeBrush = {
    type: source.type as StrokeBrush['type'],
    size: source.size,
    color: source.color.toUpperCase(),
    opacity: source.opacity,
    version: 1,
  };
  // Flat은 고정 각도, Airbrush는 재현 가능한 난수 seed를 요구한다.
  if (brush.type === 'flat') {
    if (!finite(source.angle, 0, 360)) return invalid();
    brush.angle = source.angle;
  }
  if (brush.type === 'airbrush') {
    if (!finite(source.seed, 0, 4294967295) || !Number.isInteger(source.seed))
      return invalid();
    brush.seed = source.seed;
  }
  if (
    !Array.isArray(value.points) ||
    value.points.length < (value.isFinal === true ? 0 : 1) ||
    value.points.length > STROKE_LIMITS.appendPoints
  )
    return invalid();
  let previousTime = -1;
  const points = value.points.map((point): StrokePoint => {
    // 좌표는 화면이 아니라 선택한 원본 캔버스의 [0, width)·[0, height) 영역에 있어야 한다.
    if (
      !record(point) ||
      !finite(point.x, 0, dimensions.width) ||
      point.x >= dimensions.width ||
      !finite(point.y, 0, dimensions.height) ||
      point.y >= dimensions.height
    )
      return invalid();
    const parsed: StrokePoint = { x: point.x, y: point.y };
    if (brush.type === 'airbrush' || point.t !== undefined) {
      // 분사 시각은 획 시작 기준 밀리초이며 좌표 묶음 안에서 뒤로 가지 않는다.
      if (!finite(point.t, 0, 3_600_000) || point.t < previousTime)
        return invalid();
      parsed.t = point.t;
      previousTime = point.t;
    }
    return parsed;
  });
  const input: StrokeInput = {
    clientStrokeId: value.clientStrokeId.toLowerCase(),
    brush,
    points,
  };
  // 완료는 별도 이벤트 대신 마지막 좌표 묶음의 boolean으로 표시한다.
  if (
    !finite(value.chunkIndex, 0, 1_000_000) ||
    !Number.isInteger(value.chunkIndex) ||
    (value.isFinal !== undefined && typeof value.isFinal !== 'boolean')
  )
    return invalid();
  return {
    ...input,
    chunkIndex: value.chunkIndex,
    isFinal: value.isFinal === true,
  };
}

/** bigint 순서를 문자열로 받아 JS 숫자의 정밀도 손실 없이 페이지 범위를 검증한다. */
export function parseSync(
  value: unknown,
): Required<Pick<SyncCanvasInput, 'afterSequence' | 'limit'>> &
  Pick<SyncCanvasInput, 'throughSequence' | 'epoch'> {
  const validSequence = (sequence: unknown): sequence is string =>
    typeof sequence === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(sequence) &&
    BigInt(sequence) <= 9223372036854775807n;
  if (
    !record(value) ||
    !validSequence(value.afterSequence) ||
    (value.epoch !== undefined &&
      (typeof value.epoch !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(value.epoch))) ||
    (value.throughSequence !== undefined &&
      (!validSequence(value.throughSequence) ||
        BigInt(value.throughSequence) < BigInt(value.afterSequence))) ||
    (value.limit !== undefined &&
      (!finite(value.limit, 1, 100) || !Number.isInteger(value.limit)))
  ) {
    throw new CanvasStrokeError(
      'INVALID_SYNC',
      'Canvas sync cursor is invalid.',
    );
  }
  return {
    epoch: value.epoch as string | undefined,
    afterSequence: value.afterSequence,
    throughSequence: value.throughSequence as string | undefined,
    limit: (value.limit as number | undefined) ?? 50,
  };
}

/** bootstrap 요청은 스냅샷 선호 여부와 렌더러 버전만 허용한다. */
export function parseBootstrap(value: unknown): BootstrapCanvasInput {
  if (
    !record(value) ||
    typeof value.preferSnapshot !== 'boolean' ||
    typeof value.rendererVersion !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(value.rendererVersion)
  ) {
    throw new CanvasStrokeError(
      'INVALID_BOOTSTRAP',
      'Canvas bootstrap input is invalid.',
    );
  }
  return {
    preferSnapshot: value.preferSnapshot,
    rendererVersion: value.rendererVersion,
  };
}
