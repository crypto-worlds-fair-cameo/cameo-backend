import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import appConfig from './config/app.config';
import corsConfig from './config/cors.config';
import databaseConfig from './config/database.config';
import rateLimitConfig from './config/rate-limit.config';
import { DatabaseModule } from './database/database.module';
import { HttpModule } from './http/http.module';
import { LoggerModule } from './logging/logger.module';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, corsConfig, rateLimitConfig, databaseConfig],
    }),
    LoggerModule,
    HttpModule,
    DatabaseModule,
    SystemModule,
    AuthModule,
    UserModule,
  ],
})
export class AppModule {}
