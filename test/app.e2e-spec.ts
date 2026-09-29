import { HttpExceptionFilter } from '@/common/exceptions/http-exception.filter';
import { CoreModule } from '@/core/core.module';
import { INestApplication } from '@nestjs/common';
import { LoggerService } from '@/core/logger/logger.service';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppService } from '@/app.service';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.factory';
import { AllConfigType } from '@/config/config.type';

type ApiSuccessResponse<T> = {
  statusCode: number;
  success: true;
  data: T;
};

type HealthPayload = {
  status: 'ok';
  timestamp: string;
};

type SystemInfoPayload = {
  name: string;
  version: string;
  environment: string;
};

type SamplePayload = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
};

function toSuccessBody<T>(response: request.Response): ApiSuccessResponse<T> {
  const rawBody: unknown = response.body;
  return rawBody as ApiSuccessResponse<T>;
}

describe('Application bootstrap (e2e)', () => {
  let app: INestApplication;
  let apiPrefix: string;
  let filterSpy: jest.SpyInstance;
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  };
  let apiClient: ReturnType<typeof request>;

  const route = (path: string) => {
    return apiPrefix ? `/${apiPrefix}${path}` : path;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    filterSpy = jest.spyOn(HttpExceptionFilter.prototype, 'catch');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(LoggerService)
      .useValue(logger)
      .compile();

    app = configureApp(moduleFixture.createNestApplication());
    await app.init();
    apiClient = request(
      app.getHttpAdapter().getInstance() as Parameters<typeof request>[0],
    );
    apiPrefix = app
      .get<ConfigService<AllConfigType>>(ConfigService)
      .getOrThrow('app.apiPrefix', { infer: true });
  });

  afterEach(async () => {
    await app.close();
    filterSpy.mockRestore();
  });

  it('boots the health endpoint contract', async () => {
    const response = await apiClient.get(route('/health')).expect(200);
    const body = toSuccessBody<HealthPayload>(response);

    expect(body.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(typeof body.data.timestamp).toBe('string');
  });

  it('sets security headers and a request id', async () => {
    const response = await apiClient.get(route('/health')).expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
  });

  it('rejects implicit string conversion and unexpected body fields', async () => {
    await apiClient
      .patch(route('/samples/sample_1/name'))
      .send({ name: 1234 })
      .expect(400);
    await apiClient
      .patch(route('/samples/sample_1/name'))
      .send({ name: 'valid', admin: true })
      .expect(400);
  });

  it('rejects array query values and accepts a string filter', async () => {
    await apiClient.get(route('/samples?q=a&q=b')).expect(400);
    const response = await apiClient
      .get(route('/samples?q=대시보드'))
      .expect(200);
    expect(response.body.data).toHaveLength(1);
  });

  it('keeps missing-resource and domain validation contracts', async () => {
    const missing = await apiClient.get(route('/samples/missing')).expect(404);
    expect(missing.body).toMatchObject({
      success: false,
      code: 'NotFoundException',
    });
    const invalid = await apiClient
      .patch(route('/samples/sample_1/name'))
      .send({ name: '  ' })
      .expect(400);
    expect(invalid.body).toMatchObject({
      success: false,
      code: 'DOMAIN_VALIDATION_ERROR',
    });
  });

  it('reports DB-free readiness and allows only configured CORS origins', async () => {
    const ready = await apiClient.get(route('/ready')).expect(200);
    expect(ready.body.data).toEqual({ status: 'ok', database: 'disabled' });
    const allowed = await apiClient
      .get(route('/health'))
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
    const denied = await apiClient
      .get(route('/health'))
      .set('Origin', 'https://untrusted.example')
      .expect(200);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends 429 through the global filter and keeps probes outside the quota', async () => {
    const limit = app
      .get<ConfigService<AllConfigType>>(ConfigService)
      .getOrThrow('throttler.limit', { infer: true });
    for (let i = 0; i < limit + 1; i++)
      await apiClient.get(route('/health')).expect(200);
    for (let i = 0; i < limit; i++)
      await apiClient.get(route('/samples')).expect(200);
    const before = filterSpy.mock.calls.length;
    const blocked = await apiClient.get(route('/samples')).expect(429);
    expect(filterSpy).toHaveBeenCalledTimes(before + 1);
    expect(filterSpy.mock.calls.at(-1)?.[0].getStatus()).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['ratelimit']).toBeDefined();
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      success: false,
      code: 'ThrottlerException',
    });
    expect(blocked.body.traceId).toBe(blocked.headers['x-request-id']);
    await apiClient.get(route('/health')).expect(200);
    await apiClient.head(route('/ready/')).expect(200);
    await apiClient.get(route('/READY')).expect(200);
    await apiClient.get(route('/samples/health-history')).expect(429);
    jest
      .spyOn(app.get(AppService), 'getReadiness')
      .mockRejectedValueOnce(
        new (await import('@nestjs/common')).ServiceUnavailableException(
          'private DB error',
        ),
      );
    const unavailable = await apiClient.get(route('/ready')).expect(503);
    expect(unavailable.body.message).toBe('Internal server error');
    const access = logger.warn.mock.calls.filter(
      ([, meta]) =>
        meta?.event === 'http.request' &&
        meta.requestId === blocked.body.traceId,
    );
    expect(access).toHaveLength(1);
    expect(access[0][1]).toMatchObject({
      statusCode: 429,
      outcome: 'completed',
    });
  });

  it('observes malformed JSON and CORS preflight before controller handling', async () => {
    const malformed = await apiClient
      .patch(route('/samples/sample_1/name'))
      .set('Content-Type', 'application/json')
      .send('{bad json')
      .expect(400);
    expect(filterSpy).toHaveBeenCalled();
    expect(malformed.body.traceId).toBe(malformed.headers['x-request-id']);
    expect(malformed.body.traceId).toEqual(expect.any(String));
    const logs = logger.warn.mock.calls.filter(
      ([, meta]) =>
        meta?.event === 'http.request' &&
        meta.requestId === malformed.body.traceId,
    );
    expect(logs).toHaveLength(1);
    const preflight = await apiClient
      .options(route('/samples'))
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .expect(204);
    expect(
      logger.log.mock.calls.filter(
        ([, meta]) =>
          meta?.event === 'http.request' &&
          meta.requestId === preflight.headers['x-request-id'],
      ),
    ).toHaveLength(1);
  });

  it('sanitizes unexpected errors while retaining request correlation', async () => {
    jest.spyOn(app.get(AppService), 'getHealth').mockImplementationOnce(() => {
      throw new Error('private database detail');
    });
    const response = await apiClient.get(route('/health')).expect(500);
    expect(response.body).toMatchObject({
      statusCode: 500,
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      traceId: response.headers['x-request-id'],
    });
    expect(JSON.stringify(response.body)).not.toContain(
      'private database detail',
    );
    expect(filterSpy).toHaveBeenCalledTimes(1);
    const records = logger.error.mock.calls
      .map(([, meta]) => meta)
      .filter((meta) => meta?.requestId === response.body.traceId);
    expect(
      records.filter((meta) => meta.event === 'http.request'),
    ).toHaveLength(1);
    expect(records.filter((meta) => meta.event === 'http.error')).toHaveLength(
      1,
    );
    expect(records.find((meta) => meta.event === 'http.request')).toMatchObject(
      { outcome: 'completed', statusCode: 500 },
    );
  });

  it('exposes application metadata', async () => {
    const response = await apiClient.get(route('/system/info')).expect(200);
    const body = toSuccessBody<SystemInfoPayload>(response);

    expect(body.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Nest React Boilerplate');
    expect(body.data.version).toBe('0.0.1');
    expect(typeof body.data.environment).toBe('string');
  });

  it('resolves the sample module flow', async () => {
    const listResponse = await apiClient.get(route('/samples')).expect(200);
    const listBody = toSuccessBody<SamplePayload[]>(listResponse);

    expect(listBody.data).toHaveLength(3);
    expect(listBody.data[0]?.name).toBe('대시보드 카드 예제');

    const updateResponse = await apiClient
      .patch(route('/samples/sample_1/name'))
      .send({ name: '새 샘플 이름' })
      .expect(200);
    const updateBody = toSuccessBody<SamplePayload>(updateResponse);

    expect(updateBody.data.id).toBe('sample_1');
    expect(updateBody.data.name).toBe('새 샘플 이름');

    const detailResponse = await apiClient
      .get(route('/samples/sample_1'))
      .expect(200);
    const detailBody = toSuccessBody<SamplePayload>(detailResponse);

    expect(detailBody.data.id).toBe('sample_1');
    expect(detailBody.data.name).toBe('새 샘플 이름');
  });
});

describe('starter without sample modules', () => {
  it('keeps global bootstrap independent of feature modules', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CoreModule] })
      .overrideProvider(LoggerService)
      .useValue({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        verbose: jest.fn(),
      })
      .compile();
    const standalone = configureApp(moduleRef.createNestApplication());
    await standalone.init();
    await standalone.close();
  });
});
