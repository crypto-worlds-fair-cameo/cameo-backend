import { Module } from '@nestjs/common';
import { ConnectCanvasGateway } from './features/connect-canvas/connect-canvas.gateway';
import { CanvasConnections } from './resources/canvas-connections/canvas-connections';

@Module({
  providers: [ConnectCanvasGateway, CanvasConnections],
})
export class CanvasModule {}
