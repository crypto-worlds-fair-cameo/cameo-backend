import { AuthErrorCodes } from './auth.error-codes';
import { CommonErrorCodes } from './common.error-codes';
import { SeasonErrorCodes } from '../modules/seasons/resources/season/season.error-codes';
import { CanvasErrorCodes } from '../modules/canvas/resources/canvas-definition/canvas.error-codes';
import { UserErrorCodes } from './user.error-codes';

/** 공통·도메인별 오류 정의를 모아 하나의 경로로 공개합니다. */
export const ErrorCodes = {
  ...CommonErrorCodes,
  ...AuthErrorCodes,
  ...SeasonErrorCodes,
  ...CanvasErrorCodes,
  ...UserErrorCodes,
} as const;
