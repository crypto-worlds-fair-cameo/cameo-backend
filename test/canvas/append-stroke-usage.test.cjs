const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { test } = require('node:test');
const { startServer, createClient, connect } = require('./server-fixture.cjs');

/** 사용자별 세션을 실제 DB에 생성해 서로 다른 탭의 동일 계정을 재현한다. */
async function member(t, server) {
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await server.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await server.pool.query(
    'INSERT INTO auth_sessions (user_id, token_hash) VALUES ($1, $2)',
    [userId, createHash('sha256').update(token).digest('hex')],
  );
  const socket = await tab(t, server, token);
  return { socket, userId, token };
}

async function tab(t, server, token) {
  const socket = createClient(t, server.url, {
    extraHeaders: {
      Origin: 'http://localhost:5173',
      Cookie: `cameo_session=${token}`,
    },
  });
  await connect(socket);
  return socket;
}

function input(overrides = {}) {
  return {
    clientStrokeId: randomUUID(),
    chunkIndex: 0,
    isFinal: false,
    brush: {
      type: 'round',
      size: 12,
      color: '#ED4242',
      opacity: 1,
      version: 1,
    },
    points: [{ x: 100, y: 200 }],
    ...overrides,
  };
}
const append = (socket, data) =>
  socket.timeout(2000).emitWithAck('stroke:append', data);
async function usages(server, userId) {
  const { rows } = await server.pool.query(
    `SELECT u.* FROM canvas_stroke_usages u JOIN canvases c ON c.id=u.canvas_id
     WHERE c.type='main' AND u.user_id=$1`,
    [userId],
  );
  return rows;
}

test('first append consumes one stroke, retries and middle chunks do not consume again, final marks completion', async (t) => {
  const server = await startServer(t);
  const { socket, userId } = await member(t, server);
  const stroke = input();
  assert.equal((await append(socket, stroke)).ok, true);
  const first = await usages(server, userId);
  assert.equal(first.length, 1);
  assert.equal(first[0].client_stroke_id, stroke.clientStrokeId);
  assert.equal(first[0].completed_at, null);
  assert.equal((await append(socket, stroke)).data.accepted, false);
  assert.equal((await append(socket, { ...stroke, chunkIndex: 1 })).ok, true);
  const final = { ...stroke, chunkIndex: 2, points: [], isFinal: true };
  assert.equal((await append(socket, final)).ok, true);
  const completed = await usages(server, userId);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].used_at.getTime(), first[0].used_at.getTime());
  assert.ok(completed[0].completed_at >= completed[0].used_at);
  assert.equal((await append(socket, final)).data.accepted, false);
  assert.deepEqual(await usages(server, userId), completed);
  assert.equal(
    (await append(socket, input())).error.code,
    'STROKE_LIMIT_REACHED',
  );
});

test('disconnect preserves consumption and allows only the same unfinished stroke to resume', async (t) => {
  const server = await startServer(t);
  const { socket, userId, token } = await member(t, server);
  const stroke = input();
  assert.equal((await append(socket, stroke)).ok, true);
  socket.disconnect();
  const reconnected = await tab(t, server, token);
  assert.equal(
    (await append(reconnected, input())).error.code,
    'STROKE_LIMIT_REACHED',
  );
  assert.equal(
    (await append(reconnected, { ...stroke, chunkIndex: 1 })).ok,
    true,
  );
  const records = await usages(server, userId);
  assert.equal(records.length, 1);
  assert.equal(records[0].completed_at, null);
});

