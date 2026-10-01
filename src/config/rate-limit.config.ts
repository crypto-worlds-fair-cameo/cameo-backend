import { registerAs } from '@nestjs/config';

export type RateLimitConfig = {
  ttl: number;
  limit: number;
};

/**
 * ttl: 요청 제한 시간 (ms 단위)
 * limit: 제한 시간 내 허용되는 최대 요청 수
 * ex) ttl이 5000이고 limit가 3이면, 사용자는 5초 동안 최대 3번의 요청
 */
export default registerAs('rateLimit', () => ({
  ttl: Number(process.env.RATE_LIMIT_TTL_MS ?? 60_000),
  limit: Number(process.env.RATE_LIMIT_LIMIT ?? 100),
}));
