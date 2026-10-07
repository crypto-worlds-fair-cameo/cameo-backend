import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type {
  NormalizedSeasonInput,
  SeasonRecord,
  SeasonStatus,
} from './season';

export type SeasonListStatus = Exclude<SeasonStatus, 'cancelled'>;

export type SeasonLifecycleFacts = Readonly<
  Pick<
    SeasonRecord,
    'creatorId' | 'startsAt' | 'endsAt' | 'cancelledAt' | 'forceEndedAt'
  > & { observedAt: Date }
>;

export type ListSeasonsInput = Readonly<{
  now: Date;
  status?: SeasonListStatus;
  limit: number;
  offset: number;
}>;

type SeasonWriteInput = Pick<
  NormalizedSeasonInput,
  'title' | 'description' | 'capacity'
>;

@Injectable()
export class SeasonRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 개설자 잠금 뒤 같은 DB 시각을 사용해 아직 대기·진행 중인 시즌 수를 센다. */
  async countOpenByCreator(
    creatorId: string,
    now: Date,
    transaction: TransactionContext,
  ): Promise<number> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      count: number;
    }>(
      `SELECT count(*)::integer AS count
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
       WHERE s.creator_id = $1
         AND s.cancelled_at IS NULL AND s.force_ended_at IS NULL
         AND $2::timestamptz < c.ends_at`,
      [creatorId, now],
    );
    return result.rows[0].count;
  }

  /** 정규화한 공개 설정을 호출자의 캔버스와 개설자에 연결해 저장한다. */
  async insert(
    canvasId: string,
    creatorId: string,
    input: SeasonWriteInput,
    time: Date,
    transaction: TransactionContext,
  ): Promise<void> {
    await getPgExecutor(this.pool, transaction).query(
      `INSERT INTO seasons
         (canvas_id, creator_id, title, description, capacity, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        canvasId,
        creatorId,
        input.title,
        input.description,
        input.capacity,
        time,
      ],
    );
  }

  /** 시즌 생성 트랜잭션에서 개설자를 최초 참가자로 한 번 등록한다. */
  async addCreatorParticipant(
    seasonId: string,
    creatorId: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<void> {
    await getPgExecutor(this.pool, transaction).query(
      `INSERT INTO season_participants (season_id, user_id, joined_at)
       VALUES ($1, $2, $3)`,
      [seasonId, creatorId, time],
    );
  }

  /** 잠근 시즌의 참가 수와 현재 사용자 참가 여부를 같은 스냅샷에서 읽는다. */
  async readParticipation(
    seasonId: string,
    userId: string,
    transaction: TransactionContext,
  ): Promise<{ isParticipant: boolean; participantCount: number }> {
    // 시즌 행 잠금이 끝난 다음 별도 문장으로 실행해 잠금 대기 중 커밋된 참가를 읽는다.
    const result = await getPgExecutor(this.pool, transaction).query<{
      isParticipant: boolean;
      participantCount: number;
    }>(
      `SELECT count(*)::integer AS "participantCount",
              COALESCE(bool_or(user_id = $2::uuid), false) AS "isParticipant"
       FROM season_participants WHERE season_id = $1`,
      [seasonId, userId],
    );
    return result.rows[0];
  }

  /** 참가 승인 시각과 사용자 ID를 잠근 시즌의 참가 기록으로 저장한다. */
  async addParticipant(
    seasonId: string,
    userId: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<void> {
    await getPgExecutor(this.pool, transaction).query(
      `INSERT INTO season_participants (season_id, user_id, joined_at)
       VALUES ($1, $2, $3)`,
      [seasonId, userId, time],
    );
  }

  /** 공개·선택 인증 조회에서 시즌과 캔버스 설정 및 누적 참가자 수를 한 번에 읽는다. */
  findById(
    id: string,
    transaction?: TransactionContext,
  ): Promise<SeasonRecord | undefined> {
    return this.readById(id, transaction, false);
  }

  /** 상태 변경 전에 시즌 행을 잠그며, 잠금 대기 뒤 시각 판정은 별도 쿼리에서 수행한다. */
  lockById(
    id: string,
    transaction: TransactionContext,
  ): Promise<SeasonRecord | undefined> {
    return this.readById(id, transaction, true);
  }

  /** 앞선 행 잠금이 끝난 뒤 lifecycle 판정과 저장에 쓸 실제 DB 시각을 가져온다. */
  async getCurrentTime(transaction: TransactionContext): Promise<Date> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      time: Date;
    }>("SELECT date_trunc('milliseconds', clock_timestamp()) AS time");
    return result.rows[0].time;
  }

  /** 시즌 행 잠금 뒤 표식과 DB 시각을 한 새 statement snapshot에서 함께 읽는다. */
  async readLifecycle(
    id: string,
    transaction: TransactionContext,
  ): Promise<SeasonLifecycleFacts | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SeasonLifecycleFacts>(
      `SELECT s.creator_id AS "creatorId", c.starts_at AS "startsAt",
              c.ends_at AS "endsAt", s.cancelled_at AS "cancelledAt",
              s.force_ended_at AS "forceEndedAt",
              date_trunc('milliseconds', clock_timestamp()) AS "observedAt"
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
       WHERE s.canvas_id = $1 AND s.canvas_type = 'season'`,
      [id],
    );
    return result.rows[0];
  }

  /** 잠근 시즌의 최초 취소 시각을 저장하고 DB가 확정한 값을 반환한다. */
  async markCancelled(
    id: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<Date> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      cancelledAt: Date;
    }>(
      `UPDATE seasons SET cancelled_at = $2
       WHERE canvas_id = $1
         AND cancelled_at IS NULL AND force_ended_at IS NULL
       RETURNING cancelled_at AS "cancelledAt"`,
      [id, time],
    );
    const cancelledAt = result.rows[0]?.cancelledAt;
    if (!cancelledAt) throw new Error('Season cancellation update failed.');
    return cancelledAt;
  }

  /** 잠근 시즌의 최초 강제 종료 시각을 저장하고 예정 종료 시각은 유지한다. */
  async markForceEnded(
    id: string,
    time: Date,
    transaction: TransactionContext,
  ): Promise<Date> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      forceEndedAt: Date;
    }>(
      `UPDATE seasons SET force_ended_at = $2
       WHERE canvas_id = $1
         AND cancelled_at IS NULL AND force_ended_at IS NULL
       RETURNING force_ended_at AS "forceEndedAt"`,
      [id, time],
    );
    const forceEndedAt = result.rows[0]?.forceEndedAt;
    if (!forceEndedAt) throw new Error('Season force-end update failed.');
    return forceEndedAt;
  }

  /** 취소 시즌을 제외하고 같은 판정 시각으로 상태를 거른 뒤 안정된 생성 역순으로 읽는다. */
  async list(
    input: ListSeasonsInput,
    transaction?: TransactionContext,
  ): Promise<SeasonRecord[]> {
    this.assertListInput(input);
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SeasonRecord>(
      `WITH candidates AS MATERIALIZED (
         SELECT s.canvas_id, s.creator_id, s.title, s.description,
                s.capacity, s.cancelled_at, s.force_ended_at, s.created_at,
                c.width, c.height, c.stroke_limit_per_user,
                c.starts_at, c.ends_at
         FROM seasons s
         JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
         WHERE s.cancelled_at IS NULL
           AND (
             $2::text IS NULL
             OR CASE
               WHEN s.force_ended_at IS NOT NULL
                 OR $1::timestamptz >= c.ends_at THEN 'ended'
               WHEN $1::timestamptz < c.starts_at THEN 'scheduled'
               ELSE 'active'
             END = $2::text
           )
         ORDER BY s.created_at DESC, s.canvas_id DESC
         LIMIT $3 OFFSET $4
       ), participant_counts AS (
         SELECT p.season_id, count(*)::integer AS count
         FROM season_participants p
         JOIN candidates c ON c.canvas_id = p.season_id
         GROUP BY p.season_id
       )
       SELECT c.canvas_id AS id, c.creator_id AS "creatorId",
              c.title, c.description, c.width, c.height,
              c.stroke_limit_per_user AS "strokeLimitPerUser",
              c.capacity, COALESCE(p.count, 0)::integer AS "participantCount",
              c.starts_at AS "startsAt", c.ends_at AS "endsAt",
              c.cancelled_at AS "cancelledAt",
              c.force_ended_at AS "forceEndedAt",
              c.created_at AS "createdAt"
       FROM candidates c
       LEFT JOIN participant_counts p ON p.season_id = c.canvas_id
       ORDER BY c.created_at DESC, c.canvas_id DESC`,
      [input.now, input.status ?? null, input.limit + 1, input.offset],
    );
    return result.rows;
  }

  /** 목록의 시즌 ID를 한 번에 조회해 현재 사용자가 참가한 시즌만 반환한다. */
  async findParticipatingIds(
    userId: string,
    seasonIds: readonly string[],
    transaction?: TransactionContext,
  ): Promise<Set<string>> {
    // 빈 목록은 uuid[] 파라미터 쿼리 없이 빈 참가 집합을 반환한다.
    if (seasonIds.length === 0) return new Set();
    const result = await getPgExecutor(this.pool, transaction).query<{
      seasonId: string;
    }>(
      `SELECT season_id AS "seasonId" FROM season_participants
       WHERE user_id = $1 AND season_id = ANY($2::uuid[])`,
      [userId, seasonIds],
    );
    return new Set(result.rows.map((row) => row.seasonId));
  }

  private async readById(
    id: string,
    transaction: TransactionContext | undefined,
    lock: boolean,
  ): Promise<SeasonRecord | undefined> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SeasonRecord>(
      `SELECT s.canvas_id AS id, s.creator_id AS "creatorId",
              s.title, s.description, c.width, c.height,
              c.stroke_limit_per_user AS "strokeLimitPerUser",
              s.capacity,
              (SELECT count(*)::integer FROM season_participants p
               WHERE p.season_id = s.canvas_id) AS "participantCount",
              c.starts_at AS "startsAt", c.ends_at AS "endsAt",
              s.cancelled_at AS "cancelledAt",
              s.force_ended_at AS "forceEndedAt",
              s.created_at AS "createdAt"
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
       WHERE s.canvas_id = $1
       ${lock ? 'FOR UPDATE OF s' : ''}`,
      [id],
    );
    return result.rows[0];
  }

  private assertListInput(input: ListSeasonsInput): void {
    const validStatus =
      input.status === undefined ||
      input.status === 'scheduled' ||
      input.status === 'active' ||
      input.status === 'ended';
    if (
      !Number.isFinite(input.now.getTime()) ||
      !validStatus ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.offset + input.limit + 1)
    ) {
      throw new RangeError('Season list query is invalid.');
    }
  }
}
