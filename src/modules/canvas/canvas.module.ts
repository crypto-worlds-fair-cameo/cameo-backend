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
import { CanvasDefinition } from './resources/canvas-definition/canvas-definition';
import { CanvasRuntimeRegistry } from './resources/canvas-drawing/canvas-runtime-registry';
import { SeasonCanvasQuery } from './resources/canvas-access/season-canvas-query';

@Module({
  imports: [AuthModule],
  providers: [
    ConnectCanvasGateway,
    CanvasConnections,
    CanvasAccess,
    SeasonCanvasQuery,
    CanvasRuntimeRegistry,
    CanvasDrawing,
    CanvasDefinition,
    CanvasChunkRepository,
    CanvasStrokeUsageRepository,
    AppendStrokeGateway,
    AppendStrokeUseCase,
    SyncCanvasGateway,
    SyncCanvasUseCase,
  ],
  exports: [CanvasDefinition, CanvasDrawing],
})
export class CanvasModule {}
