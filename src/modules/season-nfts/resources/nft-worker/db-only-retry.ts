const RETRYABLE_DB_CODES = new Set(['40001', '40P01']);

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** 외부 효과가 없는 명시적 DB 작업만 serialization/deadlock 오류에서 최대 3회 실행한다. */
export async function withDbOnlyRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      // SQLSTATE가 명시된 두 transient DB 오류만 다시 실행한다. RPC와 파일 작업은 이 경계에 넣지 않는다.
      if (attempt === 3 || !RETRYABLE_DB_CODES.has(postgresCode(error) ?? '')) {
        throw error;
      }
    }
  }
  throw new Error('DB-only retry reached an unreachable state.');
}
