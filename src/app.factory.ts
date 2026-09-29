import { HttpErrorMapperRegistry } from './common/exceptions/http-error-mapper.registry';
import { createRequestLifecycleMiddleware } from './common/http/request-lifecycle.middleware';
import type { Express } from 'express';
import helmet from 'helmet';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/exceptions/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { createCorsOptions } from './common/cors/cors-options';
import { AllConfigType } from './config/config.type';
import { LoggerService } from './core/logger/logger.service';
import validationOptions from './utils/validation-options';

export function configureApp(app: INestApplication): INestApplication {
  const configService = app.get<ConfigService<AllConfigType>>(ConfigService);
  const logger = app.get(LoggerService);
  const apiPrefix = configService.getOrThrow('app.apiPrefix', { infer: true });

  const expressApp = app.getHttpAdapter().getInstance() as Express;
  const trustProxyHops = configService.getOrThrow('app.trustProxyHops', {
    infer: true,
  });
  expressApp.disable('x-powered-by');
  expressApp.set('trust proxy', trustProxyHops > 0 ? trustProxyHops : false);
  // Register before CORS and Nest's parser/router initialization so early responses are observed too.
  app.use(createRequestLifecycleMiddleware(logger));
  app.use(helmet());
  app.enableShutdownHooks();
  app.useLogger(logger);
  app.enableCors(createCorsOptions(configService));
  if (apiPrefix) {
    app.setGlobalPrefix(apiPrefix);
  }
  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalFilters(
    new HttpExceptionFilter(logger, app.get(HttpErrorMapperRegistry)),
  );
  app.useGlobalInterceptors(new ResponseInterceptor());

  return app;
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  return configureApp(app);
}

export async function startApp(app: INestApplication): Promise<void> {
  const configService = app.get<ConfigService<AllConfigType>>(ConfigService);
  const logger = app.get(LoggerService);
  const host = configService.getOrThrow('app.host', { infer: true });
  const port = configService.getOrThrow('app.port', { infer: true });
  const apiPrefix = configService.getOrThrow('app.apiPrefix', { infer: true });
  const publicUrl = apiPrefix
    ? `http://${host}:${port}/${apiPrefix}`
    : `http://${host}:${port}`;

  await app.listen(port, host);
  logger.log(`Application is running on ${publicUrl}`);
}
