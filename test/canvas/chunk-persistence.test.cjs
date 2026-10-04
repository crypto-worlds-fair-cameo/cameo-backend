const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer, createClient, connect } = require('./server-fixture.cjs');

const brush = {
  type: 'round',
  size: 12,
  color: '#ED4242',
  opacity: 1,
  version: 1,
};
function input(overrides = {}) {
  return {
    clientStrokeId: randomUUID(),
    chunkIndex: 0,
    brush,
    points: [{ x: 10, y: 20 }],
    isFinal: false,
    ...overrides,
  };
}
async function member(t, server, identity) {
  const userId = identity?.userId ?? randomUUID();
  const token = identity?.token ?? randomBytes(32).toString('base64url');
  if (!identity) {
    await server.pool.query('INSERT INTO users(id) VALUES($1)', [userId]);
    await server.pool.query(
      'INSERT INTO auth_sessions(user_id,token_hash) VALUES($1,$2)',
      [userId, createHash('sha256').update(token).digest('hex')],
    );
  }
  const socket = createClient(t, server.url, {
    extraHeaders: {
      Origin: 'http://localhost:5173',
      Cookie: `cameo_session=${token}`,
    },
  });
  await connect(socket);
  return { socket, userId, token };
}
const append = (socket, data) =>
  socket.timeout(3000).emitWithAck('stroke:append', data);
const sync = (socket, data = { afterSequence: '0' }) =>
  socket.timeout(3000).emitWithAck('canvas:sync', data);
async function count(server) {
  const table = await server.pool.query(
    "SELECT to_regclass('canvas_stroke_chunks') AS name",
  );
  if (!table.rows[0].name) return 0;
  return Number(
    (await server.pool.query('SELECT count(*) AS n FROM canvas_stroke_chunks'))
      .rows[0].n,
  );
}
async function waitForStored(server, expected) {
  const end = Date.now() + 3500;
  while (Date.now() < end && (await count(server)) !== expected)
    await delay(40);
  assert.equal(await count(server), expected);
}

test('final ACK guarantees saved coordinates and completion; restart replays their order', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const a = await append(owner.socket, stroke);
  const b = await append(owner.socket, {
    ...stroke,
    chunkIndex: 1,
    isFinal: true,
    points: [],
  });
  assert.equal(b.ok, true);
  assert.equal(await count(server), 2);
  const usage = await server.pool.query(
    'SELECT completed_at FROM canvas_stroke_usages WHERE user_id=$1',
    [owner.userId],
  );
  assert.ok(usage.rows[0].completed_at);
  await server.app.close();
  const restarted = await startServer(t);
  const resumed = await member(t, restarted, owner);
  const page = await sync(resumed.socket, {
    epoch: a.data.preview.epoch,
    afterSequence: '2',
  });
  assert.equal(page.data.reset, true);
  assert.deepEqual(
    page.data.previews.map((p) => [p.sequence, p.chunkIndex, p.isFinal]),
    [
      ['1', 0, false],
      ['2', 1, true],
    ],
  );
  const duplicate = await append(resumed.socket, {
    ...stroke,
    chunkIndex: 1,
    isFinal: true,
    points: [],
  });
  assert.equal(duplicate.data.accepted, false);
  assert.equal(await count(restarted), 2);
});

test('unfinished disconnected strokes are saved by the timer and can resume after restart', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  assert.equal((await append(owner.socket, stroke)).ok, true);
  owner.socket.disconnect();
  await waitForStored(server, 1);
  await server.app.close();
  const restarted = await startServer(t);
  const resumed = await member(t, restarted, owner);
  const next = await append(resumed.socket, {
    ...stroke,
    chunkIndex: 1,
    isFinal: true,
  });
  assert.equal(next.ok, true);
  assert.equal(next.data.preview.sequence, '2');
  assert.equal(await count(restarted), 2);
});

test('normal shutdown flushes an unfinished stroke without completing or refunding it', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  await append(owner.socket, input());
  await server.app.close();
  assert.equal(await count(server), 1);
  const usage = await server.pool.query(
    'SELECT completed_at FROM canvas_stroke_usages WHERE user_id=$1',
    [owner.userId],
  );
  assert.equal(usage.rows.length, 1);
  assert.equal(usage.rows[0].completed_at, null);
});

