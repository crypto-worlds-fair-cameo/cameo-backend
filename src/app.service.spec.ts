import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { PgReadinessService } from './infra/database/postgres/pg-readiness.service';

describe('readiness', () => {
  it('does not require a DB in the starter', async () => {
    await expect(
      new AppService(new ConfigService()).getReadiness(),
    ).resolves.toEqual({ status: 'ok', database: 'disabled' });
  });
  it('checks the configured DB and reports failure', async () => {
    const database = Object.create(
      PgReadinessService.prototype,
    ) as PgReadinessService;
    database.check = jest.fn().mockResolvedValue(undefined);
    const service = new AppService(new ConfigService(), database);
    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      database: 'up',
    });
    database.check = jest
      .fn()
      .mockRejectedValue(new Error('database credentials'));
    await expect(service.getReadiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
