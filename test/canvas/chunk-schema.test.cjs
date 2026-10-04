const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { testDatabaseModule } = require('./database-fixture.cjs');
const {
  CanvasChunkRepository,
} = require('../../dist/modules/canvas/resources/canvas-drawing/canvas-chunk.repository');
const {
  createTransactionContext,
  closeTransactionContext,
} = require('../../dist/database/transaction/pg-transaction-scope');

const brush = {
  type: 'round',
  size: 12,
  color: '#ED4242',
  opacity: 1,
  version: 1,
};
const points = [{ x: 10, y: 20 }];

/** 실제 FK와 CHECK를 통과하는 캔버스·사용 기록을 만든다. */
async function fixture() {
  const { pool } = await testDatabaseModule();
  const userId = randomUUID();
  const canvasId = randomUUID();
  const usageId = randomUUID();
  const clientStrokeId = randomUUID();
  await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await pool.query(
    `INSERT INTO canvases
       (id, type, width, height, stroke_limit_per_user, starts_at, ends_at)
     VALUES ($1, 'season', 10000, 10000, 10, '2026-10-01', '2026-11-01')`,
    [canvasId],
  );
  await pool.query(
    `INSERT INTO canvas_stroke_usages
       (id, canvas_id, user_id, client_stroke_id)
     VALUES ($1, $2, $3, $4)`,
    [usageId, canvasId, userId, clientStrokeId],
  );
  return { pool, canvasId, usageId, userId, clientStrokeId };
}

/** 실제 트랜잭션 경계에서 repository 저장과 롤백을 검증한다. */
async function transaction(pool, operation) {
  const client = await pool.connect();
  const context = createTransactionContext(client);
  try {
    await client.query('BEGIN');
    const value = await operation(context);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    closeTransactionContext(context);
    client.release();
  }
}

/** 테스트용 청크를 추가하고 DB 제약 위반을 직접 확인한다. */
async function insertChunk({ pool, canvasId, usageId }, overrides = {}) {
  return pool.query(
    `INSERT INTO canvas_stroke_chunks
       (canvas_id, stroke_usage_id, sequence, chunk_index, brush, points, is_final)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING *`,
    [
      overrides.canvasId ?? canvasId,
      overrides.usageId ?? usageId,
      overrides.sequence ?? 1,
      overrides.chunkIndex ?? 0,
      JSON.stringify(overrides.brush ?? brush),
      JSON.stringify(overrides.points ?? points),
      overrides.isFinal ?? false,
    ],
  );
}

test('chunk schema keeps canvas sequence and stroke chunk indexes unique', async () => {
  const f = await fixture();
  await insertChunk(f);
  await assert.rejects(insertChunk(f), { code: '23505' });
  await assert.rejects(insertChunk(f, { chunkIndex: 1 }), { code: '23505' });
  await assert.rejects(insertChunk(f, { sequence: 2 }), { code: '23505' });
});

test('chunk schema rejects a usage from another canvas and malformed payloads', async () => {
  const f = await fixture();
  const other = await fixture();
  await assert.rejects(insertChunk(f, { usageId: other.usageId }), {
    code: '23503',
  });
  for (const invalid of [
    { sequence: 0 },
    { chunkIndex: 1_000_001 },
    { brush: { ...brush, size: 201 } },
    { brush: { size: 12, color: '#ED4242', opacity: 1, version: 1 } },
    { brush: { type: 'round', size: 12, opacity: 1, version: 1 } },
    { points: {} },
    { points: Array.from({ length: 129 }, () => ({ x: 1, y: 1 })) },
  ]) {
    await assert.rejects(insertChunk(f, invalid), { code: '23514' });
  }
});

test('migration reruns preserve chunks, heads, and row level security', async () => {
  const f = await fixture();
  const inserted = await insertChunk(f);
  await f.pool.query('UPDATE canvases SET last_chunk_sequence=1 WHERE id=$1', [
    f.canvasId,
  ]);
  await f.pool.query(
    readFileSync(
      resolve(
        __dirname,
        '../../db/migrations/2026-10-04-01-canvas-stroke-chunks.sql',
      ),
      'utf8',
    ),
  );
  const saved = await f.pool.query(
    'SELECT * FROM canvas_stroke_chunks WHERE canvas_id=$1 AND sequence=1',
    [f.canvasId],
  );
  assert.deepEqual(saved.rows, inserted.rows);
  const canvas = await f.pool.query(
    'SELECT last_sequence, last_chunk_sequence FROM canvases WHERE id=$1',
    [f.canvasId],
  );
  assert.deepEqual(canvas.rows, [
    { last_sequence: '0', last_chunk_sequence: '1' },
  ]);
  const security = await f.pool.query(
    "SELECT relrowsecurity FROM pg_class WHERE oid='public.canvas_stroke_chunks'::regclass",
  );
  assert.equal(security.rows[0].relrowsecurity, true);
});

test('repository saves a contiguous batch and reconstructs sync previews', async () => {
  const f = await fixture();
  const repository = new CanvasChunkRepository(f.pool);
  const epoch = randomUUID();
  const chunks = [
    {
      usageId: f.usageId,
      preview: {
        canvasKey: 'main',
        userId: f.userId,
        epoch,
        sequence: '1',
        clientStrokeId: f.clientStrokeId,
        brush,
        points,
        chunkIndex: 0,
        isFinal: false,
      },
    },
    {
      usageId: f.usageId,
      preview: {
        canvasKey: 'main',
        userId: f.userId,
        epoch,
        sequence: '2',
        clientStrokeId: f.clientStrokeId,
        brush,
        points: [{ x: 11, y: 21 }],
        chunkIndex: 1,
        isFinal: true,
      },
    },
  ];
  await transaction(f.pool, (context) =>
    repository.save(f.canvasId, chunks, '0', context),
  );
  const page = await repository.page(f.canvasId, '0', '2', 10, epoch);
  assert.deepEqual(
    page,
    chunks.map((chunk) => chunk.preview),
  );
  assert.deepEqual(
    await repository.latest(f.canvasId, f.userId, f.clientStrokeId, epoch),
    chunks[1],
  );
  const head = await f.pool.query(
    'SELECT last_chunk_sequence FROM canvases WHERE id=$1',
    [f.canvasId],
  );
  assert.equal(head.rows[0].last_chunk_sequence, '2');
});

test('repository accepts an identical commit retry and rejects changed content', async () => {
  const f = await fixture();
  const repository = new CanvasChunkRepository(f.pool);
  const chunk = {
    usageId: f.usageId,
    preview: {
      canvasKey: 'main',
      userId: f.userId,
      epoch: randomUUID(),
      sequence: '1',
      clientStrokeId: f.clientStrokeId,
      brush,
      points,
      chunkIndex: 0,
      isFinal: true,
    },
  };
  await transaction(f.pool, (context) =>
    repository.save(f.canvasId, [chunk], '0', context),
  );
  await transaction(f.pool, (context) =>
    repository.save(f.canvasId, [chunk], '0', context),
  );
  const changed = {
    ...chunk,
    preview: { ...chunk.preview, points: [{ x: 999, y: 999 }] },
  };
  await assert.rejects(
    transaction(f.pool, (context) =>
      repository.save(f.canvasId, [changed], '0', context),
    ),
    /conflict with retry payload/,
  );
  const saved = await f.pool.query(
    'SELECT points FROM canvas_stroke_chunks WHERE canvas_id=$1',
    [f.canvasId],
  );
  assert.deepEqual(saved.rows, [{ points }]);
});
