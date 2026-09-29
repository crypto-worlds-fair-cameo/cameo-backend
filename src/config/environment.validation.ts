import { normalizeApiPrefix } from './app.config';

type EnvRecord = Record<string, string | undefined>;

const BOOLEAN_TRUE_VALUES = ['true', '1', 'yes', 'y'];
const BOOLEAN_FALSE_VALUES = ['false', '0', 'no', 'n'];

function isProvided(value: string | undefined): value is string {
  return value !== undefined;
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

function validateNonEmptyString(
  env: EnvRecord,
  errors: string[],
  key: string,
  fallback?: string,
) {
  const value = env[key] ?? fallback;

  if (isBlank(value)) {
    errors.push(`${key} must be a non-empty string.`);
  }
}

function validatePositiveInteger(
  env: EnvRecord,
  errors: string[],
  key: string,
  fallback: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const rawValue = env[key] ?? fallback;
  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    errors.push(`${key} must be a positive integer.`);
  } else if (value > maximum) {
    errors.push(`${key} must be at most ${maximum}.`);
  }
}

function validateBoolean(
  env: EnvRecord,
  errors: string[],
  key: string,
  fallback: string,
) {
  const rawValue = (env[key] ?? fallback).trim().toLowerCase();
  if (
    !BOOLEAN_TRUE_VALUES.includes(rawValue) &&
    !BOOLEAN_FALSE_VALUES.includes(rawValue)
  ) {
    errors.push(
      `${key} must be one of: ${[...BOOLEAN_TRUE_VALUES, ...BOOLEAN_FALSE_VALUES].join(', ')}.`,
    );
  }
}

function validateCsvList(
  env: EnvRecord,
  errors: string[],
  key: string,
  fallback: string,
) {
  const rawValue = env[key] ?? fallback;
  const values = rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    errors.push(`${key} must include at least one value.`);
  }
}

export function validateEnvironment(env: EnvRecord): EnvRecord {
  const errors: string[] = [];

  validateNonEmptyString(env, errors, 'APP_NAME', 'Nest React Boilerplate');
  validateNonEmptyString(env, errors, 'APP_VERSION', '0.0.1');
  if (
    !['development', 'test', 'production'].includes(
      env.NODE_ENV ?? 'development',
    )
  ) {
    errors.push('NODE_ENV must be one of: development, test, production.');
  }
  const hops = Number(env.TRUST_PROXY_HOPS ?? '0');
  if (
    !Number.isSafeInteger(hops) ||
    hops < 0 ||
    env.TRUST_PROXY_HOPS?.trim() === ''
  ) {
    errors.push('TRUST_PROXY_HOPS must be a non-negative integer.');
  }
  validateNonEmptyString(env, errors, 'HOST', '127.0.0.1');
  validatePositiveInteger(env, errors, 'PORT', '5000', 65535);
  validatePositiveInteger(
    env,
    errors,
    'RATE_LIMIT_TTL_MS',
    '60000',
    2147483647,
  );
  validatePositiveInteger(env, errors, 'RATE_LIMIT_LIMIT', '100');
  validatePositiveInteger(env, errors, 'DB_PORT', '5432', 65535);
  validatePositiveInteger(env, errors, 'DB_POOL_MAX', '10');
  validateBoolean(env, errors, 'CORS_CREDENTIALS', 'false');
  validateBoolean(env, errors, 'DB_SSL', 'false');
  for (const [key, fallback] of Object.entries({
    DB_IDLE_TIMEOUT_MS: '30000',
    DB_CONNECTION_TIMEOUT_MS: '2000',
    DB_STATEMENT_TIMEOUT_MS: '10000',
    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '10000',
  })) {
    validatePositiveInteger(env, errors, key, fallback, 2147483647);
  }
  if (
    BOOLEAN_TRUE_VALUES.includes(
      (env.CORS_CREDENTIALS ?? 'false').trim().toLowerCase(),
    ) &&
    (env.CORS_ORIGIN_LIST ?? '')
      .split(',')
      .some((origin) => origin.trim() === '*')
  ) {
    errors.push(
      'CORS_ORIGIN_LIST cannot include * when CORS_CREDENTIALS is enabled.',
    );
  }
  validateCsvList(env, errors, 'CORS_ORIGIN_LIST', 'http://localhost:5173');
  validateCsvList(
    env,
    errors,
    'CORS_ALLOWED_HEADERS',
    'Content-Type,Authorization,X-Request-Id',
  );
  validateCsvList(
    env,
    errors,
    'CORS_METHODS',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  );

  validateNonEmptyString(env, errors, 'DB_HOST', 'localhost');
  validateNonEmptyString(env, errors, 'DB_USER', 'dev');
  validateNonEmptyString(env, errors, 'DB_NAME', 'devdb');

  if (isProvided(env.API_PREFIX)) {
    normalizeApiPrefix(env.API_PREFIX);
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return env;
}
