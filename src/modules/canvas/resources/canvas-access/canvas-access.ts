import { Injectable } from '@nestjs/common';
import { SessionAuthenticator } from '../../../auth/resources/session/session-authenticator';
import { isAuthSecret } from '../../../auth/resources/auth-secret/auth-secret';
import {
  authCookies,
  readAuthCookie,
} from '../../../auth/resources/auth-cookie/auth-http';
import { ConfigService } from '@nestjs/config';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { CanvasStrokeError } from '../canvas-stroke/canvas-stroke';
import type { CanvasTarget } from '../canvas-definition/canvas-target';
import { DEFAULT_RUNTIME_LIMITS } from '../../../../config/realtime.config';
import {
  getSeasonStatus,
  type SeasonStatus,
} from '../../../seasons/resources/season/season-state';
import {
  SeasonCanvasQuery,
  type SeasonCanvasFacts,
} from './season-canvas-query';

export type CanvasViewer =
  | { status: 'guest'; userId: null }
  | { status: 'authenticated'; userId: string };

export type CanvasViewerAccess = Readonly<{
  viewer: CanvasViewer;
  canDraw: boolean;
  season?: SeasonCanvasFacts &
    Readonly<{
      status: SeasonStatus;
      isCreator: boolean;
    }>;
}>;

export type SeasonAppendAdmission = Readonly<{
  userId: string;
  status: SeasonStatus;
  isParticipant: boolean;
}>;

/** 소켓 handshake 쿠키를 기존 AuthModule의 세션 규칙으로 인증한다. */
@Injectable()
export class CanvasAccess {
  private readonly cookieName: string;
  private readonly seasonDrawingEnabled: boolean;
  constructor(
    config: ConfigService,
    private readonly authenticator: SessionAuthenticator,
    private readonly transactions: TransactionRunner,
    private readonly seasons: SeasonCanvasQuery,
  ) {
    this.cookieName = authCookies(config.getOrThrow('app.nodeEnv')).sessionName;
    this.seasonDrawingEnabled =
      config.get<boolean>('realtime.seasonDrawingEnabled') ??
      DEFAULT_RUNTIME_LIMITS.seasonDrawingEnabled;
  }

  token(cookieHeader: string | undefined): string | undefined {
    return readAuthCookie(cookieHeader, this.cookieName);
  }

  /** 접속 상태는 안내 값이며, 실제 획의 시작과 완료에서 세션을 다시 확인한다. */
  async viewer(
    cookieHeader: string | undefined,
    target?: CanvasTarget,
  ): Promise<CanvasViewerAccess> {
    const token = this.token(cookieHeader);
    // main은 기존 선택 인증 결과와 canDraw 의미를 그대로 유지한다.
    if (target?.kind !== 'season' && !isAuthSecret(token))
      return { viewer: { status: 'guest', userId: null }, canDraw: false };
    return this.transactions.run(async (transaction) => {
      const result = await this.authenticator.authenticate(token, transaction);
      // 유효하지 않은 쿠키는 관람 접속을 막지 않는다.
      const viewer: CanvasViewer =
        result.outcome === 'authenticated'
          ? { status: 'authenticated', userId: result.user.id }
          : { status: 'guest', userId: null };
      if (target?.kind !== 'season')
        return { viewer, canDraw: viewer.status === 'authenticated' };

      const season = await this.seasons.observe(
        target.id,
        viewer.userId ?? undefined,
        transaction,
      );
      if (!season)
        throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
      const isCreator = viewer.userId === season.creatorId;
      // 취소한 시즌은 개설자에게만 읽기 전용으로 남기고 존재 자체를 숨긴다.
      if (season.cancelledAt !== null && !isCreator)
        throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
      return {
        viewer,
        canDraw: this.canDrawSeason(viewer.userId ?? undefined, {
          ...season,
          status: getSeasonStatus(season, season.observedAt),
        }),
        season: {
          ...season,
          status: getSeasonStatus(season, season.observedAt),
          isCreator,
        },
      };
    });
  }

