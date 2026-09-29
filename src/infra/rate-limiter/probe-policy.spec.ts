import { createProbeSkipPolicy } from './probe-policy';

describe('probe rate limit policy', () => {
  it.each(['', 'api', 'api/v1'])(
    'exempts only GET/HEAD probes under prefix %s',
    (prefix) => {
      const skip = createProbeSkipPolicy(prefix);
      const base = prefix ? `/${prefix}` : '';
      for (const method of ['GET', 'HEAD']) {
        for (const route of ['health', 'ready']) {
          expect(skip({ method, originalUrl: `${base}/${route}` })).toBe(true);
          expect(
            skip({ method, originalUrl: `${base}/${route}/?probe=1` }),
          ).toBe(true);
          expect(
            skip({ method, originalUrl: `${base}/${route}`.toUpperCase() }),
          ).toBe(true);
        }
      }
      for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
        expect(skip({ method, originalUrl: `${base}/health` })).toBe(false);
      }
      for (const path of [
        '/samples/health-history',
        '/healthy',
        '/ready/extra',
        '/health//',
        '/health.json',
        '/%68ealth',
      ]) {
        expect(skip({ method: 'GET', originalUrl: `${base}${path}` })).toBe(
          false,
        );
      }
      expect(skip({ method: 'GET', originalUrl: '/other/health' })).toBe(false);
      if (prefix)
        expect(skip({ method: 'GET', originalUrl: '/health' })).toBe(false);
    },
  );
});
