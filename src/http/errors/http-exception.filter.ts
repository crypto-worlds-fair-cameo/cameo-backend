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

/** 본문 파서의 입력 오류만 공개 4xx로 정리하며, 일반 DB·SDK 오류는 내부 실패로 남긴다. */
function normalizeBodyParserError(
  exception: unknown,
): NormalizedError | undefined {
  if (
    !(exception instanceof Error) ||
    !isRecord(exception) ||
    exception.expose !== true
  )
    return;
  const statusByType: Record<string, number> = {
    'entity.parse.failed': 400,
    'request.aborted': 400,
    'request.size.invalid': 400,
    'querystring.parse.rangeError': 400,
    'entity.too.large': 413,
    'parameters.too.many': 413,
    'charset.unsupported': 415,
    'encoding.unsupported': 415,
  };
  const status =
    typeof exception.type === 'string' &&
    Object.hasOwn(statusByType, exception.type)
      ? statusByType[exception.type]
      : // body-parser가 감싼 압축 해제 오류에는 type 대신 Node 압축 오류 코드와 errno가 남는다.
        exception.type === undefined &&
          typeof exception.errno === 'number' &&
          typeof exception.code === 'string' &&
          /^(?:Z_|ERR_)/.test(exception.code)
        ? 400
        : undefined;
  if (!status || exception.status !== status) return;
  if (status === 413)
    return {
      statusCode: status,
      code: 'PayloadTooLargeException',
      message: '요청 본문이 너무 큽니다.',
      error: 'Payload Too Large',
    };
  if (status === 415)
    return {
      statusCode: status,
      code: 'UnsupportedMediaTypeException',
      message: '지원하지 않는 본문 인코딩입니다.',
      error: 'Unsupported Media Type',
    };
  return {
    statusCode: status,
    code: 'BadRequestException',
    message: '요청 본문을 해석할 수 없습니다.',
    error: 'Bad Request',
  };
}

function normalizeException(exception: unknown): NormalizedError {
  const parserError = normalizeBodyParserError(exception);
  if (parserError) return parserError;
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
