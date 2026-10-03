import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { CanvasConnections } from '../../resources/canvas-connections/canvas-connections';
import type { CanvasSocket } from '../../resources/canvas-connections/canvas-events';
import { CanvasAccess } from '../../resources/canvas-access/canvas-access';
import {
  parseAppend,
  type AppendStrokeResult,
  type CanvasAckCallback,
} from '../../resources/canvas-stroke/canvas-stroke';
import { AppendStrokeUseCase } from './append-stroke.use-case';

@WebSocketGateway({ namespace: '/canvas' })
export class AppendStrokeGateway {
  constructor(
    private readonly append: AppendStrokeUseCase,
    private readonly access: CanvasAccess,
    private readonly connections: CanvasConnections,
  ) {}

  /** ACK로 수신 결과를 알리고, 승인한 좌표만 제출자를 제외한 관람 연결에 보낸다. */
  @SubscribeMessage('stroke:append')
  async handle(
    @ConnectedSocket() socket: CanvasSocket,
    @MessageBody() body: unknown,
    @Ack() ack: CanvasAckCallback<AppendStrokeResult>,
  ): Promise<void> {
    await this.connections.respond(socket, 'stroke:append', ack, async () => {
      const input = parseAppend(body);
      const result = await this.append.execute(
        socket.id,
        this.access.token(socket.handshake.headers.cookie),
        input,
      );
      if (result.accepted) this.connections.preview(socket, result.preview);
      return result;
    });
  }
}
