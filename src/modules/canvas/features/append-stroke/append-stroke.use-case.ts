import { Injectable } from '@nestjs/common';
import { CanvasAccess } from '../../resources/canvas-access/canvas-access';
import {
  CanvasDrawing,
  type PreparedStroke,
} from '../../resources/canvas-drawing/canvas-drawing';
import { CanvasStrokeUsageRepository } from '../../resources/canvas-stroke-usage/canvas-stroke-usage.repository';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
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
    private readonly usages: CanvasStrokeUsageRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 첫 차감은 DB 승인 후 공개하고 중간 좌표는 대기열로, 마지막은 저장 완료 후 ACK한다. */
  execute(
    connectionId: string,
    token: string | undefined,
    input: AppendStrokeInput,
  ): Promise<AppendStrokeResult> {
    return this.drawing.exclusive(async () => {
      const cached = this.drawing.cachedUser(
        connectionId,
        input.clientStrokeId,
      );
      if (cached && !input.isFinal) {
        const prepared = await this.drawing.prepare(
          connectionId,
          cached,
          input,
        );
        return prepared.commit();
      }
      let prepared: PreparedStroke | undefined;
      let approvedUsageId: string | undefined;
      let approvedUserId: string | undefined;
      const approve = async (transaction: TransactionContext) => {
        let userId: string;
        try {
          userId = await this.access.authenticate(token, transaction);
        } catch (error) {
          this.drawing.clearAuthorization(connectionId);
          throw error;
        }
        // 캐시와 실제 세션 사용자가 다르면 다른 사용자의 획을 이어 그릴 수 없다.
        if (cached && cached !== userId)
          throw new CanvasStrokeError(
            'AUTH_REQUIRED',
            'Authentication is required.',
          );
        prepared = await this.drawing.prepare(connectionId, userId, input);
        const usageId =
          prepared.usageId ??
          (await this.usages.consumeMain(
            userId,
            input.clientStrokeId,
            transaction,
          ));
        approvedUsageId = usageId;
        approvedUserId = userId;
        // 마지막 좌표와 같은 트랜잭션에서만 완료를 갱신하고 재전송은 최초 완료 시각을 유지한다.
        if (input.isFinal && prepared.accepted)
          await this.usages.completeMain(
            userId,
            input.clientStrokeId,
            transaction,
          );
        return { prepared, usageId };
      };
      try {
        if (input.isFinal) return await this.drawing.finish(approve);
        const approved = await this.transactions.run(approve);
        return approved.prepared.commit(approved.usageId);
      } catch (error) {
        // 최초 사용 COMMIT의 응답만 유실돼도 유일한 획을 잃지 않도록 실제 기록을 확인한다.
        if (!input.isFinal && prepared && approvedUsageId && approvedUserId) {
          const recovered = await this.drawing.recoverCommit(
            prepared,
            approvedUsageId,
            false,
            () =>
              this.usages.recordedMain(
                approvedUserId!,
                input.clientStrokeId,
                approvedUsageId!,
              ),
          );
          if (recovered) return recovered;
        }
        throw error;
      } finally {
        if (!prepared?.deferred) prepared?.cancel();
      }
    });
  }
}
