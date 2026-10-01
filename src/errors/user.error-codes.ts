import type { BusinessErrorDefinition } from '@/business-error';

/** 사용자 프로필 업무 오류의 HTTP 상태·공개 코드·메시지를 정의한다. */
export const UserErrorCodes = {
  UserDisplayNameInvalid: {
    statusCode: 400,
    code: 'USER_DISPLAY_NAME_INVALID',
    message: 'Display name must be 1 to 20 characters without null characters.',
    description:
      '앞뒤 공백을 제거한 닉네임은 1~20자여야 하며 NUL 문자를 포함할 수 없습니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
