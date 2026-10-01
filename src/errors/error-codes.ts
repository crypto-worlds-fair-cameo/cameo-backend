import { AuthErrorCodes } from './auth.error-codes';
import { CommonErrorCodes } from './common.error-codes';

/** 공통·도메인별 오류 정의를 모아 하나의 경로로 공개합니다. */
export const ErrorCodes = {
  ...CommonErrorCodes,
  ...AuthErrorCodes,
} as const;
