import { createHash } from 'node:crypto';

/** 연결 쿠키와 세션 쿠키의 원문은 정규 Base64url 32바이트 값만 허용한다. */
export function isAuthSecret(value: string | undefined): value is string {
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}

/** 인증 비밀값은 DB에 원문 대신 SHA-256 해시로만 저장한다. */
export function hashAuthSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
