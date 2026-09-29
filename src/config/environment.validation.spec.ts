import { validateEnvironment } from './environment.validation';

describe('validateEnvironment', () => {
  it('accepts the starter defaults', () => {
    expect(() => validateEnvironment({})).not.toThrow();
  });

  it('rejects invalid numeric values', () => {
    expect(() => validateEnvironment({ PORT: 'abc' })).toThrow(
      'PORT must be a positive integer.',
    );
  });

  it('rejects invalid boolean values', () => {
    expect(() =>
      validateEnvironment({ CORS_CREDENTIALS: 'sometimes' }),
    ).toThrow('CORS_CREDENTIALS must be one of:');
  });
});

describe('security and database configuration', () => {
  it.each(['staging', '', 'Production'])(
    'rejects unsupported NODE_ENV %s',
    (NODE_ENV) => {
      expect(() => validateEnvironment({ NODE_ENV })).toThrow(
        'NODE_ENV must be one of',
      );
    },
  );
  it.each(['-1', '1.5', '', 'true'])(
    'rejects invalid proxy trust %s',
    (TRUST_PROXY_HOPS) => {
      expect(() => validateEnvironment({ TRUST_PROXY_HOPS })).toThrow(
        'TRUST_PROXY_HOPS',
      );
    },
  );
  it('accepts explicit proxy hops and verified TLS', () => {
    expect(() =>
      validateEnvironment({ TRUST_PROXY_HOPS: '1', DB_SSL: 'true' }),
    ).not.toThrow();
  });
  it('rejects credentials combined with a wildcard even in a mixed origin list', () => {
    expect(() =>
      validateEnvironment({
        CORS_CREDENTIALS: 'yes',
        CORS_ORIGIN_LIST: 'http://localhost:5173, *',
      }),
    ).toThrow('cannot include *');
  });
  it.each([
    'DB_CONNECTION_TIMEOUT_MS',
    'DB_IDLE_TIMEOUT_MS',
    'DB_STATEMENT_TIMEOUT_MS',
    'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
  ])('rejects unbounded or invalid %s', (key) => {
    expect(() => validateEnvironment({ [key]: '0' })).toThrow(key);
  });
});

describe('numeric runtime bounds', () => {
  it.each(['PORT', 'DB_PORT'])('rejects out-of-range %s', (key) => {
    expect(() => validateEnvironment({ [key]: '65536' })).toThrow(
      'at most 65535',
    );
    expect(() => validateEnvironment({ [key]: '65535' })).not.toThrow();
  });
  it.each([
    'RATE_LIMIT_TTL_MS',
    'DB_IDLE_TIMEOUT_MS',
    'DB_CONNECTION_TIMEOUT_MS',
    'DB_STATEMENT_TIMEOUT_MS',
    'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
  ])('rejects timer overflow in %s', (key) => {
    expect(() => validateEnvironment({ [key]: '2147483648' })).toThrow(
      'at most 2147483647',
    );
    expect(() => validateEnvironment({ [key]: '2147483647' })).not.toThrow();
  });
  it.each(['DB_POOL_MAX', 'RATE_LIMIT_LIMIT'])(
    'rejects unsafe integer %s',
    (key) => {
      expect(() => validateEnvironment({ [key]: '9007199254740992' })).toThrow(
        'positive integer',
      );
    },
  );
});
