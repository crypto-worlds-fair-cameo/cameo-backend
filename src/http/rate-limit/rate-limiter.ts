import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rateLimit, MemoryStore } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { OnModuleDestroy } from '@nestjs/common';
import type { AllConfigType } from '../../config/config.type';
import { createProbeSkipPolicy } from './probe-policy';

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  readonly middleware: RequestHandler;
  private readonly store = new MemoryStore();

  constructor(config: ConfigService<AllConfigType>) {
    const { ttl, limit } = config.getOrThrow('rateLimit', { infer: true });
    const { apiPrefix } = config.getOrThrow('app', { infer: true });
    this.middleware = rateLimit({
      windowMs: ttl,
      limit,
      store: this.store,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skip: createProbeSkipPolicy(apiPrefix),
      handler: (_request, _response, next) => {
        next(
          new HttpException(
            {
              code: 'ThrottlerException',
              message: 'ThrottlerException: Too Many Requests',
              error: 'ThrottlerException',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          ),
        );
      },
    });
  }

  onModuleDestroy() {
    this.store.shutdown();
  }
}
