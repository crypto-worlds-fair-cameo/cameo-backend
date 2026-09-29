import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import type { AllConfigType } from '../../../config/config.type';
import { PgPoolProvider } from './pg.pool.provider';

describe('PgPoolProvider', () => {
  it('configures bounded waits, keepalive and certificate verification', async () => {
    const database = {
      pg: {
        host: 'localhost',
        port: 5432,
        user: 'test',
        password: 'test',
        database: 'test',
        max: 2,
        ssl: true,
        sslCa: 'provider CA',
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        statementTimeoutMillis: 10000,
        idleInTransactionSessionTimeoutMillis: 10000,
      },
    };
    const factory = PgPoolProvider as FactoryProvider<Pool>;
    const pool = await factory.useFactory(
      new ConfigService<AllConfigType>({ database }),
    );
    expect(pool.options).toMatchObject({
      ssl: { rejectUnauthorized: true, ca: 'provider CA' },
      keepAlive: true,
      connectionTimeoutMillis: 2000,
      statement_timeout: 10000,
      idle_in_transaction_session_timeout: 10000,
    });
    expect(pool.listenerCount('error')).toBe(1);
    await pool.end();
  });
});
