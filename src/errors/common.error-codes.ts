import type { BusinessErrorDefinition } from '@/business-error';

/** 공통 HTTP 오류의 상태·공개 코드·메시지를 정의합니다. */
export const CommonErrorCodes = {
  BadRequest: {
    statusCode: 400,
    code: 'BadRequestException',
    message: 'Invalid request format.',
    description: '요청 형식이 올바르지 않습니다.',
  },
  NotFound: {
    statusCode: 404,
    code: 'NotFoundException',
    message: 'Requested route not found.',
    description: '요청한 경로를 찾을 수 없습니다.',
  },
  PayloadTooLarge: {
    statusCode: 413,
    code: 'PayloadTooLargeException',
    message: 'Request body is too large.',
    description: '요청 본문이 너무 큽니다.',
  },
  UnsupportedMediaType: {
    statusCode: 415,
    code: 'UnsupportedMediaTypeException',
    message: 'Unsupported request body encoding.',
    description: '지원하지 않는 본문 인코딩입니다.',
  },
  TooManyRequests: {
    statusCode: 429,
    code: 'ThrottlerException',
    message: 'ThrottlerException: Too Many Requests',
    description: '요청 제한을 초과했습니다.',
  },
  InternalServerError: {
    statusCode: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
    description: '서버 내부 오류가 발생했습니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
