import { registerAs } from '@nestjs/config';

export type RealtimeConfig = {
  maxConnections: number;
  seasonDrawingEnabled: boolean;
  maxSeasonRuntimes: number;
  pendingBytes: number;
  cacheBytes: number;
  runtimeIdleMs: number;
  maxPendingOperations: number;
  maxSeasonOperations: number;
};

export const DEFAULT_RUNTIME_LIMITS = {
  seasonDrawingEnabled: false,
  maxSeasonRuntimes: 16,
  pendingBytes: 64 * 1024 * 1024,
  cacheBytes: 64 * 1024 * 1024,
  runtimeIdleMs: 60_000,
  maxPendingOperations: 256,
  maxSeasonOperations: 64,
} as const;

/** 누락된 환경 변수에는 기본값을 쓰고, 입력된 숫자는 양의 safe integer로 제한한다. */
function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

/** boolean 환경 변수는 true와 false만 받아 오타로 기능이 켜지지 않게 한다. */
function booleanValue(name: string, fallback: boolean): boolean {
  const source = process.env[name];
  if (source === undefined) return fallback;
  if (source === 'true') return true;
  if (source === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

export default registerAs('realtime', () => {
  const maxConnections = positiveInteger('REALTIME_MAX_CONNECTIONS', 5000);
  const seasonDrawingEnabled = booleanValue(
    'SEASON_DRAWING_ENABLED',
    DEFAULT_RUNTIME_LIMITS.seasonDrawingEnabled,
  );
  const maxSeasonRuntimes = positiveInteger(
    'REALTIME_MAX_SEASON_RUNTIMES',
    DEFAULT_RUNTIME_LIMITS.maxSeasonRuntimes,
  );
  const pendingBytes = positiveInteger(
    'REALTIME_PENDING_BYTES',
    DEFAULT_RUNTIME_LIMITS.pendingBytes,
  );
  const cacheBytes = positiveInteger(
    'REALTIME_CACHE_BYTES',
    DEFAULT_RUNTIME_LIMITS.cacheBytes,
  );
  const runtimeIdleMs = positiveInteger(
    'REALTIME_RUNTIME_IDLE_MS',
    DEFAULT_RUNTIME_LIMITS.runtimeIdleMs,
  );
  const maxPendingOperations = positiveInteger(
    'REALTIME_MAX_PENDING_OPERATIONS',
    DEFAULT_RUNTIME_LIMITS.maxPendingOperations,
  );
  const maxSeasonOperations = positiveInteger(
    'REALTIME_MAX_SEASON_OPERATIONS',
    DEFAULT_RUNTIME_LIMITS.maxSeasonOperations,
  );

  // main 예약분과 시즌 최소 여유분을 함께 제공하지 못하는 설정은 시작 단계에서 거절한다.
  if (pendingBytes < 20 * 1024 * 1024)
    throw new Error('REALTIME_PENDING_BYTES must be at least 20971520.');
  if (cacheBytes < 27 * 1024 * 1024)
    throw new Error('REALTIME_CACHE_BYTES must be at least 28311552.');
  if (maxPendingOperations < maxSeasonOperations)
    throw new Error(
      'REALTIME_MAX_PENDING_OPERATIONS must be greater than or equal to REALTIME_MAX_SEASON_OPERATIONS.',
    );

  return {
    maxConnections,
    seasonDrawingEnabled,
    maxSeasonRuntimes,
    pendingBytes,
    cacheBytes,
    runtimeIdleMs,
    maxPendingOperations,
    maxSeasonOperations,
  };
});