test('production DB lifecycle keeps its pool open until canvas shutdown flush completes', async (t) => {
  const server = await startServer(t, 20, true);
  const owner = await member(t, server);
  await append(owner.socket, input());
  await server.app.close();
  const { testDatabaseModule } = require('./database-fixture.cjs');
  const database = await testDatabaseModule();
  assert.equal(
    Number(
      (
        await database.pool.query(
          'SELECT count(*) AS n FROM canvas_stroke_chunks',
        )
      ).rows[0].n,
    ),
    1,
  );
  const record = await database.pool.query(
    'SELECT completed_at FROM canvas_stroke_usages WHERE user_id=$1',
    [owner.userId],
  );
  assert.equal(record.rows[0].completed_at, null);
});

test('DB prefix plus unflushed tail respects the fixed sync head across flushes', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  for (let chunkIndex = 0; chunkIndex < 3; chunkIndex++)
    assert.equal(
      (await append(owner.socket, { ...stroke, chunkIndex })).ok,
      true,
    );
  await waitForStored(server, 3);
  assert.equal(
    (await append(owner.socket, { ...stroke, chunkIndex: 3 })).ok,
    true,
  );
  const first = (await sync(owner.socket, { afterSequence: '0', limit: 2 }))
    .data;
  assert.deepEqual(
    first.previews.map((p) => p.sequence),
    ['1', '2'],
  );
  assert.equal(first.headSequence, '4');
  await waitForStored(server, 4);
  await append(owner.socket, { ...stroke, chunkIndex: 4 });
  const next = (
    await sync(owner.socket, {
      epoch: first.epoch,
      afterSequence: first.nextSequence,
      throughSequence: first.headSequence,
      limit: 2,
    })
  ).data;
  assert.deepEqual(
    next.previews.map((p) => p.sequence),
    ['3', '4'],
  );
  assert.equal(next.hasMore, false);
});

/** 소켓 제한을 우회한 직접 호출도 실제 인증·순서·저장 use case를 통과한다. */
function internals(server) {
  const {
    CanvasDrawing,
  } = require('../../dist/modules/canvas/resources/canvas-drawing/canvas-drawing');
  const {
    AppendStrokeUseCase,
  } = require('../../dist/modules/canvas/features/append-stroke/append-stroke.use-case');
  const {
    parseAppend,
  } = require('../../dist/modules/canvas/resources/canvas-stroke/canvas-stroke');
  return {
    drawing: server.app.get(CanvasDrawing),
    append: (owner, data) =>
      server.app
        .get(AppendStrokeUseCase)
        .execute(owner.socket.id, owner.token, parseAppend(data)),
  };
}

test('one long stroke exceeds 20000 chunks while saved history remains recoverable after cache eviction', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const backend = internals(server);
  for (let chunkIndex = 0; chunkIndex < 20010; chunkIndex++) {
    const result = await backend.append(owner, { ...stroke, chunkIndex });
    assert.equal(result.preview.sequence, String(chunkIndex + 1));
    if (chunkIndex % 256 === 255) await backend.drawing.flush();
  }
  await backend.append(owner, {
    ...stroke,
    chunkIndex: 20010,
    isFinal: true,
    points: [],
  });
  assert.equal(await count(server), 20011);
  const page = (await sync(owner.socket, { afterSequence: '0', limit: 100 }))
    .data;
  assert.deepEqual(
    page.previews.map((p) => p.sequence),
    Array.from({ length: 100 }, (_, i) => String(i + 1)),
  );
  const other = await member(t, server);
  assert.equal((await append(other.socket, input({ isFinal: true }))).ok, true);
  assert.equal(await count(server), 20012);
});

test('failed flush retains a bounded queue, rejects an uncharged new stroke, then recovers', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const other = await member(t, server);
  const stroke = input();
  const backend = internals(server);
  await server.pool
    .query(`CREATE FUNCTION reject_chunk_flush() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test chunk failure'; END; $$;
    CREATE CONSTRAINT TRIGGER reject_chunk_flush AFTER INSERT ON canvas_stroke_chunks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_chunk_flush();`);
  t.after(() =>
    server.pool.query(
      'DROP TRIGGER IF EXISTS reject_chunk_flush ON canvas_stroke_chunks; DROP FUNCTION IF EXISTS reject_chunk_flush();',
    ),
  );
  for (let chunkIndex = 0; chunkIndex < 4096; chunkIndex++)
    await backend.append(owner, { ...stroke, chunkIndex });
  await assert.rejects(backend.drawing.flush(), /Test chunk failure/);
  assert.equal(await count(server), 0);
  assert.equal(
    (await append(other.socket, input())).error.code,
    'CANVAS_CAPACITY_REACHED',
  );
  const used = await server.pool.query(
    'SELECT count(*) AS n FROM canvas_stroke_usages WHERE user_id=$1',
    [other.userId],
  );
  assert.equal(used.rows[0].n, '0');
  const page = (await sync(owner.socket, { afterSequence: '0', limit: 100 }))
    .data;
  assert.equal(page.headSequence, '4096');
  assert.equal(page.previews.length, 100);
  await server.pool.query(
    'DROP TRIGGER reject_chunk_flush ON canvas_stroke_chunks; DROP FUNCTION reject_chunk_flush();',
  );
  await backend.drawing.flush();
  assert.equal(await count(server), 4096);
  assert.equal((await append(other.socket, input({ isFinal: true }))).ok, true);
});

