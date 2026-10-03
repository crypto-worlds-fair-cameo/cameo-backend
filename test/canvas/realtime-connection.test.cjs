const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Manager } = require('socket.io-client');
const {
  startServer,
  createClient,
  nextEvent,
  connect,
} = require('./server-fixture.cjs');
const origin = 'http://localhost:5173';

test('two guests receive ready, current presence, and fresh state after reconnect', async (t) => {
  const { url } = await startServer(t);
  const first = createClient(t, url);
  assert.deepEqual(await connect(first), {
    protocolVersion: 1,
    canvasKey: 'main',
    viewer: { status: 'guest', userId: null },
    canDraw: false,
    presence: { connectionCount: 1 },
  });

  const firstSeesTwo = nextEvent(
    first,
    'canvas:presence',
    (p) => p.connectionCount === 2,
  );
  const second = createClient(t, url);
  const secondSeesTwo = nextEvent(
    second,
    'canvas:presence',
    (p) => p.connectionCount === 2,
  );
  assert.equal((await connect(second)).presence.connectionCount, 2);
  assert.deepEqual(await firstSeesTwo, {
    canvasKey: 'main',
    connectionCount: 2,
  });
  await secondSeesTwo;

  const firstSeesOne = nextEvent(
    first,
    'canvas:presence',
    (p) => p.connectionCount === 1,
  );
  const oldId = second.id;
  second.disconnect();
  await firstSeesOne;
  assert.equal((await connect(second)).presence.connectionCount, 2);
  assert.notEqual(second.id, oldId);

  // 실제 configureApp의 HTTP 응답 계약도 같은 포트에서 유지한다.
  const response = await fetch(`${url}/api/probe`);
  assert.deepEqual(await response.json(), {
    statusCode: 200,
    success: true,
    data: { alive: true },
  });
});

test('invalid cookies and claimed identity cannot authenticate a connection', async (t) => {
  const { url } = await startServer(t);
  const socket = createClient(t, url, {
    extraHeaders: { Origin: origin, Cookie: 'cameo_session=unverified' },
    auth: { userId: 'claimed-user', isLoggedIn: true },
  });
  const ready = await connect(socket);
  assert.deepEqual(ready.viewer, { status: 'guest', userId: null });
  assert.equal(ready.canDraw, false);
});

test('a network transport loss reconnects with a new ready and no double counting', async (t) => {
  const { url } = await startServer(t);
  const socket = createClient(t, url, {
    reconnection: true,
    reconnectionDelay: 20,
  });
  await connect(socket);
  const oldId = socket.id;
  const ready = nextEvent(socket, 'connection:ready');
  socket.io.engine.close();
  assert.equal((await ready).presence.connectionCount, 1);
  assert.notEqual(socket.id, oldId);
});

test('WebSocket rejects missing, null, and unapproved origins', async (t) => {
  const { url } = await startServer(t);
  for (const headers of [
    {},
    { Origin: 'null' },
    { Origin: 'https://unapproved.example' },
  ]) {
    const socket = createClient(t, url, { extraHeaders: headers });
    const error = nextEvent(socket, 'connect_error');
    socket.connect();
    assert.ok(await error);
    assert.equal(socket.connected, false);
    socket.disconnect();
  }
});

test('polling and the default namespace are not entry points', async (t) => {
  const { url } = await startServer(t);
  const polling = createClient(t, url, { transports: ['polling'] });
  const pollingError = nextEvent(polling, 'connect_error');
  polling.connect();
  assert.ok(await pollingError);
  const root = createClient(t, url, {}, '/');
  const rootError = nextEvent(root, 'connect_error');
  root.connect();
  assert.ok(await rootError);
});

test('transport capacity includes clients that never enter the canvas namespace and releases on close', async (t) => {
  const { url } = await startServer(t, 1);
  const manager = new Manager(url, {
    path: '/realtime',
    transports: ['websocket'],
    extraHeaders: { Origin: origin },
    autoConnect: false,
    reconnection: false,
  });
  t.after(() => manager.engine?.close());
  const opened = nextEvent(manager, 'open');
  manager.open();
  await opened;

  const second = createClient(t, url);
  const rejected = nextEvent(second, 'connect_error');
  second.connect();
  assert.ok(await rejected);
  manager.engine.close();

  // TCP 종료가 서버에 전달된 뒤 새 연결이 빈 슬롯을 사용할 수 있어야 한다.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await connect(second)).presence.connectionCount, 1);
});

test('unknown events cannot broadcast and excessive messages reset only the sender', async (t) => {
  const { url } = await startServer(t);
  const observer = createClient(t, url);
  const sender = createClient(t, url);
  await connect(observer);
  await connect(sender);
  let relayed = false;
  observer.on('stroke:preview', () => {
    relayed = true;
  });
  const reset = nextEvent(sender, 'connection:reset');
  const disconnected = nextEvent(sender, 'disconnect');
  const count = nextEvent(
    observer,
    'canvas:presence',
    (p) => p.connectionCount === 1,
  );
  for (let i = 0; i < 11; i++) sender.emit('unsupported', { points: [[i, i]] });
  assert.deepEqual(await reset, {
    reason: 'connection_policy',
    retryable: false,
    retryAfterMs: 0,
  });
  assert.equal(await disconnected, 'io server disconnect');
  await count;
  assert.equal(relayed, false);
  assert.equal(observer.connected, true);
});

test('graceful app shutdown sends reset and closes connected clients', async (t) => {
  const { app, url } = await startServer(t);
  const socket = createClient(t, url);
  await connect(socket);
  const reset = nextEvent(socket, 'connection:reset');
  const disconnected = nextEvent(socket, 'disconnect');
  await app.close();
  assert.deepEqual(await reset, {
    reason: 'server_shutdown',
    retryable: true,
    retryAfterMs: 1000,
  });
  // 전송 서버도 함께 닫히므로 namespace 종료보다 TCP 종료를 먼저 관찰할 수 있다.
  assert.ok(
    ['io server disconnect', 'transport close'].includes(await disconnected),
  );
});

test('oversized messages close the sender without affecting other connections', async (t) => {
  const { url } = await startServer(t);
  const observer = createClient(t, url);
  const sender = createClient(t, url);
  await connect(observer);
  await connect(sender);
  const disconnected = nextEvent(sender, 'disconnect');
  const count = nextEvent(
    observer,
    'canvas:presence',
    (p) => p.connectionCount === 1,
  );
  sender.emit('unsupported', 'x'.repeat(17 * 1024));
  await disconnected;
  await count;
  assert.equal(observer.connected, true);
});

test('invalid connection limits fail configuration instead of disabling the bound', () => {
  const realtimeConfig = require('../../dist/config/realtime.config').default;
  const previous = process.env.REALTIME_MAX_CONNECTIONS;
  try {
    for (const value of ['', '0', '-1', '1.5', 'Infinity', 'not-a-number']) {
      process.env.REALTIME_MAX_CONNECTIONS = value;
      assert.throws(() => realtimeConfig(), /positive safe integer/);
    }
    delete process.env.REALTIME_MAX_CONNECTIONS;
    assert.equal(realtimeConfig().maxConnections, 5000);
  } finally {
    if (previous === undefined) delete process.env.REALTIME_MAX_CONNECTIONS;
    else process.env.REALTIME_MAX_CONNECTIONS = previous;
  }
});
