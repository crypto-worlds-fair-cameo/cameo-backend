import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';

/** CORS 헤더와 별개로, 업무 처리 전에 명시적으로 허용한 요청 출처인지 확인한다. */
export function assertAuthOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): asserts origin is string {
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new BusinessError(ErrorCodes.AuthOriginNotAllowed);
  }
}
