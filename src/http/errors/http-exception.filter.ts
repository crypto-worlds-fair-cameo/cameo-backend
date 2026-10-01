import { getRequestId } from '../request-lifecycle/request-context';
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { LoggerService } from '../../logging/logger.service';
import { BusinessError } from '../../business-error';
import { CommonErrorCodes } from '../../errors/common.error-codes';
import { ErrorCodes } from '../../errors/error-codes';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  /** 예외의 공개 정보로 오류 응답을 작성하고, 5xx 원인은 서버 로그에 기록합니다. */
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    let statusCode =
      exception instanceof BusinessError
        ? exception.statusCode
        : exception instanceof HttpException
          ? exception.getStatus()
          : ErrorCodes.InternalServerError.statusCode;

    // 업무 오류는 정의된 값을 사용하고, 5xx와 알 수 없는 오류의 상세는 공개하지 않습니다.
    const publicError =
      exception instanceof BusinessError && statusCode < 500
        ? exception
        : ErrorCodes.InternalServerError;
    let { code, message } = publicError;

    // Nest 기본 예외도 공통 응답에 담고, DTO 검증 메시지 배열은 문자열로 전달합니다.
    if (exception instanceof HttpException && statusCode < 500) {
      const exceptionResponse = exception.getResponse();
      const payload =
        typeof exceptionResponse === 'object' && exceptionResponse !== null
          ? (exceptionResponse as Record<string, unknown>)
          : {};
      const exceptionMessage =
        typeof exceptionResponse === 'string'
          ? exceptionResponse
          : payload.message;

      code = typeof payload.code === 'string' ? payload.code : exception.name;
      message = Array.isArray(exceptionMessage)
        ? exceptionMessage
            .filter((value): value is string => typeof value === 'string')
            .join(', ')
        : typeof exceptionMessage === 'string'
          ? exceptionMessage
          : (exception.message ?? ErrorCodes.InternalServerError.message);
    }
    // Nest 예외로 감싸지지 않은 파서 오류도 공통 정의로 처리해 413·415 상태를 보존합니다.
    if (
      exception instanceof Error &&
      !(exception instanceof BusinessError) &&
      !(exception instanceof HttpException) &&
      'expose' in exception &&
      exception.expose === true &&
      'statusCode' in exception &&
      typeof exception.statusCode === 'number' &&
      exception.statusCode >= 400 &&
      exception.statusCode < 500 &&
      'status' in exception &&
      exception.status === exception.statusCode
    ) {
      const definition = Object.values(CommonErrorCodes).find(
        (value) => value.statusCode === exception.statusCode,
      );
      if (definition) {
        ({ statusCode, code, message } = definition);
      }
    }
    const traceId = getRequestId(response);

    const responseBody = {
      statusCode,
      success: false,
      code,
      message,
      traceId,
    };

    // 내부 원인과 응답 로그를 같은 요청 ID로 연결합니다.
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
        statusCode >= 500 && exception instanceof Error
          ? exception.stack
          : undefined,
    };
    if (statusCode >= 500) {
      this.logger.error('Unhandled server exception', logMeta);
    }

    // 이미 종료된 응답에는 쓰지 않고, 헤더 전송 후 오류는 연결을 종료합니다.
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.status(statusCode).json(responseBody);
  }
}
