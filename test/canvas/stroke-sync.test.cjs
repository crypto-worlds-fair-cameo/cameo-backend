const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  startServer,
  createClient,
  nextEvent,
  connect,
} = require('./server-fixture.cjs');

const brush = {
  type: 'round',
  size: 12,
  color: '#ED4242',
  opacity: 1,
  version: 1,
};
const points = [
  { x: 100, y: 200 },
  { x: 104, y: 203 },
];

async function member(t, server) {
  const userId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await server.pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await server.pool.query(
    'INSERT INTO auth_sessions (user_id, token_hash) VALUES ($1, $2)',
    [userId, createHash('sha256').update(token).digest('hex')],
  );
  const socket = createClient(t, server.url, {
    extraHeaders: {
      Origin: 'http://localhost:5173',
      Cookie: `cameo_session=${token}`,
    },
  });
  return { socket, userId, token, ready: await connect(socket) };
}
function request(socket, event, data) {
  return socket.timeout(1000).emitWithAck(event, data);
}
function input(overrides = {}) {
  return {
    clientStrokeId: randomUUID(),
    chunkIndex: 0,
    brush,
    points,
    isFinal: false,
    ...overrides,
  };
}

test('append relays brush and coordinates and final flag through preview only', async (t) => {
  const server = await startServer(t);
  const { socket, userId, ready } = await member(t, server);
  assert.equal(ready.canDraw, true);
  const observer = createClient(t, server.url);
  await connect(observer);
  const stroke = input();
  const notice = nextEvent(observer, 'stroke:preview');
  const ack = await request(socket, 'stroke:append', stroke);
  assert.equal(ack.ok, true);
  const preview = await notice;
  assert.equal(preview.isFinal, false);
  assert.equal(preview.userId, userId);
  assert.deepEqual(preview.brush, brush);
  assert.deepEqual(preview.points, points);
  assert.equal(preview.sequence, '1');
  assert.equal(ack.data.accepted, true);
  assert.deepEqual(ack.data.preview, preview);
  const finalNotice = nextEvent(
    observer,
    'stroke:preview',
    (event) => event.isFinal,
  );
  const final = await request(socket, 'stroke:append', {
    ...stroke,
    chunkIndex: 1,
    isFinal: true,
  });
  assert.deepEqual(await finalNotice, final.data.preview);
  const synced = await request(observer, 'canvas:sync', { afterSequence: '0' });
  assert.deepEqual(synced.data.previews, [preview, final.data.preview]);
});

test('middle chunks use the stroke authorization while final chunk rechecks a revoked session', async (t) => {
  const server = await startServer(t);
  const { socket, userId } = await member(t, server);
  const stroke = input();
  assert.equal((await request(socket, 'stroke:append', stroke)).ok, true);
  await server.pool.query(
    'UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1',
    [userId],
  );
  assert.equal(
    (await request(socket, 'stroke:append', { ...stroke, chunkIndex: 1 })).ok,
    true,
  );
  assert.equal(
    (
      await request(socket, 'stroke:append', {
        ...stroke,
        chunkIndex: 2,
        isFinal: true,
      })
    ).error.code,
    'AUTH_REQUIRED',
  );
  const guest = createClient(t, server.url);
  assert.equal(
    (await request(socket, 'stroke:append', { ...stroke, chunkIndex: 2 })).error
      .code,
    'AUTH_REQUIRED',
  );
  await connect(guest);
  const page = await request(guest, 'canvas:sync', { afterSequence: '0' });
  assert.equal(page.data.previews.length, 2);
});

test('guests cannot append and malformed brush, coordinate and final flag are rejected', async (t) => {
  const server = await startServer(t);
  const guest = createClient(t, server.url);
  await connect(guest);
  assert.equal(
    (await request(guest, 'stroke:append', input())).error.code,
    'AUTH_REQUIRED',
  );
  const { socket } = await member(t, server);
  for (const stroke of [
    input({ points: [{ x: -1, y: 0 }] }),
    input({ isFinal: 'true' }),
    input({ brush: { ...brush, type: 'flat' } }),
    input({ brush: { ...brush, type: 'airbrush', seed: 1 } }),
  ]) {
    assert.equal(
      (await request(socket, 'stroke:append', stroke)).error.code,
      'INVALID_STROKE',
    );
  }
});

test('duplicate chunks do not advance sync and a closed stroke cannot receive more points', async (t) => {
  const server = await startServer(t);
  const { socket } = await member(t, server);
  const stroke = input({ isFinal: true });
  const first = await request(socket, 'stroke:append', stroke);
  const repeated = await request(socket, 'stroke:append', stroke);
  assert.equal(repeated.data.accepted, false);
  assert.deepEqual(repeated.data.preview, first.data.preview);
  assert.equal(
    (await request(socket, 'stroke:append', { ...stroke, chunkIndex: 1 })).error
      .code,
    'STROKE_CLOSED',
  );
  assert.equal(
    (
      await request(socket, 'stroke:append', {
        ...stroke,
        brush: { ...brush, size: 20 },
      })
    ).error.code,
    'INVALID_STROKE',
  );
  const page = await request(socket, 'canvas:sync', { afterSequence: '0' });
  assert.equal(page.data.previews.length, 1);
});

