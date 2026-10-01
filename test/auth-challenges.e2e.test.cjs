const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { before, after, beforeEach, describe, it } = require('node:test');
const { Pool } = require('pg');

if (existsSync('.env')) process.loadEnvFile('.env');

const { createApp } = require('../dist/app.factory.js');
const corsConfig = require('../dist/config/cors.config.js').default;
const origin = 'http://localhost:5173';
const schema = `cameo_challenges_test_${randomBytes(8).toString('hex')}`;
const cookieName = 'cameo_auth_binding';
const migration = readFileSync(
  'db/migrations/2026-10-01-01-auth-challenges.sql',
  'utf8',
).replaceAll('public.', `"${schema}".`);
let database;
let application;
let url;
let oldPgOptions;

/** 테스트 환경만 변경해 앱을 실행하고, 다른 테스트가 원래 설정을 사용하도록 복원한다. */
async function startApplication(overrides = {}) {
  const values = {
    NODE_ENV: 'test',
    API_PREFIX: 'api',
    CORS_ORIGIN_LIST: origin,
    CORS_CREDENTIALS: undefined,
    RATE_LIMIT_LIMIT: '1000',
    ...overrides,
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  let app;
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    return { app, baseUrl: await app.getUrl() };
  } catch (error) {
    if (app) await app.close();
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function issue(options = {}) {
  const headers = {};
  if (options.origin !== null) headers.Origin = options.origin ?? origin;
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(
    `${options.baseUrl ?? url}${options.path ?? '/api/auth/challenges'}${options.query ?? ''}`,
    {
      method: 'POST',
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    },
  );
  return { response, payload: await response.json() };
}

function bindingCookie(response, name = cookieName) {
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.ok(cookies[0].startsWith(`${name}=`));
  return {
    header: cookies[0],
    value: cookies[0].split(';')[0].slice(name.length + 1),
  };
}

async function challengeCount() {
  const result = await database.query(
    `SELECT count(*)::int AS count FROM "${schema}".auth_challenges`,
  );
  return result.rows[0].count;
}

describe('로그인 챌린지 HTTP·PostgreSQL 계약', { concurrency: false }, () => {
  before(async () => {
    oldPgOptions = process.env.PGOPTIONS;
    database = new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'dev',
      password: process.env.DB_PASSWORD ?? 'devpass',
      database: process.env.DB_NAME ?? 'devdb',
      connectionTimeoutMillis: 2000,
    });
    await database.query(`CREATE SCHEMA "${schema}"`);
    // 배포에 사용하는 기준 SQL을 임시 스키마에 적용해 기존 테이블과 데이터를 건드리지 않는다.
    await database.query(migration);
    process.env.PGOPTIONS = `-c search_path=${schema}`;
    const started = await startApplication();
    application = started.app;
    url = started.baseUrl;
  });

  after(async () => {
    try {
      if (application) await application.close();
      if (database)
        await database.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      if (database) await database.end();
      if (oldPgOptions === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = oldPgOptions;
    }
  });

  beforeEach(async () => {
    await database.query(`TRUNCATE "${schema}".auth_challenges`);
  });

  it('본문 없이 DB 시각 기준 SIWS 입력과 연결 쿠키를 발급한다', async () => {
    const beforeIssue = (
      await database.query('SELECT clock_timestamp() AS now')
    ).rows[0].now;
    const { response, payload } = await issue();
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(payload).sort(), [
      'data',
      'statusCode',
      'success',
    ]);
    assert.equal(payload.success, true);
    assert.equal(payload.statusCode, 201);
    assert.deepEqual(Object.keys(payload.data).sort(), [
      'challengeId',
      'signInInput',
    ]);
    const { challengeId, signInInput } = payload.data;
    assert.match(
      challengeId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(Object.keys(signInInput).sort(), [
      'chainId',
      'domain',
      'expirationTime',
      'issuedAt',
      'nonce',
      'requestId',
      'statement',
      'uri',
      'version',
    ]);
    assert.equal(signInInput.domain, 'localhost:5173');
    assert.equal(signInInput.uri, 'http://localhost:5173/');
    assert.equal(signInInput.statement, 'Sign in to Cameo.');
    assert.equal(signInInput.version, '1');
    assert.equal(signInInput.chainId, 'mainnet');
    assert.equal(signInInput.requestId, challengeId);
    assert.match(signInInput.nonce, /^[0-9a-f]{64}$/);
    assert.equal(
      Date.parse(signInInput.expirationTime) - Date.parse(signInInput.issuedAt),
      300000,
    );
    const cookie = bindingCookie(response);
    assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(cookie.value, 'base64url').length, 32);
    assert.match(cookie.header, /Max-Age=300/);
    assert.match(cookie.header, /Path=\//);
    assert.match(cookie.header, /HttpOnly/);
    assert.match(cookie.header, /SameSite=Lax/);
    assert.doesNotMatch(cookie.header, /Domain=|Secure/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const row = (
      await database.query(
        `SELECT * FROM "${schema}".auth_challenges WHERE id = $1`,
        [challengeId],
      )
    ).rows[0];
    assert.equal(row.auth_method, 'siws');
    assert.equal(row.nonce, signInInput.nonce);
    assert.deepEqual(row.verification_payload, signInInput);
    assert.equal(
      row.browser_binding_hash,
      createHash('sha256').update(cookie.value).digest('hex'),
    );
    assert.equal(row.created_at.toISOString(), signInInput.issuedAt);
    assert.equal(row.expires_at.toISOString(), signInInput.expirationTime);
    assert.equal(row.consumed_at, null);
    assert.ok(row.created_at.getTime() >= beforeIssue.getTime());
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(
      response.headers.get('access-control-allow-credentials'),
      'true',
    );
  });

  it('본문과 정의되지 않은 쿼리로 서버 발급 값을 바꿀 수 없다', async () => {
    const { response, payload } = await issue({
      body: {
        domain: 'evil.example',
        nonce: 'attacker',
        userId: 'another-user',
        signInInput: {},
      },
      query: '?domain=evil.example&nonce=attacker&unknown[x]=value',
    });
    assert.equal(response.status, 201);
    assert.equal(payload.data.signInInput.domain, 'localhost:5173');
    assert.notEqual(payload.data.signInInput.nonce, 'attacker');
    assert.equal(await challengeCount(), 1);
  });

  it('기준 SQL을 재적용해도 발급한 챌린지와 입력을 유지한다', async () => {
    const { response, payload } = await issue();
    assert.equal(response.status, 201);
    await database.query(migration);
    const row = (
      await database.query(
        `SELECT verification_payload FROM "${schema}".auth_challenges WHERE id = $1`,
        [payload.data.challengeId],
      )
    ).rows[0];
    assert.equal(await challengeCount(), 1);
    assert.deepEqual(row.verification_payload, payload.data.signInInput);
  });

  it('형식이 맞는 쿠키를 유지하면서 다른 챌린지와 nonce를 발급한다', async () => {
    const original = Buffer.alloc(32, 171).toString('base64url');
    const first = await issue({ cookie: `${cookieName}=${original}` });
    const second = await issue({ cookie: `${cookieName}=${original}` });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 201);
    assert.equal(bindingCookie(first.response).value, original);
    assert.equal(bindingCookie(second.response).value, original);
    assert.notEqual(
      first.payload.data.challengeId,
      second.payload.data.challengeId,
    );
    assert.notEqual(
      first.payload.data.signInInput.nonce,
      second.payload.data.signInInput.nonce,
    );
    assert.equal(await challengeCount(), 2);
  });

  for (const invalid of ['short', '!'.repeat(43), `${'A'.repeat(42)}B`]) {
    it(`잘못된 연결 쿠키를 새 난수로 교체한다: ${invalid.slice(0, 8)}`, async () => {
      const { response } = await issue({ cookie: `${cookieName}=${invalid}` });
      assert.equal(response.status, 201);
      const value = bindingCookie(response).value;
      assert.notEqual(value, invalid);
      assert.equal(
        Buffer.from(value, 'base64url').toString('base64url'),
        value,
      );
    });
  }

  it('같은 이름의 쿠키가 중복되면 새 연결값을 발급한다', async () => {
    const first = Buffer.alloc(32, 1).toString('base64url');
    const second = Buffer.alloc(32, 2).toString('base64url');
    const { response } = await issue({
      cookie: `${cookieName}=${first}; ${cookieName}=${second}`,
    });
    assert.equal(response.status, 201);
    const value = bindingCookie(response).value;
    assert.notEqual(value, first);
    assert.notEqual(value, second);
  });

  for (const disallowed of [
    null,
    'null',
    'https://evil.example',
    `${origin}.evil.example`,
    `${origin}/`,
  ]) {
    it(`잘못된 요청 출처는 저장과 쿠키 없이 403이다: ${disallowed}`, async () => {
      const { response, payload } = await issue({ origin: disallowed });
      assert.equal(response.status, 403);
      assert.equal(payload.code, 'AUTH_ORIGIN_NOT_ALLOWED');
      assert.equal(payload.message, '허용되지 않은 요청 출처입니다.');
      assert.equal(payload.error, 'Forbidden');
      assert.equal(payload.success, false);
      assert.equal(payload.traceId, response.headers.get('x-request-id'));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(response.headers.getSetCookie(), []);
      assert.equal(await challengeCount(), 0);
    });
  }

  it('커밋 실패는 챌린지를 롤백하고 쿠키 없이 500을 반환한다', async () => {
    await database.query(`
      CREATE FUNCTION "${schema}".fail_challenge_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced challenge commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER fail_challenge_commit AFTER INSERT ON "${schema}".auth_challenges
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "${schema}".fail_challenge_commit();
    `);
    try {
      const { response, payload } = await issue();
      assert.equal(response.status, 500);
      assert.equal(payload.code, 'INTERNAL_SERVER_ERROR');
      assert.equal(payload.message, 'Internal server error');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(response.headers.getSetCookie(), []);
      assert.equal(await challengeCount(), 0);
    } finally {
      await database.query(
        `DROP TRIGGER fail_challenge_commit ON "${schema}".auth_challenges`,
      );
      await database.query(`DROP FUNCTION "${schema}".fail_challenge_commit()`);
    }
  });

  it('잘못된 JSON은 기존 공개 400 형식과 캐시 금지를 유지한다', async () => {
    const response = await fetch(`${url}/api/auth/challenges`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).success, false);
    assert.deepEqual(response.headers.getSetCookie(), []);
    assert.equal(await challengeCount(), 0);
  });

  it('운영은 HTTPS 프론트 출처와 Secure 호스트 전용 쿠키를 사용한다', async () => {
    const started = await startApplication({
      NODE_ENV: 'production',
      CORS_ORIGIN_LIST: 'https://app.example.com',
    });
    try {
      const { response, payload } = await issue({
        baseUrl: started.baseUrl,
        origin: 'https://app.example.com',
      });
      assert.equal(response.status, 201);
      const cookie = bindingCookie(response, '__Host-cameo_auth_binding');
      assert.match(cookie.header, /Secure/);
      assert.doesNotMatch(cookie.header, /Domain=/);
      assert.equal(payload.data.signInInput.domain, 'app.example.com');
      assert.equal(payload.data.signInInput.uri, 'https://app.example.com/');
    } finally {
      await started.app.close();
    }
  });

  it('빈 API 접두사에서도 발급과 초기 캐시 금지가 적용된다', async () => {
    const started = await startApplication({ API_PREFIX: '' });
    try {
      const { response } = await issue({
        baseUrl: started.baseUrl,
        path: '/auth/challenges',
      });
      assert.equal(response.status, 201);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } finally {
      await started.app.close();
    }
  });

  it('요청 한도 초과는 쿠키 없이 기존 429와 Retry-After를 반환한다', async () => {
    const started = await startApplication({ RATE_LIMIT_LIMIT: '1' });
    try {
      assert.equal(
        (await issue({ baseUrl: started.baseUrl })).response.status,
        201,
      );
      const { response, payload } = await issue({ baseUrl: started.baseUrl });
      assert.equal(response.status, 429);
      assert.equal(payload.code, 'ThrottlerException');
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(response.headers.getSetCookie(), []);
      assert.equal(await challengeCount(), 1);
    } finally {
      await started.app.close();
    }
  });

  it('공통 본문 검증은 추가 필드를 제거하고 허용된 값만 검증한다', async () => {
    const response = await fetch(
      `${url}/api/samples/sample_1/name?unknown=ignored`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '허용된 이름', role: 'admin' }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.name, '허용된 이름');
    const invalid = await fetch(`${url}/api/samples/sample_1/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 123, role: 'admin' }),
    });
    assert.equal(invalid.status, 400);
  });

  it('쿠키 인증 설정에서 와일드카드 출처를 허용하지 않는다', () => {
    const previous = process.env.CORS_ORIGIN_LIST;
    try {
      process.env.CORS_ORIGIN_LIST = '*';
      assert.throws(() => corsConfig());
    } finally {
      if (previous === undefined) delete process.env.CORS_ORIGIN_LIST;
      else process.env.CORS_ORIGIN_LIST = previous;
    }
  });
});
