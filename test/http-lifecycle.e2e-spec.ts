import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.factory';
import { LoggerService } from '@/core/logger/logger.service';

const logger = () => ({
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
});

function config(prefix: string) {
  return new ConfigService({
    app: {
      name: 'test',
      version: '1',
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 5000,
      apiPrefix: prefix,
      trustProxyHops: 0,
    },
    throttler: { ttl: 60000, limit: 2 },
    cors: {
      originList: ['http://localhost:5173'],
      methods: ['GET', 'POST', 'PATCH', 'HEAD', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
      credentials: false,
    },
  });
}

async function makeApp(prefix: string) {
  const logs = logger();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(config(prefix))
    .overrideProvider(LoggerService)
    .useValue(logs)
    .compile();
  const app = configureApp(moduleRef.createNestApplication());
  return { app, logs };
}

describe.each(['', 'api/v2'])('probe policy with prefix "%s"', (prefix) => {
  let app: INestApplication;
  beforeEach(async () => {
    ({ app } = await makeApp(prefix));
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('keeps only GET/HEAD probe routes outside the shared quota', async () => {
    const client = request(app.getHttpServer());
    const route = (suffix: string) => `${prefix ? '/' + prefix : ''}${suffix}`;
    for (let i = 0; i < 3; i++) await client.get(route('/health')).expect(200);
    await client.get(route('/samples')).expect(200);
    await client.get(route('/samples')).expect(200);
    await client.get(route('/samples')).expect(429);
    await client.head(route('/health/')).expect(200);
    await client.get(route('/READY')).expect(200);
    await client.get(route('/health-history')).expect(429);
    await client.post(route('/health')).expect(429);
  });
});

describe.each([false, true])('client disconnect (headers sent: %s)', (sent) => {
  it('records exactly one aborted request with the actual transmission state', async () => {
    const { app, logs } = await makeApp('api');
    let notifyStarted!: (response: Response) => void;
    const started = new Promise<Response>((resolve) => {
      notifyStarted = resolve;
    });
    const express = app.getHttpAdapter().getInstance() as Express;
    express.get('/connection-test', (_req, res) => {
      if (sent) {
        res.status(202);
        res.write('partial response');
      }
      notifyStarted(res);
    });
    await app.listen(0, '127.0.0.1');
    try {
      const address = app.getHttpServer().address() as AddressInfo;
      const outgoing = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: '/connection-test?token=secret',
        headers: { 'x-request-id': 'untrusted-client-id' },
      });
      outgoing.on('error', () => {});
      const received = new Promise<void>((resolve) =>
        outgoing.once('response', (response) => {
          response.on('error', () => {});
          response.resume();
          resolve();
        }),
      );
      outgoing.end();
      const response = await started;
      if (sent) await received;
      const closed = new Promise<void>((resolve) =>
        response.once('close', resolve),
      );
      outgoing.destroy();
      await closed;
      const access = logs.warn.mock.calls.filter(
        ([, meta]) => meta?.event === 'http.request',
      );
      expect(access).toHaveLength(1);
      expect(access[0][1]).toMatchObject({
        path: '/connection-test',
        statusCode: sent ? 202 : null,
        headersSent: sent,
        outcome: 'aborted',
      });
      expect(access[0][1].requestId).not.toBe('untrusted-client-id');
      expect(JSON.stringify(access)).not.toContain('secret');
      expect(logs.error).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
