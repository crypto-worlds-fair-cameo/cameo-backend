import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { CanvasConnections } from '../../resources/canvas-connections/canvas-connections';
import type { CanvasSocket } from '../../resources/canvas-connections/canvas-events';
import {
  parseSync,
  type CanvasAckCallback,
  type CanvasSyncPage,
} from '../../resources/canvas-stroke/canvas-stroke';
import { SyncCanvasUseCase } from './sync-canvas.use-case';

@WebSocketGateway({ namespace: '/canvas' })
export class SyncCanvasGateway {
  constructor(
    private readonly sync: SyncCanvasUseCase,
    private readonly connections: CanvasConnections,
  ) {}

  /** 검증된 순서 범위의 확정 획을 요청한 연결에만 ACK로 반환한다. */
  @SubscribeMessage('canvas:sync')
  async handle(
    @ConnectedSocket() socket: CanvasSocket,
    @MessageBody() body: unknown,
    @Ack() ack: CanvasAckCallback<CanvasSyncPage>,
  ): Promise<void> {
    await this.connections.respond(socket, 'canvas:sync', ack, () =>
      this.sync.execute(parseSync(body)),
    );
  }
}
