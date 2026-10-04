import { Injectable } from '@nestjs/common';
import { CanvasDrawing } from '../../resources/canvas-drawing/canvas-drawing';
import type {
  CanvasSyncPage,
  SyncCanvasInput,
} from '../../resources/canvas-stroke/canvas-stroke';

@Injectable()
export class SyncCanvasUseCase {
  constructor(private readonly drawing: CanvasDrawing) {}

  /** 관람자도 저장된 좌표와 아직 저장되지 않은 좌표를 같은 순서로 복구한다. */
  execute(input: SyncCanvasInput & { limit: number }): Promise<CanvasSyncPage> {
    return this.drawing.page(input);
  }
}
