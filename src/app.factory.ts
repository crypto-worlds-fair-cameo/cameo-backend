import type { Express } from 'express';
import helmet from 'helmet';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllConfigType } from './config/config.type';
import { createCorsOptions } from './http/cors-options';
import { HttpExceptionFilter } from './http/errors/http-exception.filter';
import { createRequestLifecycleMiddleware } from './http/request-lifecycle/request-lifecycle.middleware';
import { ResponseInterceptor } from './http/response.interceptor';
import validationOptions from './http/validation-options';
import { LoggerService } from './logging/logger.service';
import { createAuthCacheControlMiddleware } from './modules/auth/auth-http';

/** 공통 HTTP 처리를 구성하고 인증 경로의 초기 응답에도 캐시 금지 정책을 적용한다. */
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
  // CORS나 본문 파싱이 먼저 응답을 끝내더라도 인증 데이터가 캐시되지 않게 한다.
  app.use(createAuthCacheControlMiddleware(apiPrefix));
  app.use(helmet());
  app.enableShutdownHooks();
  app.useLogger(logger);
  app.enableCors(createCorsOptions(configService));
  if (apiPrefix) {
    app.setGlobalPrefix(apiPrefix);
  }
  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalFilters(new HttpExceptionFilter(logger));
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
