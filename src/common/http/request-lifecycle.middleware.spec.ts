import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { createRequestLifecycleMiddleware } from './request-lifecycle.middleware';

function setup() {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const response = Object.assign(new EventEmitter(), {
    locals: {},
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader: jest.fn(),
  });
  const request = {
    method: 'GET',
    originalUrl: '/api/samples?token=secret',
    headers: { 'x-request-id': 'client-value' },
  };
  const next = jest.fn();
  createRequestLifecycleMiddleware(logger)(
    request as unknown as Request,
    response as unknown as Response,
    next,
  );
  return { logger, response, request, next };
}

describe('HTTP request lifecycle', () => {
  it('generates a server ID without mutating client headers and records finish once', () => {
    const { logger, response, request, next } = setup();
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.headers['x-request-id']).toBe('client-value');
    response.headersSent = true;
    response.writableFinished = true;
    response.emit('finish');
    response.emit('close');
    expect(logger.log).toHaveBeenCalledTimes(1);
    const meta = logger.log.mock.calls[0][1];
    expect(meta).toMatchObject({
      event: 'http.request',
      method: 'GET',
      path: '/api/samples',
      statusCode: 200,
      outcome: 'completed',
      headersSent: true,
    });
    expect(meta.requestId).not.toBe('client-value');
    expect(response.setHeader).toHaveBeenCalledWith(
      'x-request-id',
      meta.requestId,
    );
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(meta)).not.toContain('secret');
    expect(response.listenerCount('close')).toBe(0);
  });
  it('records aborted requests before headers with null status, never the default 200', () => {
    const { logger, response } = setup();
    response.emit('close');
    response.emit('finish');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      statusCode: null,
      headersSent: false,
      outcome: 'aborted',
    });
    expect(logger.log).not.toHaveBeenCalled();
  });
  it('retains the sent status when a response is interrupted after headers', () => {
    const { logger, response } = setup();
    response.headersSent = true;
    response.statusCode = 202;
    response.emit('close');
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      statusCode: 202,
      outcome: 'aborted',
    });
  });
  it('records a delivered 500 as completed, not aborted', () => {
    const { logger, response } = setup();
    response.headersSent = true;
    response.statusCode = 500;
    response.writableFinished = true;
    response.emit('finish');
    response.emit('close');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][1]).toMatchObject({
      statusCode: 500,
      outcome: 'completed',
    });
  });
  it('uses completion state if close is observed after writableFinished', () => {
    const { logger, response } = setup();
    response.headersSent = true;
    response.writableFinished = true;
    response.statusCode = 429;
    response.emit('close');
    expect(logger.warn.mock.calls[0][1]).toMatchObject({
      statusCode: 429,
      outcome: 'completed',
    });
  });
});
