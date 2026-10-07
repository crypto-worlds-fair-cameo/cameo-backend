import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';
import corsConfig from './config/cors.config';
import databaseConfig from './config/database.config';
import rateLimitConfig from './config/rate-limit.config';
import realtimeConfig from './config/realtime.config';
import { DatabaseModule } from './database/database.module';
import { HttpModule } from './http/http.module';
import { LoggerModule } from './logging/logger.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { CanvasModule } from './modules/canvas/canvas.module';
import { SeasonsModule } from './modules/seasons/seasons.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        appConfig,
        corsConfig,
        rateLimitConfig,
        databaseConfig,
        realtimeConfig,
      ],
    }),
    LoggerModule,
    HttpModule,
    DatabaseModule,
    SystemModule,
    AuthModule,
    UserModule,
    CanvasModule,
    SeasonsModule,
  ],
})
export class AppModule {}
