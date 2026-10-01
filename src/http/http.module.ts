import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RateLimiter } from './rate-limit/rate-limiter';

@Module({
  providers: [RateLimiter],
})
export class HttpModule implements NestModule {
  constructor(private readonly rateLimiter: RateLimiter) {}

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(this.rateLimiter.middleware).forRoutes('{*path}');
  }
}
