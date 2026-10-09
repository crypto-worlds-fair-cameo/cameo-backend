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
  parseBootstrap,
  type CanvasAckCallback,
} from '../../resources/canvas-stroke/canvas-stroke';
import type { CanvasBootstrapPayload } from '../../resources/canvas-snapshot/canvas-snapshot';
import { BootstrapCanvasUseCase } from './bootstrap-canvas.use-case';

@WebSocketGateway({ namespace: '/canvas' })
export class BootstrapCanvasGateway {
  constructor(
    private readonly bootstrap: BootstrapCanvasUseCase,
    private readonly connections: CanvasConnections,
  ) {}

  /** bootstrap은 runtime 고정 epoch/head와 선택한 스냅샷 경계를 함께 반환한다. */
  @SubscribeMessage('canvas:bootstrap')
  async handle(
    @ConnectedSocket() socket: CanvasSocket,
    @MessageBody() body: unknown,
    @Ack() ack: CanvasAckCallback<CanvasBootstrapPayload>,
  ): Promise<void> {
    await this.connections.respond(socket, 'canvas:bootstrap', ack, () => {
      const binding = this.connections.binding(socket);
      return this.bootstrap.execute(
        parseBootstrap(body),
        binding.target,
        binding.lease.runtime,
      );
    });
  }
}
