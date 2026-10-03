import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { CanvasConnections } from '../../resources/canvas-connections/canvas-connections';
import type {
  CanvasNamespace,
  CanvasSocket,
} from '../../resources/canvas-connections/canvas-events';

/** 캔버스 관람 소켓의 전송 수명을 연결 관리 기능에 전달한다. */
@WebSocketGateway({ namespace: '/canvas' })
export class ConnectCanvasGateway
  implements OnGatewayInit<CanvasNamespace>, OnGatewayConnection<CanvasSocket>
{
  constructor(private readonly connections: CanvasConnections) {}

  afterInit(namespace: CanvasNamespace): void {
    this.connections.initialize(namespace);
  }

  handleConnection(socket: CanvasSocket): void {
    this.connections.connect(socket);
  }
}
