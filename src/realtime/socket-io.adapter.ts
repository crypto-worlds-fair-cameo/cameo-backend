import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, type ServerOptions } from 'socket.io';
import type { AllConfigType } from '../config/config.type';

/** HTTP 서버를 공유하면서 WebSocket 출처·전송 크기·동시 연결 수를 제한한다. */
export class SocketIoAdapter extends IoAdapter {
  private readonly origins: Set<string>;
  private readonly maxConnections: number;
  private acceptedTransports = 0;
  private closing = false;

  constructor(app: INestApplicationContext) {
    super(app);
    const config = app.get<ConfigService<AllConfigType>>(ConfigService);
    this.origins = new Set(
      config.getOrThrow('cors.originList', { infer: true }),
    );
    this.maxConnections = config.getOrThrow('realtime.maxConnections', {
      infer: true,
    });
  }

  /** 브라우저의 직접 WebSocket 요청에도 Origin 검사를 적용한다. */
  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = new Server(
      this.httpServer && port === 0 ? this.httpServer : port,
      {
        ...options,
        path: '/realtime',
        serveClient: false,
        transports: ['websocket'],
        allowUpgrades: false,
        maxHttpBufferSize: 16 * 1024,
        pingInterval: 25_000,
        pingTimeout: 20_000,
        connectTimeout: 10_000,
        cors: { origin: [...this.origins], credentials: true },
        allowRequest: (request, callback) => {
          if (this.closing || request.socket.destroyed) {
            callback('Realtime service is temporarily unavailable.', false);
            return;
          }
          if (
            typeof request.headers.origin !== 'string' ||
            !this.origins.has(request.headers.origin)
          ) {
            callback('Origin is not allowed.', false);
            return;
          }
          if (this.acceptedTransports >= this.maxConnections) {
            callback('Realtime connection capacity exceeded.', false);
            return;
          }

          // WebSocket 승인 전에 슬롯을 잡아 namespace 합류 전 연결도 한도에 포함한다.
          // 실패한 handshake도 TCP가 닫히면 같은 경로로 슬롯을 반환한다.
          this.acceptedTransports += 1;
          request.socket.once('close', () => {
            this.acceptedTransports -= 1;
          });
          callback(null, true);
        },
      },
    );

    // 공개 진입점은 /canvas다. 기본 namespace를 별도 관람 채널로 열지 않는다.
    server
      .of('/')
      .use((_socket, next) => next(new Error('Unknown namespace.')));
    return server;
  }

  override async close(server: Server): Promise<void> {
    this.closing = true;
    await super.close(server);
  }
}
