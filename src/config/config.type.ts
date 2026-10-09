import type { AppConfig } from './app.config';
import type { CanvasSnapshotConfig } from './canvas-snapshot.config';
import type { CorsConfig } from './cors.config';
import type { DatabaseConfig } from './database.config';
import type { RateLimitConfig } from './rate-limit.config';
import type { RealtimeConfig } from './realtime.config';

export type AllConfigType = {
  app: AppConfig;
  cors: CorsConfig;
  rateLimit: RateLimitConfig;
  database: DatabaseConfig;
  realtime: RealtimeConfig;
  canvasSnapshot: CanvasSnapshotConfig;
};