test('a sync spanning an evicted DB prefix and tail stays contiguous while flush runs', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const backend = internals(server);
  for (let chunkIndex = 0; chunkIndex < 20; chunkIndex++)
    await backend.append(owner, { ...stroke, chunkIndex });
  await backend.drawing.flush();
  for (let chunkIndex = 20; chunkIndex < 4116; chunkIndex++)
    await backend.append(owner, { ...stroke, chunkIndex });
  const [page] = await Promise.all([
    backend.drawing.page({ afterSequence: '0', limit: 100 }),
    backend.drawing.flush(),
  ]);
  assert.equal(page.headSequence, '4116');
  assert.deepEqual(
    page.previews.map((p) => p.sequence),
    Array.from({ length: 100 }, (_, i) => String(i + 1)),
  );
  assert.equal(await count(server), 4116);
});

test('identical old chunks are idempotent after later chunks and changed old payload is rejected', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const first = await append(owner.socket, stroke);
  await append(owner.socket, { ...stroke, chunkIndex: 1, isFinal: true });
  const retry = await append(owner.socket, stroke);
  assert.equal(retry.ok, true);
  assert.equal(retry.data.accepted, false);
  assert.deepEqual(retry.data.preview, first.data.preview);
  assert.equal(
    (await append(owner.socket, { ...stroke, points: [{ x: 99, y: 99 }] }))
      .error.code,
    'INVALID_STROKE',
  );
  assert.equal(await count(server), 2);
});

test('many completed strokes keep bounded state and an evicted stroke still deduplicates from DB', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const original = input({ isFinal: true });
  const accepted = await append(owner.socket, original);
  const backend = internals(server);
  const {
    AppendStrokeUseCase,
  } = require('../../dist/modules/canvas/features/append-stroke/append-stroke.use-case');
  const usecase = server.app.get(AppendStrokeUseCase);
  const identities = Array.from({ length: 2050 }, () => ({
    userId: randomUUID(),
    token: randomBytes(32).toString('base64url'),
  }));
  await server.pool.query('INSERT INTO users(id) SELECT unnest($1::uuid[])', [
    identities.map((i) => i.userId),
  ]);
  await server.pool.query(
    'INSERT INTO auth_sessions(user_id,token_hash) SELECT * FROM unnest($1::uuid[],$2::text[])',
    [
      identities.map((i) => i.userId),
      identities.map((i) => createHash('sha256').update(i.token).digest('hex')),
    ],
  );
  for (const identity of identities)
    await usecase.execute(
      identity.userId,
      identity.token,
      input({ isFinal: true }),
    );
  assert.ok(
    backend.drawing.strokes.size <= 2048,
    'completed stroke states must not grow with total users',
  );
  assert.equal(
    backend.drawing.strokes.has(`${owner.userId}:${original.clientStrokeId}`),
    false,
  );
  const retry = await append(owner.socket, original);
  assert.equal(retry.data.accepted, false);
  assert.deepEqual(retry.data.preview, accepted.data.preview);
  assert.equal(await count(server), 2051);
});

/** 실제 COMMIT은 성공시키고 호출자에게 결과가 유실되는 경우만 재현한다. */
function loseCommitResponseOnce(server, predicate) {
  const {
    TransactionRunner,
  } = require('../../dist/database/transaction/transaction-runner');
  const runner = server.app.get(TransactionRunner);
  const run = runner.run.bind(runner);
  let lost = false;
  runner.run = async (operation) => {
    const value = await run(operation);
    if (!lost && predicate(value)) {
      lost = true;
      throw new Error('Test committed response lost');
    }
    return value;
  };
  return () => {
    runner.run = run;
  };
}

