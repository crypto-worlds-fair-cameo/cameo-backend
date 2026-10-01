import { registerAs } from '@nestjs/config';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;

  const lowered = value.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(lowered)) return true;
  if (['false', '0', 'no', 'n'].includes(lowered)) return false;

  return fallback;
}

export type CorsConfig = {
  originList: string[];
  methods: string[];
  allowedHeaders: string[];
  credentials: boolean;
};

export default registerAs('cors', () => {
  // 쿠키 인증은 정확한 프론트 출처를 요구한다. 경로·와일드카드가 섞인 설정은 시작 시 거절한다.
  const originList =
    process.env.CORS_ORIGIN_LIST === undefined
      ? ['http://localhost:5173']
      : process.env.CORS_ORIGIN_LIST.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);
  const production = process.env.NODE_ENV === 'production';
  if (originList.length === 0) {
    throw new Error('CORS_ORIGIN_LIST must contain a frontend origin.');
  }
  for (const origin of originList) {
    const parsed = new URL(origin);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      (production && parsed.protocol !== 'https:')
    ) {
      throw new Error(
        'CORS_ORIGIN_LIST must contain exact HTTP(S) origins; production requires HTTPS.',
      );
    }
  }

  const allowedHeaders = (
    process.env.CORS_ALLOWED_HEADERS
      ? process.env.CORS_ALLOWED_HEADERS.split(',').map((h) => h.trim())
      : ['Content-Type', 'Authorization', 'X-Request-Id']
  ).filter(Boolean);

  const credentials = parseBoolean(process.env.CORS_CREDENTIALS, true);
  if (!credentials) {
    throw new Error('CORS_CREDENTIALS must be true for cookie authentication.');
  }

  const methods = (
    process.env.CORS_METHODS
      ? process.env.CORS_METHODS.split(',').map((method) => method.trim())
      : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  ).filter(Boolean);

  return { originList, allowedHeaders, credentials, methods };
});
