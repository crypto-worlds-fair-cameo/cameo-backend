import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { LoggerService } from '../../logging/logger.service';

type AccessLogger = Pick<LoggerService, 'log' | 'warn' | 'error'>;

export function createRequestLifecycleMiddleware(
  logger: AccessLogger,
): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const path = (request.originalUrl || request.url).split('?')[0];
    response.locals.requestId = requestId;
    response.setHeader('x-request-id', requestId);
    let recorded = false;

    const record = (outcome: 'completed' | 'aborted') => {
      if (recorded) return;
      recorded = true;
      response.off('finish', onFinish);
      response.off('close', onClose);
      const statusCode = response.headersSent ? response.statusCode : null;
      const meta = {
        event: 'http.request',
        requestId,
        method: request.method,
        path,
        statusCode,
        headersSent: response.headersSent,
        outcome,
        durationMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      };
      if (statusCode !== null && statusCode >= 500)
        logger.error('HTTP request', meta);
      else if (
        outcome === 'aborted' ||
        (statusCode !== null && statusCode >= 400)
      )
        logger.warn('HTTP request', meta);
      else logger.log('HTTP request', meta);
    };
    const onFinish = () => record('completed');
    const onClose = () =>
      record(response.writableFinished ? 'completed' : 'aborted');
    response.once('finish', onFinish);
    response.once('close', onClose);
    next();
  };
}