  /** 시즌 쓰기 flag가 꺼져 있으면 인증·DB 승인 전에 좌표 요청을 거절한다. */
  assertSeasonDrawingEnabled(): void {
    if (!this.seasonDrawingEnabled)
      throw new CanvasStrokeError(
        'SEASON_DRAWING_DISABLED',
        'Season drawing is not enabled.',
      );
  }

  /** ready의 canDraw는 최신 상태·참가·인증과 현재 쓰기 flag를 모두 만족할 때만 true다. */
  canDrawSeason(
    userId: string | undefined,
    season: Pick<
      NonNullable<CanvasViewerAccess['season']>,
      'status' | 'isParticipant'
    >,
  ): boolean {
    return (
      this.seasonDrawingEnabled &&
      userId !== undefined &&
      season.status === 'active' &&
      season.isParticipant
    );
  }

  /** 시즌 append transaction에서 세션과 사용자·시즌 행을 잠근 뒤 최신 참가·상태를 반환한다. */
  async authorizeSeasonAppend(
    target: CanvasTarget,
    token: string | undefined,
    expectedUserId: string,
    transaction: TransactionContext,
  ): Promise<SeasonAppendAdmission> {
    const userId = await this.authenticate(token, transaction);
    // prepare에 사용한 사전 인증 사용자와 잠금 후 실제 세션 사용자가 다르면 획을 공개하지 않는다.
    if (userId !== expectedUserId)
      throw new CanvasStrokeError(
        'AUTH_REQUIRED',
        'Authentication is required.',
      );

    const exists = await this.seasons.lock(target.id, transaction);
    if (!exists)
      throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
    const season = await this.seasons.admission(target.id, userId, transaction);
    if (!season)
      throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');

    // 취소 방은 개설자 외 사용자에게 존재를 숨기고, 개설자에게는 종료 상태로 응답한다.
    if (season.cancelledAt !== null && season.creatorId !== userId)
      throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
    return {
      userId,
      status: getSeasonStatus(season, season.observedAt),
      isParticipant: season.isParticipant,
    };
  }

  /** 연결 gate 안에서 최신 공개범위를 다시 확인할 lifecycle 사실을 읽는다. */
  async season(
    canvasId: string,
    userId: string | undefined,
  ): Promise<NonNullable<CanvasViewerAccess['season']>> {
    const season = await this.seasons.observe(canvasId, userId);
    if (!season)
      throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
    // 취소 확정 뒤에는 개설자 외 연결이 room 합류를 완료하지 못하게 한다.
    if (season.cancelledAt !== null && season.creatorId !== userId)
      throw new CanvasStrokeError('CANVAS_NOT_FOUND', 'Canvas not found.');
    return {
      ...season,
      status: getSeasonStatus(season, season.observedAt),
      isCreator: season.creatorId === userId,
    };
  }

  /** 시작과 완료 전송에서만 기존 세션을 다시 확인하고 인증된 사용자 ID를 반환한다. */
  async authenticate(
    token: string | undefined,
    transaction?: TransactionContext,
  ): Promise<string> {
    // 쿠키가 없거나 형식이 틀리면 DB 트랜잭션을 열지 않고 거절한다.
    if (!isAuthSecret(token))
      throw new CanvasStrokeError(
        'AUTH_REQUIRED',
        'Authentication is required.',
      );
    const authenticate = async (
      context: TransactionContext,
    ): Promise<string> => {
      const result = await this.authenticator.authenticate(token, context);
      if (result.outcome !== 'authenticated')
        throw new CanvasStrokeError(
          result.outcome === 'unavailable'
            ? 'USER_UNAVAILABLE'
            : 'AUTH_REQUIRED',
          result.outcome === 'unavailable'
            ? 'User is unavailable.'
            : 'Authentication is required.',
        );
      return result.user.id;
    };
    // 첫 좌표의 인증과 획 차감은 같은 사용자 잠금을 유지하며 함께 커밋한다.
    return transaction
      ? authenticate(transaction)
      : this.transactions.run(authenticate);
  }
}
