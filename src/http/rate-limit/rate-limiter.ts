import { Injectable } from '@nestjs/common';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
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

  /** IP별 요청 제한을 구성하고 초과 시 중앙에 정의한 429 오류를 전달합니다. */
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
        next(new BusinessError(ErrorCodes.TooManyRequests));
      },
    });
  }

  onModuleDestroy() {
    this.store.shutdown();
  }
}
