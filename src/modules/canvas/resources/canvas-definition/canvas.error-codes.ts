import type { BusinessErrorDefinition } from '@/business-error';

/** 캔버스 HTTP 조회에서 공개할 오류를 정의한다. */
export const CanvasErrorCodes = {
  CanvasNotFound: {
    statusCode: 404,
    code: 'CANVAS_NOT_FOUND',
    message: 'Canvas not found.',
    description: '캔버스를 찾을 수 없거나 현재 사용자에게 공개되지 않습니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
