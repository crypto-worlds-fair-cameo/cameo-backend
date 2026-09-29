import { PgReadinessService } from './infra/database/postgres/pg-readiness.service';
import {
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from './config/config.type';

@Injectable()
export class AppService {
  constructor(
    private readonly configService: ConfigService<AllConfigType>,
    @Optional() private readonly databaseReadiness?: PgReadinessService,
  ) {}

  async getReadiness() {
    try {
      await this.databaseReadiness?.check();
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    }
    return {
      status: 'ok',
      database: this.databaseReadiness ? 'up' : 'disabled',
    };
  }

  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  getSystemInfo() {
    return {
      name: this.configService.getOrThrow('app.name', { infer: true }),
      environment: this.configService.getOrThrow('app.nodeEnv', {
        infer: true,
      }),
      version: this.configService.getOrThrow('app.version', { infer: true }),
    };
  }
}
