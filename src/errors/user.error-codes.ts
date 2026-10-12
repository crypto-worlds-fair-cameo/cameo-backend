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
  UserProfileImageInvalid: {
    statusCode: 400,
    code: 'USER_PROFILE_IMAGE_INVALID',
    message:
      'Profile image must be a PNG or JPEG file of at most 8192 x 8192 pixels.',
    description:
      'Content-Type과 실제 파일 형식이 같은 PNG·JPEG여야 하며 가로·세로는 각각 8192px 이하여야 합니다.',
  },
  UserProfileImageUnavailable: {
    statusCode: 503,
    code: 'USER_PROFILE_IMAGE_UNAVAILABLE',
    message: 'Profile image upload is not available.',
    description: '서버에 프로필 사진 저장소가 설정되지 않았습니다.',
  },
} as const satisfies Record<string, BusinessErrorDefinition>;
