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
import type { CanvasTarget } from '../../resources/canvas-definition/canvas-target';

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
    target?: CanvasTarget,
  ): Promise<AppendStrokeResult> {
    if (target?.kind === 'season')
      return this.executeSeason(connectionId, token, input, target);
    return this.executeMain(connectionId, token, input);
  }

  /** main은 기존 중간 인증 cache와 consumeMain/completeMain/recordedMain 경로를 유지한다. */
  private executeMain(
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

  /** 시즌 좌표는 매 조각 최신 세션·참가·DB 시각을 확인하고 승인된 결과만 runtime에 공개한다. */
  private executeSeason(
    connectionId: string,
    token: string | undefined,
    input: AppendStrokeInput,
    target: CanvasTarget,
  ): Promise<AppendStrokeResult> {
    this.access.assertSeasonDrawingEnabled();
    return this.drawing.withCanvas(target, async (runtime) => {
      // prepare가 사용할 사용자 ID는 짧은 인증 transaction에서 읽고 모든 잠금을 먼저 해제한다.
      const expectedUserId = await this.access.authenticate(token);
      const prepare = () =>
        runtime.prepare(connectionId, expectedUserId, input);

      const approve = async (
        candidate: PreparedStroke,
        transaction: TransactionContext,
      ): Promise<string> => {
        const admission = await this.access.authorizeSeasonAppend(
          target,
          token,
          expectedUserId,
          transaction,
        );
        // 종료·취소를 잠금 뒤 확인하면 같은 gate의 이후 입력도 즉시 읽기 전용으로 전환한다.
        if (admission.status !== 'active') {
          if (admission.status === 'ended' || admission.status === 'cancelled')
            runtime.markClosed();
          throw new CanvasStrokeError(
            'SEASON_NOT_ACTIVE',
            'Season is not active.',
          );
        }
        if (!admission.isParticipant)
          throw new CanvasStrokeError(
            'SEASON_PARTICIPATION_REQUIRED',
            'Join the season before drawing.',
          );
        // 첫 묶음만 획 사용을 만들고 중간·재전송은 준비 단계에서 찾은 usage를 그대로 쓴다.
        const usageId =
          candidate.usageId ??
          (await this.usages.consume(
            target.id,
            admission.userId,
            input.clientStrokeId,
            target.strokeLimitPerUser,
            transaction,
          ));
        if (input.isFinal && candidate.accepted)
          await this.usages.complete(
            target.id,
            admission.userId,
            input.clientStrokeId,
            transaction,
          );
        return usageId;
      };

      // final은 storage lane을 한 번만 잡아 이전 queue와 마지막 청크를 순서대로 저장한다.
      if (input.isFinal) return runtime.finishPrepared(prepare, approve);

      let prepared: PreparedStroke | undefined;
      let approvedUsageId: string | undefined;
      let consumedUsage = false;
      try {
        prepared = await prepare();
        const usageId = await this.transactions.run(
          async (transaction) => {
            const createsUsage = prepared!.usageId === undefined;
            const result = await approve(prepared!, transaction);
            approvedUsageId = result;
            consumedUsage = createsUsage;
            return result;
          },
          { isolationLevel: 'read committed' },
        );
        return prepared.commit(usageId);
      } catch (error) {
        // 첫 usage COMMIT 유실은 다른 캔버스의 같은 strokeId가 아닌 이 canvas 기록으로만 확인한다.
        if (prepared && approvedUsageId && consumedUsage) {
          const recovered = await runtime.recoverCommit(
            prepared,
            approvedUsageId,
            false,
            () =>
              this.usages.recorded(
                target.id,
                expectedUserId,
                input.clientStrokeId,
                approvedUsageId!,
              ),
          );
          if (recovered) return recovered;
        }
        throw error;
      } finally {
        // 결과 미확정 recovery만 예약을 이어받고 확정 실패는 pending 예산을 반환한다.
        if (!prepared?.deferred) prepared?.cancel();
      }
    });
  }
}
