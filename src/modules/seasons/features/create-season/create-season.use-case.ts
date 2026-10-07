import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessError } from '@/business-error';
import { ErrorCodes } from '@/errors/error-codes';
import type { AllConfigType } from '../../../../config/config.type';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { assertAuthOrigin } from '../../../auth/resources/auth-origin/auth-origin';
import { CanvasDefinition } from '../../../canvas/resources/canvas-definition/canvas-definition';
import {
  normalizeSeasonInput,
  toSeasonDetail,
  type CreateSeasonInput,
  type SeasonDetail,
} from '../../resources/season/season';
import { SeasonRepository } from '../../resources/season/season.repository';

const MAX_OPEN_SEASONS_PER_CREATOR = 3;

@Injectable()
export class CreateSeasonUseCase {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    private readonly authenticator: SessionAuthenticator,
    private readonly canvases: CanvasDefinition,
    private readonly seasons: SeasonRepository,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 인증한 사용자의 공개 시즌과 최초 참가 기록을 하나의 트랜잭션으로 생성한다. */
  async execute(
    origin: string | undefined,
    token: string | undefined,
    input: CreateSeasonInput,
  ): Promise<SeasonDetail> {
    // 쿠키를 사용하는 쓰기 요청이므로 DB 작업 전에 허용된 브라우저 출처인지 확인한다.
    assertAuthOrigin(
      origin,
      this.config.getOrThrow('cors.originList', { infer: true }),
    );

    return this.transactions.run(async (transaction) => {
      // 사용자와 세션을 잠근 뒤 얻은 DB 시각을 입력 경계와 모든 생성 시각에 사용한다.
      const authentication = await this.authenticator.authenticate(
        token,
        transaction,
      );
      if (authentication.outcome !== 'authenticated') {
        throw new BusinessError(
          authentication.outcome === 'invalid'
            ? ErrorCodes.AuthSessionInvalid
            : ErrorCodes.AuthUserUnavailable,
        );
      }
      const { time, user } = authentication;
      const normalized = normalizeSeasonInput(input, time);

      // 사용자 행 잠금이 유지되는 동안 현재 열린 시즌 수를 확인해 동시 생성도 3개를 넘지 못한다.
      const openCount = await this.seasons.countOpenByCreator(
        user.id,
        time,
        transaction,
      );
      if (openCount >= MAX_OPEN_SEASONS_PER_CREATOR) {
        throw new BusinessError(ErrorCodes.SeasonActiveLimitReached);
      }

      // 캔버스·시즌·개설자 참가 기록은 같은 트랜잭션과 같은 DB 시각을 공유한다.
      const canvasId = await this.canvases.createSeason(
        { ...normalized, createdAt: time },
        transaction,
      );
      await this.seasons.insert(
        canvasId,
        user.id,
        normalized,
        time,
        transaction,
      );
      await this.seasons.addCreatorParticipant(
        canvasId,
        user.id,
        time,
        transaction,
      );

      // 저장 결과에서 참가 인원과 DB 필드를 다시 읽어 커밋 후 반환할 응답을 만든다.
      const season = await this.seasons.findById(canvasId, transaction);
      if (!season) throw new Error('Created season is missing.');
      return toSeasonDetail(season, time, {
        userId: user.id,
        isParticipant: true,
      });
    });
  }
}
