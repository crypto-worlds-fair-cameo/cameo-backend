import { Injectable } from '@nestjs/common';
import { CanvasAccess } from '../../resources/canvas-access/canvas-access';
import { CanvasDrawing } from '../../resources/canvas-drawing/canvas-drawing';
import {
  CanvasStrokeError,
  type AppendStrokeInput,
  type AppendStrokeResult,
} from '../../resources/canvas-stroke/canvas-stroke';

@Injectable()
export class AppendStrokeUseCase {
  constructor(
    private readonly access: CanvasAccess,
    private readonly drawing: CanvasDrawing,
  ) {}

  /** 시작과 완료에서만 인증하고 중간 묶음은 해당 획의 인증 캐시로 메모리·방송에 전달한다. */
  async execute(
    connectionId: string,
    token: string | undefined,
    input: AppendStrokeInput,
  ): Promise<AppendStrokeResult> {
    const cached = this.drawing.cachedUser(connectionId, input.clientStrokeId);
    let userId: string;
    if (!cached || input.isFinal) {
      try {
        userId = await this.access.authenticate(token);
      } catch (error: unknown) {
        // 완료 인증이 실패한 연결은 중간 전송용 권한도 다시 사용할 수 없다.
        this.drawing.disconnect(connectionId);
        throw error;
      }
    } else {
      userId = cached;
    }
    if (cached && cached !== userId)
      throw new CanvasStrokeError(
        'AUTH_REQUIRED',
        'Authentication is required.',
      );
    return this.drawing.append(connectionId, userId, input);
  }
}
