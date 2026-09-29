import { ConfigService } from '@nestjs/config';
import { Logger, Provider } from '@nestjs/common';
import { Pool } from 'pg';
import { AllConfigType } from '../../../config/config.type';
import { DatabaseConfig } from '../../../config/database.config';
import { PG_POOL } from './pg.constants';

export const PgPoolProvider: Provider = {
  provide: PG_POOL,
  inject: [ConfigService],
  useFactory: (configService: ConfigService<AllConfigType>) => {
    const logger = new Logger('PgPoolProvider');
    const dbConfig: DatabaseConfig['pg'] = configService.getOrThrow(
      'database.pg',
      {
        infer: true,
      },
    );

    /**
     * max: Pool이 동시에 열 수 있는 최대 DB커넥션 수
     * - 개발/소규모 서비스: 10~20
     * - 중간 규모: 20~50
     * - 대규모: 앱 서버수 * (5~10)
     *
     * idleTimeoutMillis: 노는 쿼리 커넥션을 지정한 시간 후에 Pool에서 제거 (ms)
     * - 보통 10~60초
     *
     * connectionTimeoutMillis: Pool에서 커넥션을 못 구했을 때 얼마나 기다렸다가 실패할지(ms)
     * - 이미 max만큼 커넥션이 꽉 찼거나, DB가 느림/장애 상태일 때
     * - Railway/Supabase pooler 조합은 콜드 연결 지연이 있을 수 있어 운영에서는 env로 조정합니다.
     */
    // Supabase 같은 관리형 PostgreSQL은 운영에서 TLS 연결을 요구할 수 있습니다.
    const sslOptions = dbConfig.ssl
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(dbConfig.sslCa ? { ca: dbConfig.sslCa } : {}),
          },
        }
      : {};

    const pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      max: dbConfig.max,
      idleTimeoutMillis: dbConfig.idleTimeoutMillis,
      connectionTimeoutMillis: dbConfig.connectionTimeoutMillis,
      keepAlive: true,
      statement_timeout: dbConfig.statementTimeoutMillis,
      idle_in_transaction_session_timeout:
        dbConfig.idleInTransactionSessionTimeoutMillis,
      ...sslOptions,
    });

    pool.on('error', (error: Error) => {
      // idle client에서 발생한 연결 오류는 다음 요청의 500 원인이 될 수 있어 최소 로그를 남깁니다.
      logger.error('Unexpected PostgreSQL pool error.', error.stack);
    });

    return pool;
  },
};
