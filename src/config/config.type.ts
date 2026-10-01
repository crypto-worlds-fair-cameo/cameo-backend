import type { AppConfig } from './app.config';
import type { CorsConfig } from './cors.config';
import type { DatabaseConfig } from './database.config';
import type { RateLimitConfig } from './rate-limit.config';

export type AllConfigType = {
  app: AppConfig;
  cors: CorsConfig;
  rateLimit: RateLimitConfig;
  database: DatabaseConfig;
};
