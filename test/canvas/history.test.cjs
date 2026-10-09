const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID, createHash } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { startServer } = require('./server-fixture.cjs');

/** 실제 HTTP와 임시 PostgreSQL로 커서 경계·공개 범위·응답 계약을 함께 검증한다. */
test('canvas history HTTP contract', async (t) => {
  const { app, pool, url } = await startServer(t);
  app
    .get(ConfigService)
    .set('canvasSnapshot.publicBaseUrl', 'https://assets.example.test');
  const main = (await pool.query("SELECT id FROM canvases WHERE type='main'"))
    .rows[0].id;
  const creator = (
    await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
  ).rows[0].id;
  const season = randomUUID();
  await pool.query(
    `INSERT INTO canvases (id,type,width,height,stroke_limit_per_user,starts_at,ends_at)
    VALUES ($1,'season',1000,1000,3,NOW(),NOW()+interval '1 day')`,
    [season],
  );
  await pool.query(
    `INSERT INTO seasons (canvas_id,creator_id,title,capacity) VALUES ($1,$2,'History test',10)`,
    [season, creator],
  );
  const token = Buffer.alloc(32, 1).toString('base64url');
  await pool.query(
    'INSERT INTO auth_sessions (user_id,token_hash) VALUES ($1,$2)',
    [creator, createHash('sha256').update(token).digest('hex')],
  );
  const {
    authCookies,
  } = require('../../dist/modules/auth/resources/auth-cookie/auth-http');
  const cookie = `${authCookies('test').sessionName}=${token}`;
  async function snapshot(
    canvasId,
    id,
    sequence,
    capturedAt,
    status = 'READY',
  ) {
    const scope = canvasId === main ? 'main' : 'seasons';
    const key = `snapshots/${scope}/${canvasId}/${id}`;
    await pool.query(
      `INSERT INTO canvas_snapshots
      (id,canvas_id,through_sequence,renderer_version,width,height,status,image_key,continuation_key,image_bytes,continuation_bytes,image_sha256,continuation_sha256,continuation_schema_version,captured_at)
      VALUES ($1,$2,$3,'v1',1000,1000,$4,$5,$6,1,1,$7,$7,1,$8)`,
      [
        id,
        canvasId,
        sequence,
        status,
        `${key}/image.png`,
        `${key}/continuation.json`,
        '0'.repeat(64),
        capturedAt,
      ],
    );
  }
  async function get(id, query = '', headers = {}) {
    const response = await fetch(`${url}/api/canvases/${id}/history${query}`, {
      headers,
    });
    return { response, body: await response.json() };
  }
  await t.test(
    'existing canvas without snapshots returns an empty page',
    async () => {
      const { response, body } = await get(main);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(body, {
        statusCode: 200,
        success: true,
        data: { items: [], nextCursor: null, hasNext: false },
      });
    },
  );
  // 같은 밀리초 안의 DB 시각 차이와 동일 시각의 ID 정렬을 페이지 경계에서 검증한다.
  const ids = [
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
  ];
  await snapshot(main, ids[0], 3, '2026-10-09T00:00:00.123456Z');
  await snapshot(main, ids[1], 2, '2026-10-09T00:00:00.123456Z');
  await snapshot(main, ids[2], 1, '2026-10-09T00:00:00.123455Z');
  await snapshot(main, randomUUID(), 4, '2026-10-10T00:00:00Z', 'INVALID');
  let firstCursor;
  await t.test(
    'READY only, stable timestamp/id cursor and new inserts',
    async () => {
      const first = await get(main, '?limit=1');
      assert.equal(first.response.status, 200);
      assert.equal(first.body.data.items[0].id, ids[0]);
      assert.equal(first.body.data.hasNext, true);
      assert.deepEqual(
        Object.keys(first.body.data.items[0]).sort(),
        ['id', 'imageUrl', 'width', 'height', 'capturedAt', 'isFinal'].sort(),
      );
      assert.match(
        first.body.data.items[0].imageUrl,
        /^https:\/\/assets\.example\.test\/snapshots\/main\//,
      );
      firstCursor = first.body.data.nextCursor;
      await snapshot(main, randomUUID(), 5, '2026-10-11T00:00:00Z');
      const second = await get(main, `?limit=1&cursor=${firstCursor}`);
      assert.equal(second.body.data.items[0].id, ids[1]);
      assert.equal(second.body.data.hasNext, true);
      const third = await get(
        main,
        `?limit=1&cursor=${second.body.data.nextCursor}`,
      );
      assert.equal(third.body.data.items[0].id, ids[2]);
      assert.equal(third.body.data.hasNext, false);
      assert.equal(third.body.data.nextCursor, null);
    },
  );
  await t.test('bad requests and missing canvases', async () => {
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=1.5',
      '?limit=1e1',
      '?limit=',
      '?limit=1&limit=2',
      '?cursor=',
      '?cursor=abc',
      '?cursor=' + 'a'.repeat(2049),
    ]) {
      const { response, body } = await get(main, query);
      assert.equal(response.status, 400, query);
      assert.equal(body.code, 'BadRequestException');
    }
    const badYear = Buffer.from(
      JSON.stringify({
        v: 1,
        canvasId: main,
        capturedAt: '0000-01-01T00:00:00.000000Z',
        id: ids[0],
      }),
    ).toString('base64url');
    assert.equal((await get(main, `?cursor=${badYear}`)).response.status, 400);
    assert.equal((await get('bad-id')).response.status, 400);
    assert.equal(
      (await get(season, `?cursor=${firstCursor}`)).response.status,
      400,
    );
    const missing = await get(randomUUID());
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.code, 'CANVAS_NOT_FOUND');
  });
  await t.test(
    'season snapshots, optional cookies and cancelled creator visibility',
    async () => {
      const id = randomUUID();
      await snapshot(season, id, 1, '2026-10-09T00:00:00Z');
      await pool.query(
        'UPDATE canvas_snapshots SET is_final=true WHERE id=$1',
        [id],
      );
      assert.equal(
        (await get(season, '', { cookie: 'cameo_session=invalid' })).body.data
          .items[0].isFinal,
        true,
      );
      await pool.query(
        'UPDATE seasons SET cancelled_at=NOW() WHERE canvas_id=$1',
        [season],
      );
      assert.equal((await get(season)).response.status, 404);
      assert.equal(
        (
          await get(season, '', {
            cookie: `${authCookies('test').sessionName}=invalid`,
          })
        ).response.status,
        404,
      );
      const outsider = (
        await pool.query('INSERT INTO users DEFAULT VALUES RETURNING id')
      ).rows[0].id;
      const outsiderToken = Buffer.alloc(32, 2).toString('base64url');
      await pool.query(
        'INSERT INTO auth_sessions (user_id,token_hash) VALUES ($1,$2)',
        [outsider, createHash('sha256').update(outsiderToken).digest('hex')],
      );
      assert.equal(
        (
          await get(season, '', {
            cookie: `${authCookies('test').sessionName}=${outsiderToken}`,
          })
        ).response.status,
        404,
      );
      const owner = await get(season, '', { cookie });
      assert.equal(owner.response.status, 200);
      assert.equal(owner.body.data.items[0].id, id);
    },
  );
  await t.test('OpenAPI exposes history contract', async () => {
    const doc = await (await fetch(`${url}/docs-json`)).json();
    const endpoint = doc.paths['/api/canvases/{canvasId}/history'].get;
    assert.ok(endpoint.responses['200']);
    assert.ok(endpoint.responses['404']);
    assert.equal(
      endpoint.parameters.find((p) => p.name === 'limit').schema.maximum,
      100,
    );
  });
});
