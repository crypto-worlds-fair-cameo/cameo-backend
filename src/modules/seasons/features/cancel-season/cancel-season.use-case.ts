import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import {
  CanvasDrawing,
  type LifecycleSnapshot,
} from '../../../canvas/resources/canvas-drawing/canvas-drawing';
import {
  getSeasonStatus,
  toSeasonDetail,
  type SeasonDetail,
  type SeasonRecord,
} from '../../resources/season/season';
import { SeasonRepository } from '../../resources/season/season.repository';

const READ_COMMITTED = { isolationLevel: 'read committed' } as const;

@Injectable()
export class CancelSeasonUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly seasons: SeasonRepository,
    private readonly drawing: CanvasDrawing,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 개설자 사전 확인 뒤 canvas gate에서 예약 시즌을 취소하고 관람 공개범위를 함께 전환한다. */
  async execute(
    origin: string | undefined,
    token: string | undefined,
    seasonId: string,
  ): Promise<SeasonDetail> {
    // 쿠키를 사용하는 쓰기 요청이므로 DB 작업 전에 허용된 브라우저 출처인지 확인한다.
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );

    // 존재하지 않거나 비개설자인 요청이 임의 시즌의 공개 gate를 막지 못하게 먼저 확인한다.
    await this.preflight(token, seasonId);
    return this.drawing.withLifecycle(seasonId, {
      kind: 'cancel',
      apply: () => this.apply(token, seasonId),
      // recovery closure에는 인증 token을 보관하지 않고 DB lifecycle 사실만 다시 읽는다.
      inspect: () => this.inspect(seasonId),
    });
  }

  private async preflight(
    token: string | undefined,
    seasonId: string,
  ): Promise<void> {
    await this.transactions.run(async (transaction) => {
      const userId = await this.authenticate(token, transaction);
      const season = await this.seasons.findById(seasonId, transaction);
      if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
      if (season.creatorId !== userId)
        throw new BusinessError(ErrorCodes.SeasonOwnerRequired);
    }, READ_COMMITTED);
  }

  /** gate 안의 새 transaction에서 권한과 scheduled 상태를 다시 검사해 취소를 커밋한다. */
  private async apply(
    token: string | undefined,
    seasonId: string,
  ): Promise<{ result: SeasonDetail; state: LifecycleSnapshot }> {
    let cancellationWritten = false;
    try {
      return await this.transactions.run(async (transaction) => {
        // 사용자·세션 잠금 뒤 시즌 행을 잠그고 별도 DB 시각 SELECT로 경계를 판정한다.
        const userId = await this.authenticate(token, transaction);
        const locked = await this.seasons.lockById(seasonId, transaction);
        if (!locked) throw new BusinessError(ErrorCodes.SeasonNotFound);
        // 잠금 대기 뒤 별도 SELECT로 최신 취소·종료 표식과 상세를 다시 읽는다.
        const season = await this.seasons.findById(seasonId, transaction);
        if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
        const observedAt = await this.seasons.getCurrentTime(transaction);
        if (season.creatorId !== userId)
          throw new BusinessError(ErrorCodes.SeasonOwnerRequired);

        const state = this.snapshot(season, observedAt);
        const status = getSeasonStatus(state, observedAt);
        // 같은 개설자의 취소 재요청은 최초 취소 시각과 기존 상세를 그대로 반환한다.
        if (status === 'cancelled') {
          return {
            result: toSeasonDetail(season, observedAt, {
              userId,
              isParticipant: true,
            }),
            state,
          };
        }
        if (status !== 'scheduled')
          throw new BusinessError(ErrorCodes.SeasonStateConflict);

        const cancelledAt = await this.seasons.markCancelled(
          seasonId,
          observedAt,
          transaction,
        );
        cancellationWritten = true;
        return {
          result: toSeasonDetail({ ...season, cancelledAt }, observedAt, {
            userId,
            isParticipant: true,
          }),
          state: { ...state, cancelledAt },
        };
      }, READ_COMMITTED);
    } catch (error) {
      // UPDATE 뒤 COMMIT 응답만 유실됐다면 primary 표식을 확인하고 정상 상세를 재구성한다.
      if (cancellationWritten) {
        const state = await this.inspect(seasonId);
        if (state.cancelledAt !== null) {
          return {
            result: await this.readOwnedDetail(token, seasonId),
            state,
          };
        }
      }
      throw error;
    }
  }

  /** 실패한 연결 반환 뒤 새 transaction에서 시즌 잠금과 별도 시각 SELECT로 확정 상태를 읽는다. */
  private inspect(seasonId: string): Promise<LifecycleSnapshot> {
    return this.transactions.run(async (transaction) => {
      const locked = await this.seasons.lockById(seasonId, transaction);
      if (!locked) throw new BusinessError(ErrorCodes.SeasonNotFound);
      // 실패한 COMMIT과 잠금이 정리된 뒤 별도 SELECT가 primary의 확정 표식을 읽는다.
      const state = await this.seasons.readLifecycle(seasonId, transaction);
      if (!state) throw new BusinessError(ErrorCodes.SeasonNotFound);
      return state;
    }, READ_COMMITTED);
  }

  /** 확인된 취소 성공 응답만 현재 세션과 소유권을 다시 검증해 반환한다. */
  private readOwnedDetail(
    token: string | undefined,
    seasonId: string,
  ): Promise<SeasonDetail> {
    return this.transactions.run(async (transaction) => {
      const userId = await this.authenticate(token, transaction);
      const season = await this.seasons.findById(seasonId, transaction);
      if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
      if (season.creatorId !== userId)
        throw new BusinessError(ErrorCodes.SeasonOwnerRequired);
      const observedAt = await this.seasons.getCurrentTime(transaction);
      return toSeasonDetail(season, observedAt, {
        userId,
        isParticipant: true,
      });
    }, READ_COMMITTED);
  }

  private async authenticate(
    token: string | undefined,
    transaction: TransactionContext,
  ): Promise<string> {
    const authentication = await this.authenticator.authenticate(
      token,
      transaction,
    );
    if (authentication.outcome !== 'authenticated')
      throw new BusinessError(
        authentication.outcome === 'invalid'
          ? ErrorCodes.AuthSessionInvalid
          : ErrorCodes.AuthUserUnavailable,
      );
    return authentication.user.id;
  }

  private snapshot(season: SeasonRecord, observedAt: Date): LifecycleSnapshot {
    return {
      creatorId: season.creatorId,
      startsAt: season.startsAt,
      endsAt: season.endsAt,
      cancelledAt: season.cancelledAt,
      forceEndedAt: season.forceEndedAt,
      observedAt,
    };
  }
}
