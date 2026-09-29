import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from './logger.service';
import type { AllConfigType } from '../../config/config.type';

describe('LoggerService', () => {
  it('writes production JSON to stdout and errors with stack/context to stderr', () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const previousConsole = global.console;
    global.console = new Console(stdout, stderr);
    try {
      const logger = new LoggerService(
        new ConfigService<AllConfigType>({ app: { nodeEnv: 'production' } }),
      );
      logger.log('started', 'Bootstrap');
      logger.error('failed', 'Error: failure\n    at example.ts:1', 'Database');
      expect(JSON.parse(out.trim())).toMatchObject({
        level: 'info',
        message: 'started',
        context: 'Bootstrap',
      });
      expect(JSON.parse(err.trim())).toMatchObject({
        level: 'error',
        message: 'failed',
        context: 'Database',
        stack: 'Error: failure\n    at example.ts:1',
      });
    } finally {
      global.console = previousConsole;
      stdout.destroy();
      stderr.destroy();
    }
  });
});
