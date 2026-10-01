import type { BusinessErrorDefinition } from '@/business-error';

/** 인증 업무 오류의 HTTP 상태·공개 코드·메시지를 정의합니다. */
export const AuthErrorCodes = {
  AuthOriginNotAllowed: {
    statusCode: 403,
    code: 'AUTH_ORIGIN_NOT_ALLOWED',
    message: '허용되지 않은 요청 출처입니다.',
  },
  AuthChallengeInvalid: {
    statusCode: 401,
    code: 'AUTH_CHALLENGE_INVALID',
    message: '로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.',
  },
  AuthSignatureInvalid: {
    statusCode: 401,
    code: 'AUTH_SIGNATURE_INVALID',
    message: '지갑 서명을 확인할 수 없습니다.',
  },
  AuthUserUnavailable: {
    statusCode: 403,
    code: 'AUTH_USER_UNAVAILABLE',
    message: '이 계정으로 로그인할 수 없습니다.',
  },
  AuthSessionInvalid: {
    statusCode: 401,
    code: 'AUTH_SESSION_INVALID',
    message: '로그인이 필요합니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
