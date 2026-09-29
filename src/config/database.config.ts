import { registerAs } from '@nestjs/config';

export type DbClientType = 'postgres';

export type PGConfig = {
  client: DbClientType;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  max: number;
  ssl: boolean;
  sslCa?: string;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  idleInTransactionSessionTimeoutMillis: number;
};

export type DatabaseConfig = {
  pg: PGConfig;
};

export default registerAs<DatabaseConfig>('database', () => ({
  pg: {
    client: 'postgres',
    ssl: ['true', '1', 'yes', 'y'].includes(
      (process.env.DB_SSL ?? 'false').trim().toLowerCase(),
    ),
    sslCa: process.env.DB_SSL_CA?.replace(/\\n/g, '\n') || undefined,
    idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30000),
    connectionTimeoutMillis: Number(
      process.env.DB_CONNECTION_TIMEOUT_MS ?? 2000,
    ),
    statementTimeoutMillis: Number(
      process.env.DB_STATEMENT_TIMEOUT_MS ?? 10000,
    ),
    idleInTransactionSessionTimeoutMillis: Number(
      process.env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS ?? 10000,
    ),
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'dev',
    password: process.env.DB_PASSWORD ?? 'devpass',
    database: process.env.DB_NAME ?? 'devdb',
    max: Number(process.env.DB_POOL_MAX ?? 10),
  },
}));
