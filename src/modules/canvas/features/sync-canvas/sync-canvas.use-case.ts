import { Injectable } from '@nestjs/common';
import { CanvasDrawing } from '../../resources/canvas-drawing/canvas-drawing';
import type {
  CanvasSyncPage,
  SyncCanvasInput,
} from '../../resources/canvas-stroke/canvas-stroke';

@Injectable()
export class SyncCanvasUseCase {
  constructor(private readonly drawing: CanvasDrawing) {}

  /** 관람자도 메모리에 수신한 좌표 묶음을 순서대로 복구한다. DB는 조회하지 않는다. */
  execute(input: SyncCanvasInput & { limit: number }): Promise<CanvasSyncPage> {
    return Promise.resolve(this.drawing.page(input));
  }
}
