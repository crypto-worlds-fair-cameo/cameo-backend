import { Module, Global } from '@nestjs/common';
import { RateLimiterModule } from './rate-limiter/rate-limiter.module';

@Global()
@Module({
  imports: [RateLimiterModule],
  exports: [],
})
export class InfraModule {}
