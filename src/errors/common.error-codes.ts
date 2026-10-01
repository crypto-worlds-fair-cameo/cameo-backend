import type { BusinessErrorDefinition } from '@/business-error';

/** 공통 HTTP 오류의 상태·공개 코드·메시지를 정의합니다. */
export const CommonErrorCodes = {
  BadRequest: {
    statusCode: 400,
    code: 'BadRequestException',
    message: '요청 형식이 올바르지 않습니다.',
  },
  NotFound: {
    statusCode: 404,
    code: 'NotFoundException',
    message: '요청한 경로를 찾을 수 없습니다.',
  },
  PayloadTooLarge: {
    statusCode: 413,
    code: 'PayloadTooLargeException',
    message: '요청 본문이 너무 큽니다.',
  },
  UnsupportedMediaType: {
    statusCode: 415,
    code: 'UnsupportedMediaTypeException',
    message: '지원하지 않는 본문 인코딩입니다.',
  },
  TooManyRequests: {
    statusCode: 429,
    code: 'ThrottlerException',
    message: 'ThrottlerException: Too Many Requests',
  },
  InternalServerError: {
    statusCode: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
