import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';

/** 공개 출처 검증 기능. CORS 헤더와 별개로 세션을 사용하는 쓰기 요청의 허용 출처를 확인한다. */
export function assertAuthOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): asserts origin is string {
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new BusinessError(ErrorCodes.AuthOriginNotAllowed);
  }
}
