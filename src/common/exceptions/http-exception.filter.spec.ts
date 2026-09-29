import {
  BadRequestException,
  InternalServerErrorException,
  type ArgumentsHost,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';
import type { LoggerService } from '../../core/logger/logger.service';

describe('HttpExceptionFilter', () => {
  const run = (
    error: unknown,
    state: Record<string, boolean | undefined> = {},
  ) => {
    const logger = { error: jest.fn(), warn: jest.fn() };
    const response = {
      ...state,
      destroy: jest.fn(),
      locals: { requestId: 'server-id' },
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({
          url: '/samples?token=secret',
          method: 'GET',
          headers: {},
        }),
      }),
    } as unknown as ArgumentsHost;
    new HttpExceptionFilter(logger as unknown as LoggerService).catch(
      error,
      host,
    );
    return { logger, response };
  };

  it.each([
    new Error('database password'),
    new InternalServerErrorException({
      message: 'database password',
      code: 'secret',
      error: 'private',
    }),
  ])('sanitizes every server error', (error) => {
    const { response, logger } = run(error);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        error: 'Internal Server Error',
      }),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ path: '/samples' }),
    );
  });

  it('does not log reflected query values in client error messages or stacks', () => {
    const { logger } = run(
      new BadRequestException('invalid /samples?token=secret'),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(
      'token=secret',
    );
  });

  it('preserves validation messages and leaves client access logging to middleware', () => {
    const { response, logger } = run(
      new BadRequestException(['name must be a string']),
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'name must be a string',
      }),
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
  it.each([{ destroyed: true }, { writableEnded: true }])(
    'does not write to a closed response: %j',
    (state) => {
      const { response, logger } = run(new Error('late failure'), state);
      expect(response.status).not.toHaveBeenCalled();
      expect(response.json).not.toHaveBeenCalled();
      expect(response.destroy).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledTimes(1);
    },
  );

  it('terminates a partial response instead of writing another body', () => {
    const { response } = run(new Error('late failure'), { headersSent: true });
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(response.destroy).toHaveBeenCalledTimes(1);
  });
});
