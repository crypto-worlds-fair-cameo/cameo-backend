const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

// 문서에서 실제로 복사할 예제를 실행해 안내와 동작이 달라지는 회귀를 잡는다.
const guide = readFileSync(
  resolve(__dirname, '../../docs/api/canvas/realtime-connection.md'),
  'utf8',
);
const example = guide
  .match(/```js\n([\s\S]*?)\n```/)[1]
  .replace("import { io } from 'socket.io-client';", '')
  .replace('export function ', 'function ');

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), 'Expected connection state was not reached');
}

/** 종료 사유와 연결 거절을 제어하되 실제 Socket.IO 전송으로 문서 예제를 검증한다. */
async function startFixture(t, onConnection, middleware) {
  const http = createServer();
  const server = new Server(http, {
    path: '/realtime',
    transports: ['websocket'],
  });
  const namespace = server.of('/canvas');
  if (middleware) namespace.use(middleware);
  let accepted = 0;
  namespace.on('connection', (socket) => {
    accepted += 1;
    if (onConnection) return onConnection(socket);
    socket.emit('connection:ready', {
      protocolVersion: 1,
      canvasKey: 'main',
      viewer: { status: 'guest', userId: null },
      canDraw: false,
      presence: { connectionCount: 1 },
    });
  });
  let connection;
  t.after(async () => {
    connection?.dispose();
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  await new Promise((resolveListen) =>
    http.listen(0, '127.0.0.1', resolveListen),
  );

  let client;
  const states = [];
  const openConnection = new Function(
    'io',
    `${example}\nreturn openMainCanvasConnection;`,
  )((url, options) => {
    client = io(url, options);
    return client;
  });
  connection = openConnection(
    `http://127.0.0.1:${http.address().port}`,
    (state) => states.push(state),
    () => {},
  );
  return {
    client,
    connection,
    namespace,
    states,
    accepted: () => accepted,
    readyCount: () => states.filter((state) => state.status === 'ready').length,
  };
}

test('guide automatically recovers from server reset and later network loss', async (t) => {
  const fixture = await startFixture(t);
  await waitFor(() => fixture.readyCount() === 1);
  const firstId = fixture.client.id;
  const serverSocket = fixture.namespace.sockets.get(firstId);
  const resetAt = Date.now();
  serverSocket.emit('connection:reset', {
    reason: 'server_shutdown',
    retryable: true,
    retryAfterMs: 1800,
  });
  serverSocket.disconnect(true);
  await waitFor(() => fixture.readyCount() === 2);
  assert.ok(
    Date.now() - resetAt >= 1800,
    'Server minimum retry delay was ignored',
  );
  assert.notEqual(fixture.client.id, firstId);

  fixture.client.io.engine.close();
  await waitFor(() => fixture.readyCount() === 3);
  assert.equal(fixture.accepted(), 3);
  assert.equal(fixture.namespace.sockets.size, 1);
});

test('guide stops after a non-retryable reset', async (t) => {
  const fixture = await startFixture(t);
  await waitFor(() => fixture.readyCount() === 1);
  const socket = fixture.namespace.sockets.get(fixture.client.id);
  socket.emit('connection:reset', {
    reason: 'connection_policy',
    retryable: false,
    retryAfterMs: 0,
  });
  socket.disconnect(true);
  await waitFor(() => fixture.states.at(-1)?.status === 'failed');
  await delay(1500);
  assert.equal(fixture.accepted(), 1);
  assert.equal(fixture.client.connected, false);
  assert.equal(fixture.states.at(-1).status, 'failed');
});

test('guide cancels pending automatic recovery when the page is disposed', async (t) => {
  const fixture = await startFixture(t);
  await waitFor(() => fixture.readyCount() === 1);
  fixture.client.io.engine.close();
  await waitFor(() => fixture.states.at(-1)?.status === 'reconnecting');
  fixture.connection.dispose();
  const stateCount = fixture.states.length;
  await delay(1500);
  assert.equal(fixture.accepted(), 1);
  assert.equal(fixture.states.length, stateCount);
  assert.equal(fixture.namespace.sockets.size, 0);
});

test('guide retries a temporary namespace rejection without user action', async (t) => {
  let attempts = 0;
  const fixture = await startFixture(t, undefined, (_socket, next) => {
    attempts += 1;
    if (attempts === 1) {
      next(
        Object.assign(new Error('Temporarily unavailable'), {
          data: { retryable: true, retryAfterMs: 1000 },
        }),
      );
    } else {
      next();
    }
  });
  await waitFor(() => fixture.readyCount() === 1);
  assert.equal(attempts, 2);
  assert.equal(fixture.accepted(), 1);
});

test('guide stops repeated unexplained server disconnects before ready', async (t) => {
  const fixture = await startFixture(t, (socket) => socket.disconnect(true));
  await waitFor(() => fixture.states.at(-1)?.status === 'failed');
  assert.equal(fixture.accepted(), 3);
  await delay(1500);
  assert.equal(fixture.accepted(), 3);
});
