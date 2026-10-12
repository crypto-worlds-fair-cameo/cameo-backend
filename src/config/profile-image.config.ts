import { registerAs } from '@nestjs/config';
import {
  optionalAbsolutePath,
  optionalPublicBaseUrl,
} from './canvas-snapshot.config';

export type ProfileImageConfig = {
  storageRoot?: string;
  publicBaseUrl?: string;
};

/** 두 값이 모두 있을 때만 프로필 사진 업로드를 켠다. 하나만 설정한 배포는 시작 단계에서 거절한다. */
export default registerAs('profileImage', (): ProfileImageConfig => {
  const storageRoot = optionalAbsolutePath('PROFILE_IMAGE_STORAGE_ROOT');
  const publicBaseUrl = optionalPublicBaseUrl('PROFILE_IMAGE_PUBLIC_BASE_URL');
  if (Boolean(storageRoot) !== Boolean(publicBaseUrl))
    throw new Error(
      'PROFILE_IMAGE_STORAGE_ROOT and PROFILE_IMAGE_PUBLIC_BASE_URL must be set together.',
    );
  // 공개 경로가 루트면 정적 파일 처리기가 API 경로까지 가로채므로 하위 경로를 요구한다.
  if (publicBaseUrl && new URL(publicBaseUrl).pathname === '/')
    throw new Error(
      'PROFILE_IMAGE_PUBLIC_BASE_URL must include a path such as /profile-images.',
    );
  return { storageRoot, publicBaseUrl };
});
