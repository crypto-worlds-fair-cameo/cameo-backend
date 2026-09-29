import type { AppConfig } from './app.config';
import type { CorsConfig } from './cors.config';
import type { DatabaseConfig } from './database.config';
import type { ThrottlerConfig } from './throttler.config';

export type AllConfigType = {
  app: AppConfig;
  cors: CorsConfig;
  throttler: ThrottlerConfig;
  database: DatabaseConfig;
};
