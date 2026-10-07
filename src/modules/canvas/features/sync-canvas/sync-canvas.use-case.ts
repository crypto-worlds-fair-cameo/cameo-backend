import { Injectable } from '@nestjs/common';
import { CanvasDrawing } from '../../resources/canvas-drawing/canvas-drawing';
import type {
  CanvasSyncPage,
  SyncCanvasInput,
} from '../../resources/canvas-stroke/canvas-stroke';
import type { CanvasTarget } from '../../resources/canvas-definition/canvas-target';
import type { CanvasRuntime } from '../../resources/canvas-drawing/canvas-runtime';

@Injectable()
export class SyncCanvasUseCase {
  constructor(private readonly drawing: CanvasDrawing) {}

  /** 관람자도 저장된 좌표와 아직 저장되지 않은 좌표를 같은 순서로 복구한다. */
  execute(
    input: SyncCanvasInput & { limit: number },
    target?: CanvasTarget,
    runtime?: CanvasRuntime,
  ): Promise<CanvasSyncPage> {
    if (!target || !runtime) return this.drawing.page(input);
    // disconnect와 겹쳐도 page가 끝날 때까지 별도 operation lease가 eviction을 막는다.
    return this.drawing.readCanvas(target, async (leasedRuntime) => {
      if (leasedRuntime !== runtime || leasedRuntime.target.key !== target.key)
        throw new Error('Canvas binding target does not match its runtime.');
      return this.drawing.page(input, leasedRuntime);
    });
  }
}
