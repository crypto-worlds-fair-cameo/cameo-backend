import {
  Injectable,
  type LoggerService as NestLoggerService,
} from '@nestjs/common';
import {
  createLogger,
  format,
  transports,
  Logger as WinstonLogger,
} from 'winston';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';

type LogMeta = Record<string, unknown>;

function toMessageString(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }

  try {
    return (
      JSON.stringify(message, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ) ?? String(message)
    );
  } catch {
    return String(message);
  }
}

@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly logger: WinstonLogger;

  /**
   * 실행 환경에 맞는 콘솔 로그 포맷을 구성하고 stdout/stderr로 로그를 전달합니다.
   */
  constructor(private readonly configService: ConfigService<AllConfigType>) {
    const nodeEnv = this.configService.get<string>('app.nodeEnv', {
      infer: true,
    });
    const isProd = nodeEnv === 'production';

    const productionConsoleFormat = format.combine(
      format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      format.errors({ stack: true }),
      format.json(),
    );

    const devConsoleFormat = format.combine(
      format.colorize(),
      format.timestamp({ format: 'HH:mm:ss' }),
      format.printf(({ timestamp, level, message, ...meta }) => {
        const metaString = Object.keys(meta).length
          ? ` ${JSON.stringify(meta)}`
          : '';
        return `[${String(timestamp)}] [${String(level)}] ${toMessageString(message)}${metaString}`;
      }),
    );

    const consoleFormat = isProd ? productionConsoleFormat : devConsoleFormat;

    this.logger = createLogger({
      level: isProd ? 'info' : 'debug',
      transports: [
        new transports.Console({
          format: consoleFormat,
          stderrLevels: ['error'],
        }),
      ],
    });
  }

  log(message: unknown, ...optionalParams: unknown[]) {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]) {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]) {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]) {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]) {
    this.write('verbose', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]) {
    this.write('error', message, optionalParams);
  }

  private write(level: string, message: unknown, optionalParams: unknown[]) {
    const meta: LogMeta = {};
    const strings: string[] = [];
    for (const value of optionalParams) {
      if (typeof value === 'string') strings.push(value);
      else if (value instanceof Error) {
        meta.exceptionName = value.name;
        meta.stack = value.stack;
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(meta, value);
      }
    }
    if (strings.length > 1) {
      meta.stack = strings.slice(0, -1).join('\n');
      meta.context = strings.at(-1);
    } else if (strings.length === 1) {
      if (level === 'error' && /\n\s*at /.test(strings[0]))
        meta.stack = strings[0];
      else meta.context = strings[0];
    }
    if (message instanceof Error) {
      meta.exceptionName = message.name;
      meta.stack = message.stack;
      message = message.message;
    }
    // Winston metadata must not override the actual log level or message.
    delete meta.level;
    delete meta.message;
    this.logger.log({ ...meta, level, message: toMessageString(message) });
  }
}
