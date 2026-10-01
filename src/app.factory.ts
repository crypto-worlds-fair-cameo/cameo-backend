import type { Express } from 'express';
import helmet from 'helmet';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllConfigType } from './config/config.type';
import { createCorsOptions } from './http/cors-options';
import { HttpExceptionFilter } from './http/errors/http-exception.filter';
import { createRequestLifecycleMiddleware } from './http/request-lifecycle/request-lifecycle.middleware';
import { ResponseInterceptor } from './http/response.interceptor';
import validationOptions from './http/validation-options';
import { LoggerService } from './logging/logger.service';
import {
  authCookies,
  createAuthCacheControlMiddleware,
} from './modules/auth/resources/auth-cookie/auth-http';
import { createLoginMediaTypeMiddleware } from './modules/auth/features/login/login-media-type.middleware';

/** 공통 HTTP 처리와 공개 Swagger 문서를 구성하고 인증 응답에 캐시 금지를 적용한다. */
export function configureApp(app: INestApplication): INestApplication {
  const configService = app.get<ConfigService<AllConfigType>>(ConfigService);
  const logger = app.get(LoggerService);
  const apiPrefix = configService.getOrThrow('app.apiPrefix', { infer: true });
  const nodeEnv = configService.getOrThrow('app.nodeEnv', { infer: true });

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
  if (nodeEnv !== 'production') {
    // 로컬 Safari가 문서 자산을 HTTPS로 전환하지 않게 하며, API의 기존 CSP는 유지한다.
    app.use(
      '/docs',
      helmet.contentSecurityPolicy({
        directives: { upgradeInsecureRequests: null },
      }),
    );
  }
  app.enableShutdownHooks();
  app.useLogger(logger);
  app.enableCors(createCorsOptions(configService));
  app.use(createLoginMediaTypeMiddleware(apiPrefix));
  if (apiPrefix) {
    // Express가 접두사 아래의 404 처리도 올바른 URL 경로에 등록하도록 합니다.
    app.setGlobalPrefix(`/${apiPrefix}`);
  }
  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  app.useGlobalInterceptors(new ResponseInterceptor());

  // API 경로에는 접두사를 반영하고, 문서는 접두사와 관계없이 /docs에서 제공한다.
  const cookies = authCookies(nodeEnv);
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Cameo API')
    .setVersion(configService.getOrThrow('app.version', { infer: true }))
    .setDescription(
      '성공 응답은 { statusCode, success, data }, 오류 응답은 { statusCode, success, code, message, traceId? } 형식입니다.\n\n' +
        '지갑 로그인: 챌린지 발급 → 지갑의 solana:signIn 호출 → 원본 메시지와 서명을 Base64로 제출 → 현재 사용자 조회.\n\n' +
        '인증은 서버가 발급하는 HttpOnly 쿠키를 사용합니다. 브라우저 요청에는 credentials: include가 필요합니다. ' +
        '쿠키는 SameSite=Lax, Path=/이며 운영 환경에서는 Secure를 적용합니다. 인증 응답은 Cache-Control: no-store를 사용합니다. ' +
        '인증 POST와 사용자 프로필 PATCH의 Origin은 CORS_ORIGIN_LIST에 등록되어야 합니다. Swagger에서 실행할 때도 문서 페이지의 출처에 같은 규칙이 적용됩니다. ' +
        'Origin과 Cookie 헤더는 브라우저가 관리하며 Swagger 입력으로 임의 설정할 수 없습니다.',
    )
    .addCookieAuth(
      cookies.sessionName,
      {
        type: 'apiKey',
        in: 'cookie',
        description: '로그인 시 서버가 설정하는 세션 쿠키.',
      },
      'session',
    )
    .addCookieAuth(
      cookies.bindingName,
      {
        type: 'apiKey',
        in: 'cookie',
        description: '챌린지 발급 시 서버가 설정하는 연결 쿠키.',
      },
      'challengeBinding',
    )
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    () => SwaggerModule.createDocument(app, swaggerConfig),
    {
      jsonDocumentUrl: '/docs-json',
      raw: ['json'],
      customSiteTitle: 'Cameo API 문서',
      swaggerOptions: { withCredentials: true },
    },
  );

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
