import { Module } from '@nestjs/common';
import { ConnectCanvasGateway } from './features/connect-canvas/connect-canvas.gateway';
import { CanvasConnections } from './resources/canvas-connections/canvas-connections';
import { CanvasDrawing } from './resources/canvas-drawing/canvas-drawing';
import { AuthModule } from '../auth/auth.module';
import { CanvasAccess } from './resources/canvas-access/canvas-access';
import { AppendStrokeGateway } from './features/append-stroke/append-stroke.gateway';
import { AppendStrokeUseCase } from './features/append-stroke/append-stroke.use-case';
import { SyncCanvasGateway } from './features/sync-canvas/sync-canvas.gateway';
import { SyncCanvasUseCase } from './features/sync-canvas/sync-canvas.use-case';
import { CanvasStrokeUsageRepository } from './resources/canvas-stroke-usage/canvas-stroke-usage.repository';
import { CanvasChunkRepository } from './resources/canvas-drawing/canvas-chunk.repository';

@Module({
  imports: [AuthModule],
  providers: [
    ConnectCanvasGateway,
    CanvasConnections,
    CanvasAccess,
    CanvasDrawing,
    CanvasChunkRepository,
    CanvasStrokeUsageRepository,
    AppendStrokeGateway,
    AppendStrokeUseCase,
    SyncCanvasGateway,
    SyncCanvasUseCase,
  ],
})
export class CanvasModule {}