test('first usage commit response loss is reconciled without losing the users only stroke', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const restore = loseCommitResponseOnce(
    server,
    (value) => value?.prepared?.preview?.chunkIndex === 0,
  );
  t.after(restore);
  const first = await append(owner.socket, stroke);
  assert.equal(first.ok, true);
  assert.equal((await append(owner.socket, stroke)).data.accepted, false);
  assert.equal(
    (await append(owner.socket, { ...stroke, chunkIndex: 1, isFinal: true }))
      .ok,
    true,
  );
  const rows = await server.pool.query(
    'SELECT count(*) AS n FROM canvas_stroke_usages WHERE user_id=$1',
    [owner.userId],
  );
  assert.equal(rows.rows[0].n, '1');
  assert.equal(await count(server), 2);
});

test('a lost final commit response is reconciled before another users sequence is assigned', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const other = await member(t, server);
  const stroke = input();
  await append(owner.socket, stroke);
  const restore = loseCommitResponseOnce(
    server,
    (value) => value?.prepared?.preview?.isFinal === true,
  );
  t.after(restore);
  const final = await append(owner.socket, {
    ...stroke,
    chunkIndex: 1,
    isFinal: true,
  });
  assert.equal(final.ok, true);
  const following = await append(other.socket, input({ isFinal: true }));
  assert.equal(following.ok, true);
  assert.equal(following.data.preview.sequence, '3');
  const page = (await sync(other.socket)).data;
  assert.deepEqual(
    page.previews.map((p) => p.sequence),
    ['1', '2', '3'],
  );
  assert.equal(await count(server), 3);
});

test('only first durable completion advances the completed stroke counter', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const backend = internals(server);
  await append(owner.socket, stroke);
  await backend.drawing.flush();
  const head = async () =>
    (
      await server.pool.query(
        "SELECT last_sequence,last_chunk_sequence FROM canvases WHERE type='main'",
      )
    ).rows[0];
  assert.deepEqual(await head(), {
    last_sequence: '0',
    last_chunk_sequence: '1',
  });
  const final = { ...stroke, chunkIndex: 1, isFinal: true };
  await append(owner.socket, final);
  assert.deepEqual(await head(), {
    last_sequence: '1',
    last_chunk_sequence: '2',
  });
  await append(owner.socket, final);
  assert.deepEqual(await head(), {
    last_sequence: '1',
    last_chunk_sequence: '2',
  });
});

test('unavailable commit reconciliation blocks new sequence assignment until DB confirmation recovers', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const other = await member(t, server);
  const stroke = input();
  await append(owner.socket, stroke);
  const restore = loseCommitResponseOnce(
    server,
    (value) => value?.prepared?.preview?.isFinal === true,
  );
  t.after(restore);
  const {
    CanvasChunkRepository,
  } = require('../../dist/modules/canvas/resources/canvas-drawing/canvas-chunk.repository');
  const repository = server.app.get(CanvasChunkRepository);
  const byIndex = repository.byIndex.bind(repository);
  let blocked = true;
  repository.byIndex = async (...args) => {
    if (blocked) throw new Error('Test DB verification unavailable');
    return byIndex(...args);
  };
  t.after(() => {
    repository.byIndex = byIndex;
  });
  const final = await append(owner.socket, {
    ...stroke,
    chunkIndex: 1,
    isFinal: true,
  });
  assert.equal(final.error.code, 'REALTIME_UNAVAILABLE');
  const next = input({ isFinal: true });
  assert.equal(
    (await append(other.socket, next)).error.code,
    'REALTIME_UNAVAILABLE',
  );
  assert.equal(await count(server), 2);
  const usage = await server.pool.query(
    'SELECT count(*) AS n FROM canvas_stroke_usages WHERE user_id=$1',
    [other.userId],
  );
  assert.equal(usage.rows[0].n, '0');
  blocked = false;
  const resumed = await append(other.socket, next);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.data.preview.sequence, '3');
  assert.deepEqual(
    (await sync(other.socket)).data.previews.map((p) => p.sequence),
    ['1', '2', '3'],
  );
});

