require('reflect-metadata');
const { Controller, Get, Global, Module } = require('@nestjs/common');
const { ConfigService } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { io } = require('socket.io-client');
const { configureApp } = require('../../dist/app.factory');
const { LoggerService } = require('../../dist/logging/logger.service');
const { CanvasModule } = require('../../dist/modules/canvas/canvas.module');
const { testDatabaseModule } = require('./database-fixture.cjs');

const origin = 'http://localhost:5173';
const initializedTests = new WeakSet();

/** 실제 HTTP·WebSocket 서버를 띄우되 운영 DB와 분리한 임시 PostgreSQL을 사용한다. */
async function startServer(t, maxConnections = 20, managedDatabase = false) {
  const database = await testDatabaseModule(managedDatabase);
  // 각 테스트만 초기화하고 같은 테스트의 재시작은 저장된 캔버스를 그대로 사용한다.
  if (!initializedTests.has(t)) {
    initializedTests.add(t);
    const table = await database.pool.query(
      "SELECT to_regclass('canvas_stroke_chunks') AS name",
    );
    if (table.rows[0].name) {
      await database.pool.query(
        'TRUNCATE canvas_stroke_chunks; UPDATE canvases SET last_chunk_sequence=0, last_sequence=0',
      );
    }
  }
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
            methods: ['GET'],
            allowedHeaders: ['Content-Type'],
          },
          realtime: { maxConnections },
        }),
      },
    ],
    exports: [ConfigService],
  })(TestConfigModule);

  class ProbeController {
    get() {
      return { alive: true };
    }
  }
  Controller('probe')(ProbeController);
  Get()(
    ProbeController.prototype,
    'get',
    Object.getOwnPropertyDescriptor(ProbeController.prototype, 'get'),
  );

  class TestAppModule {}
  Module({
    imports: [TestConfigModule, database.module, CanvasModule],
    providers: [LoggerService],
    controllers: [ProbeController],
  })(TestAppModule);
  const app = configureApp(
    await NestFactory.create(TestAppModule, { logger: false }),
  );
  app.useLogger(false);
  t.after(() => app.close());
  await app.listen(0, '127.0.0.1');
  return { app, pool: database.pool, url: await app.getUrl() };
}

/** 리스너를 먼저 등록할 수 있도록 자동 접속을 끈 독립 클라이언트를 만든다. */
function createClient(t, url, options = {}, namespace = '/canvas') {
  const socket = io(`${url}${namespace}`, {
    path: '/realtime',
    transports: ['websocket'],
    extraHeaders: { Origin: origin },
    forceNew: true,
    autoConnect: false,
    reconnection: false,
    timeout: 1500,
    ...options,
  });
  t.after(() => {
    socket.removeAllListeners();
    socket.disconnect();
  });
  return socket;
}

function nextEvent(socket, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const listener = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      socket.off(event, listener);
      resolve(args[0]);
    };
    const timer = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 3000);
    socket.on(event, listener);
  });
}

async function connect(socket) {
  const ready = nextEvent(socket, 'connection:ready');
  socket.connect();
  return ready;
}

module.exports = { startServer, createClient, nextEvent, connect };
