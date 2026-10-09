import path from 'node:path';
import { registerAs } from '@nestjs/config';

export type CanvasSnapshotConfig = {
  enabled: boolean;
  storageRoot?: string;
  publicBaseUrl?: string;
  intervalSeconds: number;
  intervalMs: number;
  diskBudgetBytes?: number;
  minFreeBytes?: number;
};

function booleanValue(name: string, fallback: boolean): boolean {
  const source = process.env[name];
  if (source === undefined) return fallback;
  if (source === 'true') return true;
  if (source === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

/** 명시한 환경 변수는 빈 값이나 일부만 숫자인 문자열을 허용하지 않고 양의 정수로 읽는다. */
function positiveInteger(name: string, fallback?: number): number {
  const source = process.env[name];
  if (source !== undefined && !/^[1-9][0-9]*$/.test(source))
    throw new Error(`${name} must be a positive safe integer.`);
  const value = source === undefined ? fallback : Number(source);
  if (value === undefined)
    throw new Error(`${name} is required when snapshots are enabled.`);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function optionalAbsolutePath(name: string): string | undefined {
  const source = process.env[name];
  if (source === undefined || source.trim().length === 0) return undefined;
  if (!path.isAbsolute(source))
    throw new Error(`${name} must be an absolute path.`);
  return source;
}

function optionalPublicBaseUrl(name: string): string | undefined {
  const source = process.env[name];
  if (source === undefined || source.trim().length === 0) return undefined;
  const parsed = new URL(source);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new Error(`${name} must use http or https.`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(
      `${name} must not contain credentials, query, or fragment.`,
    );
  return parsed.toString().replace(/\/$/, '');
}

export default registerAs('canvasSnapshot', () => {
  const enabled = booleanValue('CANVAS_SNAPSHOT_ENABLED', false);
  const storageRoot = optionalAbsolutePath('CANVAS_SNAPSHOT_STORAGE_ROOT');
  const publicBaseUrl = optionalPublicBaseUrl(
    'CANVAS_SNAPSHOT_PUBLIC_BASE_URL',
  );
  const intervalSeconds = positiveInteger(
    'CANVAS_SNAPSHOT_INTERVAL_SECONDS',
    3600,
  );
  const intervalMs = intervalSeconds * 1000;
  // 타이머 계산에서 정밀도를 잃는 초 단위 값은 시작 단계에서 거절한다.
  if (!Number.isSafeInteger(intervalMs))
    throw new Error(
      'CANVAS_SNAPSHOT_INTERVAL_SECONDS is too large to convert to milliseconds.',
    );
  const diskBudgetBytes =
    process.env.CANVAS_SNAPSHOT_DISK_BUDGET_BYTES !== undefined
      ? positiveInteger('CANVAS_SNAPSHOT_DISK_BUDGET_BYTES')
      : undefined;
  const minFreeBytes =
    process.env.CANVAS_SNAPSHOT_MIN_FREE_BYTES !== undefined
      ? positiveInteger('CANVAS_SNAPSHOT_MIN_FREE_BYTES')
      : undefined;

  if (enabled) {
    if (!storageRoot)
      throw new Error('CANVAS_SNAPSHOT_STORAGE_ROOT is required when enabled.');
    if (!publicBaseUrl)
      throw new Error(
        'CANVAS_SNAPSHOT_PUBLIC_BASE_URL is required when enabled.',
      );
    if (diskBudgetBytes === undefined)
      throw new Error(
        'CANVAS_SNAPSHOT_DISK_BUDGET_BYTES is required when enabled.',
      );
    if (minFreeBytes === undefined)
      throw new Error(
        'CANVAS_SNAPSHOT_MIN_FREE_BYTES is required when enabled.',
      );
  }

  return {
    enabled,
    storageRoot,
    publicBaseUrl,
    intervalSeconds,
    intervalMs,
    diskBudgetBytes,
    minFreeBytes,
  };
});
