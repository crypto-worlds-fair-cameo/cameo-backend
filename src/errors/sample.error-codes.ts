import type { BusinessErrorDefinition } from '@/business-error';

/** 샘플 업무 오류의 HTTP 상태·공개 코드·메시지를 정의합니다. */
export const SampleErrorCodes = {
  SampleNotFound: {
    statusCode: 404,
    code: 'SAMPLE_NOT_FOUND',
    message: '샘플 항목을 찾을 수 없습니다.',
  },
  SampleInvalidName: {
    statusCode: 400,
    code: 'SAMPLE_INVALID_NAME',
    message: '이름은 공백을 제외하고 2자 이상이어야 합니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
