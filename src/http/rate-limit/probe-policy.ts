import type { Request } from 'express';
import { SYSTEM_ROUTES } from '@/system/system-routes';

export function createProbeSkipPolicy(apiPrefix: string) {
  const base = apiPrefix ? `/${apiPrefix}` : '';
  const paths = new Set(
    Object.values(SYSTEM_ROUTES).map((route) =>
      `${base}/${route}`.toLowerCase(),
    ),
  );

  return (request: Pick<Request, 'method' | 'originalUrl'>): boolean => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    // Nest middleware can be mounted beneath the prefix. Match the original
    // pathname using Express's default case-insensitive, non-strict routing.
    const pathname = request.originalUrl.split('?')[0].replace(/\/$/, '');
    return paths.has(pathname.toLowerCase());
  };
}
