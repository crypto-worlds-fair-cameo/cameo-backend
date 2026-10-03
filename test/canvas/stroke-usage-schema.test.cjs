const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { testDatabaseModule } = require('./database-fixture.cjs');

/** 임시 DB에 사용자와 시즌을 만들어 캔버스별 획 사용 기록을 검증한다. */
async function fixture() {
  const { pool } = await testDatabaseModule();
  const userId = randomUUID();
  const canvasId = randomUUID();
  await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 10000, 10000, 10, '2026-10-01', '2026-11-01')`,
    [canvasId],
  );
  return { pool, userId, canvasId, strokeId: randomUUID() };
}

/** 종료되지 않은 획도 사용 기록을 남기며, 완료 표시는 나중에 갱신한다. */
async function useStroke({ pool, canvasId, userId, strokeId }) {
  return pool.query(
    `INSERT INTO canvas_stroke_usages (canvas_id, user_id, client_stroke_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [canvasId, userId, strokeId],
  );
}

test('unfinished strokes remain counted after the database client disconnects', async () => {
  const f = await fixture();
  const table = await f.pool.query(
    "SELECT to_regclass('public.canvas_stroke_usages') AS name",
  );
  assert.equal(table.rows[0].name, 'canvas_stroke_usages');
  const client = await f.pool.connect();
  try {
    await client.query(
      `INSERT INTO canvas_stroke_usages (canvas_id, user_id, client_stroke_id)
       VALUES ($1, $2, $3)`,
      [f.canvasId, f.userId, f.strokeId],
    );
  } finally {
    client.release(true);
  }
  const { rows } = await f.pool.query(
    `SELECT count(*)::integer AS used, count(completed_at)::integer AS completed
     FROM canvas_stroke_usages WHERE canvas_id=$1 AND user_id=$2`,
    [f.canvasId, f.userId],
  );
  assert.deepEqual(rows, [{ used: 1, completed: 0 }]);
});

test('retries cannot create a second use of the same user canvas stroke', async () => {
  const f = await fixture();
  await useStroke(f);
  await assert.rejects(useStroke(f), { code: '23505' });
  await useStroke({ ...f, strokeId: randomUUID() });
  const other = await fixture();
  await useStroke({ ...f, canvasId: other.canvasId });
  await useStroke({ ...f, userId: other.userId });
  const { rows } = await f.pool.query(
    'SELECT count(*)::integer AS used FROM canvas_stroke_usages WHERE canvas_id=$1 AND user_id=$2',
    [f.canvasId, f.userId],
  );
  assert.equal(rows[0].used, 2);
});

test('uses require existing users and canvases and survive parent deletion attempts', async () => {
  const f = await fixture();
  await assert.rejects(useStroke({ ...f, userId: randomUUID() }), {
    code: '23503',
  });
  await assert.rejects(useStroke({ ...f, canvasId: randomUUID() }), {
    code: '23503',
  });
  await useStroke(f);
  await assert.rejects(
    f.pool.query('DELETE FROM users WHERE id=$1', [f.userId]),
    {
      code: '23503',
    },
  );
  await assert.rejects(
    f.pool.query('DELETE FROM canvases WHERE id=$1', [f.canvasId]),
    { code: '23503' },
  );
});

test('completion must be finite and cannot precede consumption', async () => {
  const f = await fixture();
  const { rows } = await useStroke(f);
  const id = rows[0].id;
  assert.ok(rows[0].used_at instanceof Date);
  assert.equal(rows[0].completed_at, null);
  for (const expression of [
    "used_at - interval '1 second'",
    "'infinity'::timestamptz",
  ]) {
    await assert.rejects(
      f.pool.query(
        `UPDATE canvas_stroke_usages SET completed_at=${expression} WHERE id=$1`,
        [id],
      ),
      { code: '23514' },
    );
  }
  await assert.rejects(
    f.pool.query(
      "UPDATE canvas_stroke_usages SET used_at='-infinity' WHERE id=$1",
      [id],
    ),
    { code: '23514' },
  );
  await f.pool.query(
    'UPDATE canvas_stroke_usages SET completed_at=used_at WHERE id=$1',
    [id],
  );
  const completed = await f.pool.query(
    'SELECT completed_at FROM canvas_stroke_usages WHERE id=$1',
    [id],
  );
  assert.equal(
    completed.rows[0].completed_at.getTime(),
    rows[0].used_at.getTime(),
  );
});

test('migration reruns preserve unfinished uses and enable row level security', async () => {
  const f = await fixture();
  const { rows } = await useStroke(f);
  await f.pool.query(
    readFileSync(
      resolve(
        __dirname,
        '../../db/migrations/2026-10-03-01-canvas-stroke-usages.sql',
      ),
      'utf8',
    ),
  );
  const saved = await f.pool.query(
    'SELECT * FROM canvas_stroke_usages WHERE id=$1',
    [rows[0].id],
  );
  assert.deepEqual(saved.rows, rows);
  const security = await f.pool.query(
    "SELECT relrowsecurity FROM pg_class WHERE oid='public.canvas_stroke_usages'::regclass",
  );
  assert.equal(security.rows[0].relrowsecurity, true);
});