test('large coordinate batches paginate within the byte budget without skipped sequences', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const backend = internals(server);
  const stroke = input({
    points: Array.from({ length: 128 }, () => ({
      x: 1234.123456789,
      y: 4321.987654321,
    })),
  });
  for (let chunkIndex = 0; chunkIndex < 200; chunkIndex++)
    await backend.append(owner, { ...stroke, chunkIndex });
  await backend.append(owner, {
    ...stroke,
    chunkIndex: 200,
    isFinal: true,
    points: [],
  });
  let cursor = '0',
    epoch,
    through,
    received = [];
  do {
    const page = await backend.drawing.page({
      afterSequence: cursor,
      epoch,
      throughSequence: through,
      limit: 100,
    });
    assert.ok(
      page.previews.reduce(
        (sum, p) => sum + Buffer.byteLength(JSON.stringify(p)),
        0,
      ) <= 131072,
    );
    received.push(...page.previews.map((p) => p.sequence));
    cursor = page.nextSequence;
    epoch = page.epoch;
    through = page.headSequence;
    if (!page.hasMore) break;
  } while (true);
  assert.deepEqual(
    received,
    Array.from({ length: 201 }, (_, i) => String(i + 1)),
  );
});

test('temporary start authentication failure does not disable later middle chunk authorization caching', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const stroke = input();
  const {
    CanvasAccess,
  } = require('../../dist/modules/canvas/resources/canvas-access/canvas-access');
  const access = server.app.get(CanvasAccess);
  const authenticate = access.authenticate.bind(access);
  access.authenticate = async () => {
    throw new Error('Test temporary authentication storage failure');
  };
  assert.equal(
    (await append(owner.socket, stroke)).error.code,
    'REALTIME_UNAVAILABLE',
  );
  access.authenticate = authenticate;
  t.after(() => {
    access.authenticate = authenticate;
  });
  assert.equal((await append(owner.socket, stroke)).ok, true);
  await server.pool.query(
    'UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1',
    [owner.userId],
  );
  assert.equal(
    (await append(owner.socket, { ...stroke, chunkIndex: 1 })).ok,
    true,
  );
});

test('large unpersisted batches hit the byte bound before the chunk count bound', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const backend = internals(server);
  const stroke = input({
    points: Array.from({ length: 128 }, () => ({
      x: 1234.123456789,
      y: 4321.987654321,
    })),
  });
  await server.pool
    .query(`CREATE FUNCTION reject_byte_flush() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Test byte flush failure'; END; $$;
    CREATE CONSTRAINT TRIGGER reject_byte_flush AFTER INSERT ON canvas_stroke_chunks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_byte_flush();`);
  t.after(() =>
    server.pool.query(
      'DROP TRIGGER IF EXISTS reject_byte_flush ON canvas_stroke_chunks; DROP FUNCTION IF EXISTS reject_byte_flush();',
    ),
  );
  let accepted = 0;
  for (; accepted < 4000; accepted++) {
    try {
      await backend.append(owner, { ...stroke, chunkIndex: accepted });
    } catch (error) {
      assert.equal(error.code, 'CANVAS_CAPACITY_REACHED');
      break;
    }
  }
  assert.ok(
    accepted < 4000,
    'byte bound must reject large batches before count-only capacity',
  );
  assert.equal(await count(server), 0);
  await server.pool.query(
    'DROP TRIGGER reject_byte_flush ON canvas_stroke_chunks; DROP FUNCTION reject_byte_flush();',
  );
  await backend.drawing.flush();
  assert.equal(await count(server), accepted);
  assert.equal(
    (
      await backend.append(owner, {
        ...stroke,
        chunkIndex: accepted,
        isFinal: true,
      })
    ).accepted,
    true,
  );
});

test('deferred first commit recovery cannot restore authorization for an already disconnected socket', async (t) => {
  const server = await startServer(t);
  const owner = await member(t, server);
  const observer = await member(t, server);
  const stroke = input();
  const socketId = owner.socket.id;
  const restore = loseCommitResponseOnce(
    server,
    (value) => value?.prepared?.preview?.chunkIndex === 0,
  );
  t.after(restore);
  const {
    CanvasStrokeUsageRepository,
  } = require('../../dist/modules/canvas/resources/canvas-stroke-usage/canvas-stroke-usage.repository');
  const usages = server.app.get(CanvasStrokeUsageRepository);
  const recorded = usages.recordedMain.bind(usages);
  usages.recordedMain = async () => {
    throw new Error('Test usage verification unavailable');
  };
  assert.equal(
    (await append(owner.socket, stroke)).error.code,
    'REALTIME_UNAVAILABLE',
  );
  owner.socket.disconnect();
  await delay(20);
  usages.recordedMain = recorded;
  t.after(() => {
    usages.recordedMain = recorded;
  });
  const page = (await sync(observer.socket)).data;
  assert.equal(page.previews.length, 1);
  assert.equal(
    internals(server).drawing.cachedUser(socketId, stroke.clientStrokeId),
    undefined,
  );
});
