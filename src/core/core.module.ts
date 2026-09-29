import { HttpErrorModule } from '../common/exceptions/http-error.module';
import { Module, Global } from '@nestjs/common';
import { LoggerModule } from './logger/logger.module';
import { HttpClientModule } from './http-client/http-client.module';
import { ConfigModule } from '@nestjs/config';
import appConfig from '../config/app.config';
import corsConfig from '../config/cors.config';
import throttlerConfig from '../config/throttler.config';
import databaseConfig from '../config/database.config';
import { validateEnvironment } from '../config/environment.validation';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
      load: [appConfig, corsConfig, throttlerConfig, databaseConfig],
    }),
    HttpErrorModule,
    HttpClientModule,
    LoggerModule,
  ],
  exports: [HttpClientModule],
})
export class CoreModule {}
