import { registerAs } from '@nestjs/config';
import { parseBool } from '../utils/parse.util';

export type CorsConfig = {
  originList: string[];
  methods: string[];
  allowedHeaders: string[];
  credentials: boolean;
};

export default registerAs('cors', () => {
  const originList = process.env.CORS_ORIGIN_LIST
    ? process.env.CORS_ORIGIN_LIST.split(',').map((o) => o.trim())
    : ['http://localhost:5173'];

  const allowedHeaders = (
    process.env.CORS_ALLOWED_HEADERS
      ? process.env.CORS_ALLOWED_HEADERS.split(',').map((h) => h.trim())
      : ['Content-Type', 'Authorization', 'X-Request-Id']
  ).filter(Boolean);

  const credentials = parseBool({
    value: process.env.CORS_CREDENTIALS,
    fallback: false,
  });

  const methods = (
    process.env.CORS_METHODS
      ? process.env.CORS_METHODS.split(',').map((method) => method.trim())
      : ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
  ).filter(Boolean);

  return { originList, allowedHeaders, credentials, methods };
});