test('sync reads ordered chunks with a fixed boundary after reconnect and resets stale epochs', async (t) => {
  const server = await startServer(t);
  const { socket } = await member(t, server);
  const observer = createClient(t, server.url);
  await connect(observer);
  const stroke = input();
  const expected = [];
  for (let chunkIndex = 0; chunkIndex < 12; chunkIndex++)
    expected.push(
      (await request(socket, 'stroke:append', { ...stroke, chunkIndex })).data
        .preview,
    );
  const page = (
    await request(observer, 'canvas:sync', { afterSequence: '0', limit: 10 })
  ).data;
  assert.deepEqual(page.previews, expected.slice(0, 10));
  assert.equal(page.hasMore, true);
  observer.disconnect();
  const final = (
    await request(socket, 'stroke:append', {
      ...stroke,
      chunkIndex: 12,
      isFinal: true,
    })
  ).data.preview;
  await connect(observer);
  const next = (
    await request(observer, 'canvas:sync', {
      epoch: page.epoch,
      afterSequence: page.nextSequence,
      throughSequence: page.headSequence,
      limit: 10,
    })
  ).data;
  assert.deepEqual(next.previews, expected.slice(10));
  assert.equal(next.hasMore, false);
  const tail = (
    await request(observer, 'canvas:sync', {
      epoch: page.epoch,
      afterSequence: next.nextSequence,
    })
  ).data;
  assert.deepEqual(tail.previews, [final]);
  const reset = (
    await request(observer, 'canvas:sync', {
      epoch: randomUUID(),
      afterSequence: '999',
    })
  ).data;
  assert.equal(reset.reset, true);
  assert.deepEqual(reset.previews, [...expected, final]);
  assert.equal(
    (await request(observer, 'canvas:sync', { afterSequence: '-1' })).error
      .code,
    'INVALID_SYNC',
  );
});

test('a fresh server has no previous drawing history or epoch', async (t) => {
  const first = await startServer(t);
  const { socket } = await member(t, first);
  const preview = (
    await request(socket, 'stroke:append', input({ isFinal: true }))
  ).data.preview;
  const second = await startServer(t);
  const guest = createClient(t, second.url);
  await connect(guest);
  const page = (
    await request(guest, 'canvas:sync', {
      epoch: preview.epoch,
      afterSequence: preview.sequence,
    })
  ).data;
  assert.notEqual(page.epoch, preview.epoch);
  assert.equal(page.reset, true);
  assert.deepEqual(page.previews, []);
  assert.equal(page.headSequence, '0');
});

test('empty final chunk closes a stroke and removed commit no longer handles requests', async (t) => {
  const server = await startServer(t);
  const { socket } = await member(t, server);
  const stroke = input();
  await request(socket, 'stroke:append', stroke);
  const final = await request(socket, 'stroke:append', {
    ...stroke,
    chunkIndex: 1,
    points: [],
    isFinal: true,
  });
  assert.equal(final.ok, true);
  assert.equal(final.data.preview.isFinal, true);
  await assert.rejects(
    socket
      .timeout(100)
      .emitWithAck('stroke:commit', {
        clientStrokeId: stroke.clientStrokeId,
        brush,
        points,
      }),
    /timed out/,
  );
  const page = await request(socket, 'canvas:sync', { afterSequence: '0' });
  assert.equal(page.data.previews.length, 2);
});

test('memory capacity rejects new chunks while retaining the existing drawing for sync', (t) => {
  const {
    CanvasDrawing,
  } = require('../../dist/modules/canvas/resources/canvas-drawing/canvas-drawing');
  const {
    STROKE_LIMITS,
  } = require('../../dist/modules/canvas/resources/canvas-stroke/canvas-stroke');
  const drawing = new CanvasDrawing();
  t.after(() => drawing.onModuleDestroy());
  const first = input({ points: [{ x: 1, y: 1 }], isFinal: true });
  for (let i = 0; i < STROKE_LIMITS.retainedChunks; i++)
    drawing.append('connection', 'user', {
      ...first,
      clientStrokeId: i === 0 ? first.clientStrokeId : randomUUID(),
    });
  assert.throws(
    () => drawing.append('connection', 'user', input({ isFinal: true })),
    (error) => error.code === 'CANVAS_CAPACITY_REACHED',
  );
  const page = drawing.page({ afterSequence: '0', limit: 1 });
  assert.equal(page.previews[0].clientStrokeId, first.clientStrokeId);
  assert.equal(page.previews[0].sequence, '1');
  assert.equal(page.hasMore, true);
});
