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
} from '../../resources/season/season';
import { SeasonRepository } from '../../resources/season/season.repository';

const READ_COMMITTED = { isolationLevel: 'read committed' } as const;

@Injectable()
export class EndSeasonUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly seasons: SeasonRepository,
    private readonly drawing: CanvasDrawing,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 개설자 사전 확인 뒤 canvas gate에서 승인 좌표를 저장하고 진행 중 시즌을 종료한다. */
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

    // 존재하지 않거나 비개설자인 요청이 임의 시즌의 입력 gate를 막지 못하게 먼저 확인한다.
    await this.preflight(token, seasonId);
    return this.drawing.withLifecycle(seasonId, {
      kind: 'end',
      apply: () => this.apply(token, seasonId),
      // 장기 recovery에는 인증 token을 보관하지 않고 DB lifecycle 사실만 다시 읽는다.
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

  /** drain 완료 뒤 새 transaction에서 권한과 active 상태를 다시 검사해 강제 종료를 커밋한다. */
  private async apply(
    token: string | undefined,
    seasonId: string,
  ): Promise<{ result: SeasonDetail; state: LifecycleSnapshot }> {
    let forceEndObserved = false;
    try {
      return await this.transactions.run(async (transaction) => {
        // 사용자·세션 잠금 뒤 시즌 행을 잠그고, 잠금 대기 뒤 최신 사실과 DB 시각을 다시 읽는다.
        const userId = await this.authenticate(token, transaction);
        const locked = await this.seasons.lockById(seasonId, transaction);
        if (!locked) throw new BusinessError(ErrorCodes.SeasonNotFound);
        const state = await this.seasons.readLifecycle(seasonId, transaction);
        if (!state) throw new BusinessError(ErrorCodes.SeasonNotFound);
        const season = await this.seasons.findById(seasonId, transaction);
        if (!season) throw new BusinessError(ErrorCodes.SeasonNotFound);
        if (state.creatorId !== userId)
          throw new BusinessError(ErrorCodes.SeasonOwnerRequired);

        // 저장된 강제 종료 표식만 멱등 성공으로 인정하고 자연 종료·취소·예약은 409를 유지한다.
        if (state.forceEndedAt !== null) {
          forceEndObserved = true;
          return {
            result: toSeasonDetail(season, state.observedAt, {
              userId,
              isParticipant: true,
            }),
            state,
          };
        }
        if (getSeasonStatus(state, state.observedAt) !== 'active')
          throw new BusinessError(ErrorCodes.SeasonStateConflict);

        const forceEndedAt = await this.seasons.markForceEnded(
          seasonId,
          state.observedAt,
          transaction,
        );
        forceEndObserved = true;
        return {
          result: toSeasonDetail(
            { ...season, forceEndedAt },
            state.observedAt,
            { userId, isParticipant: true },
          ),
          state: { ...state, forceEndedAt },
        };
      }, READ_COMMITTED);
    } catch (error) {
      // UPDATE 또는 멱등 조회 뒤 COMMIT 응답만 유실됐다면 primary 표식과 현재 인증으로 응답을 복구한다.
      if (forceEndObserved) {
        const state = await this.inspect(seasonId);
        if (state.forceEndedAt !== null) {
          return {
            result: await this.readOwnedDetail(token, seasonId),
            state,
          };
        }
      }
      throw error;
    }
  }

  /** 실패한 연결 반환 뒤 새 transaction에서 시즌 잠금과 별도 사실·시각 SELECT를 실행한다. */
  private inspect(seasonId: string): Promise<LifecycleSnapshot> {
    return this.transactions.run(async (transaction) => {
      const locked = await this.seasons.lockById(seasonId, transaction);
      if (!locked) throw new BusinessError(ErrorCodes.SeasonNotFound);
      const state = await this.seasons.readLifecycle(seasonId, transaction);
      if (!state) throw new BusinessError(ErrorCodes.SeasonNotFound);
      return state;
    }, READ_COMMITTED);
  }

  /** 확인된 강제 종료 성공만 현재 세션과 소유권을 다시 검증해 상세로 반환한다. */
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
}
