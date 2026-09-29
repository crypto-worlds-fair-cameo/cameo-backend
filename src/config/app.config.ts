import { registerAs } from '@nestjs/config';

export type AppConfig = {
  name: string;
  version: string;
  nodeEnv: string;
  trustProxyHops: number;
  host: string;
  port: number;
  apiPrefix: string;
};

export function normalizeApiPrefix(value: string | undefined): string {
  if (value === undefined) {
    return 'api';
  }

  return value.trim().replace(/^\/+|\/+$/g, '');
}

export default registerAs('app', () => ({
  name: process.env.APP_NAME || 'Nest React Boilerplate',
  version: process.env.APP_VERSION || '0.0.1',
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '5000', 10),
  apiPrefix: normalizeApiPrefix(process.env.API_PREFIX),
}));
