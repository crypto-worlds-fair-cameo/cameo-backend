require('reflect-metadata');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { existsSync, mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const zlib = require('node:zlib');
const { Global, Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { configureApp } = require('../../dist/app.factory');
const { UserModule } = require('../../dist/modules/user/user.module');
const {
  authCookies,
} = require('../../dist/modules/auth/resources/auth-cookie/auth-http');
const { testDatabaseModule } = require('../canvas/database-fixture.cjs');
const { insertWalletSession } = require('../canvas/wallet-session-fixture.cjs');

const origin = 'http://localhost:5173';
const publicBaseUrl = 'https://assets.example.test/profile-images';

/** 사용자 모듈만 올린 실제 HTTP 서버. 저장소 설정 유무를 테스트마다 고른다. */
async function startServer(t, profileImage) {
  const database = await testDatabaseModule();
  class TestConfigModule {}
  Global()(TestConfigModule);
  Module({
    providers: [
      {
        provide: ConfigService,
        useValue: new ConfigService({
          app: {
            apiPrefix: 'api',
            nodeEnv: 'test',
            trustProxyHops: 0,
            version: 'test',
          },
          cors: {
            originList: [origin],
            credentials: true,
            methods: ['GET', 'PUT'],
            allowedHeaders: ['Content-Type'],
          },
          realtime: { maxConnections: 20 },
          ...(profileImage ? { profileImage } : {}),
        }),
      },
    ],
    exports: [ConfigService],
  })(TestConfigModule);
  class TestAppModule {}
  Module({ imports: [TestConfigModule, database.module, UserModule] })(
    TestAppModule,
  );
  const app = configureApp(
    await NestFactory.create(TestAppModule, { logger: false }),
  );
  app.useLogger(false);
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  return { pool: database.pool, url: await app.getUrl() };
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width = 1, height = 1) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg(width = 1, height = 1) {
  const frame = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0, 0, 0, 0, 0x01, 0x01, 0x11, 0x00,
  ]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from('JFIF\0', 'latin1'),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    frame,
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function put(url, body, options = {}) {
  const { type = 'image/png', cookie, requestOrigin = origin } = options;
  const headers = { 'Content-Type': type };
  if (requestOrigin) headers.Origin = requestOrigin;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${url}/api/users/me/profile-image`, {
    method: 'PUT',
    headers,
    body,
  });
  return { response, body: await response.json() };
}

/** 공개 주소에서 저장소 기준 경로만 떼어 같은 서버의 정적 경로로 읽는다. */
function localImageUrl(url, avatarUrl) {
  return `${url}/profile-images${avatarUrl.slice(publicBaseUrl.length)}`;
}

test('profile image upload HTTP contract', async (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'cameo-profile-images-'));
  t.after(() => rmSync(storageRoot, { recursive: true, force: true }));
  const { pool, url } = await startServer(t, { storageRoot, publicBaseUrl });
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const token = Buffer.alloc(32, 7).toString('base64url');
  await insertWalletSession(pool, userId, token);
  const cookie = `${authCookies('test').sessionName}=${token}`;
  const avatarPattern = new RegExp(
    `^${publicBaseUrl}/${userId}/[0-9a-f-]{36}\\.(png|jpg)$`,
  );

  await t.test(
    'rejects requests without a session or allowed origin',
    async () => {
      const anonymous = await put(url, png());
      assert.equal(anonymous.response.status, 401);
      assert.equal(anonymous.body.code, 'AUTH_SESSION_INVALID');
      const foreign = await put(url, png(), {
        cookie,
        requestOrigin: 'https://evil.example',
      });
      assert.equal(foreign.response.status, 403);
      assert.equal(foreign.body.code, 'AUTH_ORIGIN_NOT_ALLOWED');
    },
  );

  await t.test(
    'rejects files that are not the declared PNG or JPEG',
    async () => {
      for (const [body, type] of [
        [jpeg(), 'image/png'],
        [png(), 'image/jpeg'],
        [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
        [Buffer.from('hello'), 'text/plain'],
        [png(8193, 1), 'image/png'],
        [jpeg(1, 9000), 'image/jpeg'],
        [png(0, 1), 'image/png'],
        [Buffer.alloc(0), 'image/png'],
      ]) {
        const { response, body: result } = await put(url, body, {
          cookie,
          type,
        });
        assert.equal(response.status, 400, type);
        assert.equal(result.code, 'USER_PROFILE_IMAGE_INVALID');
      }
      const tooLarge = await put(url, Buffer.alloc(2 * 1024 * 1024 + 1), {
        cookie,
      });
      assert.equal(tooLarge.response.status, 413);
      assert.equal(tooLarge.body.code, 'PayloadTooLargeException');
      const row = await pool.query('SELECT avatar_url FROM users WHERE id=$1', [
        userId,
      ]);
      assert.equal(row.rows[0].avatar_url, null);
      assert.deepEqual(readdirSync(storageRoot), []);
    },
  );

  let firstUrl;
  await t.test(
    'stores a PNG, updates the session user and serves it',
    async () => {
      const image = png(1, 1);
      const { response, body } = await put(url, image, { cookie });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(body.data.id, userId);
      assert.match(body.data.avatarUrl, avatarPattern);
      firstUrl = body.data.avatarUrl;
      const me = await fetch(`${url}/api/auth/me`, {
        headers: { Cookie: cookie },
      });
      assert.equal((await me.json()).data.user.avatarUrl, firstUrl);
      const served = await fetch(localImageUrl(url, firstUrl));
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(
        served.headers.get('cross-origin-resource-policy'),
        'cross-origin',
      );
      assert.match(served.headers.get('cache-control'), /immutable/);
      assert.deepEqual(Buffer.from(await served.arrayBuffer()), image);
    },
  );

  await t.test('replacing the image removes the previous file', async () => {
    const { response, body } = await put(url, jpeg(640, 480), {
      cookie,
      type: 'image/jpeg',
    });
    assert.equal(response.status, 200);
    assert.match(body.data.avatarUrl, /\.jpg$/);
    assert.notEqual(body.data.avatarUrl, firstUrl);
    assert.equal((await fetch(localImageUrl(url, firstUrl))).status, 404);
    const served = await fetch(localImageUrl(url, body.data.avatarUrl));
    assert.equal(served.headers.get('content-type'), 'image/jpeg');
    const files = readdirSync(join(storageRoot, userId));
    assert.deepEqual(files, [body.data.avatarUrl.split('/').at(-1)]);
  });

  await t.test('public path exposes only stored image files', async () => {
    for (const path of [
      `/profile-images/${userId}`,
      `/profile-images/${userId}/.x.png.tmp`,
      `/profile-images/${userId}/../${userId}/a.png`,
      '/profile-images/not-a-uuid/a.png',
    ]) {
      assert.equal((await fetch(`${url}${path}`)).status, 404, path);
    }
    assert.equal(existsSync(join(storageRoot, userId)), true);
  });
});

test('profile image upload reports missing storage configuration', async (t) => {
  const { pool, url } = await startServer(t);
  const userId = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const token = Buffer.alloc(32, 9).toString('base64url');
  await insertWalletSession(pool, userId, token);
  const { response, body } = await put(url, png(), {
    cookie: `${authCookies('test').sessionName}=${token}`,
  });
  assert.equal(response.status, 503);
  assert.equal(body.code, 'USER_PROFILE_IMAGE_UNAVAILABLE');
  assert.equal(
    (await fetch(`${url}/profile-images/${userId}/${userId}.png`)).status,
    404,
  );
});
