import { getRequestId } from '../request-lifecycle/request-context';
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LoggerService } from '../../logging/logger.service';
import { BusinessError, type BusinessErrorKind } from '../../business-error';

type NormalizedError = {
  statusCode: number;
  code: string;
  message: string;
  error: string;
};

const businessErrorHttp = {
  not_found: { statusCode: 404, error: 'Not Found' },
  validation: { statusCode: 400, error: 'Bad Request' },
  forbidden: { statusCode: 403, error: 'Forbidden' },
  unauthorized: { statusCode: 401, error: 'Unauthorized' },
} satisfies Record<
  BusinessErrorKind,
  Pick<NormalizedError, 'statusCode' | 'error'>
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeMessage(message: unknown): string | undefined {
  if (Array.isArray(message)) {
    return message
      .filter((value): value is string => typeof value === 'string')
      .join(', ');
  }

  if (typeof message === 'string') {
    return message;
  }

  return undefined;
}

function normalizeException(exception: unknown): NormalizedError {
  if (exception instanceof BusinessError) {
    if (!Object.hasOwn(businessErrorHttp, exception.kind)) return serverError();
    return {
      ...businessErrorHttp[exception.kind],
      code: exception.code,
      message: exception.message,
    };
  }
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    if (statusCode >= 500) return serverError(statusCode);
    const response = exception.getResponse();
    const responseObj =
      typeof response === 'string'
        ? { message: response }
        : isRecord(response)
          ? response
          : {};

    return {
      statusCode,
      code:
        typeof responseObj.code === 'string'
          ? responseObj.code
          : exception.name,
      message:
        normalizeMessage(responseObj.message) ??
        exception.message ??
        'Internal server error',
      error:
        typeof responseObj.error === 'string'
          ? responseObj.error
          : exception.name,
    };
  }

  return serverError();
}

function serverError(statusCode = 500): NormalizedError {
  return {
    statusCode,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
    error: 'Internal Server Error',
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const normalized = normalizeException(exception);
    const traceId = getRequestId(response);

    const responseBody = {
      statusCode: normalized.statusCode,
      success: false,
      code: normalized.code,
      message: normalized.message,
      error: normalized.error,
      traceId,
    };

    const { message: _publicMessage, ...safeResponseMeta } = responseBody;
    const logMeta = {
      ...safeResponseMeta,
      event: 'http.error',
      requestId: traceId,
      path: (request.originalUrl || request.url).split('?')[0],
      method: request.method,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      stack:
        normalized.statusCode >= 500 && exception instanceof Error
          ? exception.stack
          : undefined,
    };
    if (normalized.statusCode >= 500) {
      this.logger.error('Unhandled server exception', logMeta);
    }

    // A late failure cannot replace a response already sent to the client.
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.status(normalized.statusCode).json(responseBody);
  }
}