test('two tabs starting different strokes can consume only one main stroke', async (t) => {
  const server = await startServer(t);
  const { socket, userId, token } = await member(t, server);
  const other = await tab(t, server, token);
  const results = await Promise.all([
    append(socket, input()),
    append(other, input()),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.find((result) => !result.ok).error.code,
    'STROKE_LIMIT_REACHED',
  );
  assert.equal((await usages(server, userId)).length, 1);
  const page = await socket
    .timeout(2000)
    .emitWithAck('canvas:sync', { afterSequence: '0' });
  assert.equal(page.data.previews.length, 1);
});

test('invalid first chunks do not consume a stroke', async (t) => {
  const server = await startServer(t);
  const { socket, userId } = await member(t, server);
  for (const stroke of [
    input({ chunkIndex: 1 }),
    input({ isFinal: true, points: [] }),
    input({ points: [{ x: -1, y: 1 }] }),
  ])
    assert.equal((await append(socket, stroke)).error.code, 'INVALID_STROKE');
  assert.equal((await usages(server, userId)).length, 0);
  assert.equal((await append(socket, input({ isFinal: true }))).ok, true);
});

test('restart preserves quota and recognizes the saved last chunk', async (t) => {
  const first = await startServer(t);
  const { socket, userId, token } = await member(t, first);
  const stroke = input();
  assert.equal((await append(socket, stroke)).ok, true);
  await first.app.close();
  const second = await startServer(t);
  const reconnect = await tab(t, second, token);
  assert.equal(
    (await append(reconnect, input())).error.code,
    'STROKE_LIMIT_REACHED',
  );
  assert.equal((await append(reconnect, stroke)).data.accepted, false);
  assert.equal((await usages(second, userId)).length, 1);
});

test('a failed database commit leaves no preview or usage and releases the pending chunk for retry', async (t) => {
  const server = await startServer(t);
  const { socket, userId } = await member(t, server);
  const stroke = input();
  // 지연 제약으로 INSERT 이후의 COMMIT 실패를 재현해 좌표 공개 전에 롤백되는지 확인한다.
  await server.pool.query(`
    CREATE FUNCTION reject_usage_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Test commit failure'; END; $$;
    CREATE CONSTRAINT TRIGGER reject_usage_commit
    AFTER INSERT ON canvas_stroke_usages DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.user_id='${userId}'::uuid) EXECUTE FUNCTION reject_usage_commit();
  `);
  t.after(() =>
    server.pool.query(
      'DROP TRIGGER IF EXISTS reject_usage_commit ON canvas_stroke_usages; DROP FUNCTION IF EXISTS reject_usage_commit();',
    ),
  );
  assert.equal(
    (await append(socket, stroke)).error.code,
    'REALTIME_UNAVAILABLE',
  );
  assert.equal((await usages(server, userId)).length, 0);
  const empty = await socket
    .timeout(2000)
    .emitWithAck('canvas:sync', { afterSequence: '0' });
  assert.deepEqual(empty.data.previews, []);
  await server.pool.query(
    'DROP TRIGGER reject_usage_commit ON canvas_stroke_usages; DROP FUNCTION reject_usage_commit();',
  );
  assert.equal((await append(socket, stroke)).ok, true);
  assert.equal((await usages(server, userId)).length, 1);
});

test('a failed final commit preserves the unfinished stroke for continuation and retry', async (t) => {
  const server = await startServer(t);
  const { socket, userId } = await member(t, server);
  const stroke = input();
  assert.equal((await append(socket, stroke)).ok, true);
  await server.pool.query(`
    CREATE FUNCTION reject_final_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Test final commit failure'; END; $$;
    CREATE CONSTRAINT TRIGGER reject_final_commit
    AFTER UPDATE ON canvas_stroke_usages DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.user_id='${userId}'::uuid) EXECUTE FUNCTION reject_final_commit();
  `);
  t.after(() =>
    server.pool.query(
      'DROP TRIGGER IF EXISTS reject_final_commit ON canvas_stroke_usages; DROP FUNCTION IF EXISTS reject_final_commit();',
    ),
  );
  assert.equal(
    (await append(socket, { ...stroke, chunkIndex: 1, isFinal: true })).error
      .code,
    'REALTIME_UNAVAILABLE',
  );
  assert.equal((await usages(server, userId))[0].completed_at, null);
  const page = await socket
    .timeout(2000)
    .emitWithAck('canvas:sync', { afterSequence: '0' });
  assert.equal(page.data.previews.length, 1);
  assert.equal((await append(socket, { ...stroke, chunkIndex: 1 })).ok, true);
  await server.pool.query(
    'DROP TRIGGER reject_final_commit ON canvas_stroke_usages; DROP FUNCTION reject_final_commit();',
  );
  assert.equal(
    (await append(socket, { ...stroke, chunkIndex: 2, isFinal: true })).ok,
    true,
  );
  assert.ok((await usages(server, userId))[0].completed_at instanceof Date);
});
