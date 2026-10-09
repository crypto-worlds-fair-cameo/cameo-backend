import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import type { CanvasTarget } from '../canvas-definition/canvas-target';
import {
  CanvasSnapshotPublicationRejected,
  type CanvasSnapshotPublishInput,
  type CanvasSnapshotRecord,
} from './canvas-snapshot';

type SnapshotRow = {
  id: string;
  canvas_id: string;
  canvas_type?: 'main' | 'season';
  through_sequence: string;
  renderer_version: string;
  width: number;
  height: number;
  status: 'READY' | 'INVALID';
  is_final: boolean;
  image_key: string;
  continuation_key: string;
  image_bytes: string;
  continuation_bytes: string;
  image_sha256: string;
  continuation_sha256: string;
  continuation_schema_version: number;
  captured_at: Date;
  created_at: Date;
};

type TargetRow = {
  id: string;
  type: 'main' | 'season';
  width: number;
  height: number;
  stroke_limit_per_user: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
};

type HistoryRow = {
  accessible_canvas_id: string;
  id: string | null;
  image_key: string | null;
  width: number | null;
  height: number | null;
  is_final: boolean | null;
  captured_at: Date | null;
  captured_at_cursor: string | null;
};

export type CanvasSnapshotHistoryCursor = Readonly<{
  capturedAt: string;
  id: string;
}>;

export type CanvasSnapshotHistoryRecord = Readonly<{
  id: string;
  imageKey: string;
  width: number;
  height: number;
  isFinal: boolean;
  capturedAt: Date;
  cursorCapturedAt: string;
}>;

export type CanvasSnapshotHistoryPage = Readonly<{
  canvasExists: boolean;
  records: CanvasSnapshotHistoryRecord[];
}>;

const SNAPSHOT_COLUMNS = `
  id, canvas_id, through_sequence, renderer_version, width, height,
  status, is_final, image_key, continuation_key, image_bytes,
  continuation_bytes, image_sha256, continuation_sha256,
  continuation_schema_version, captured_at, created_at`;

function toTarget(row: TargetRow): CanvasTarget {
  return {
    id: row.id,
    key: row.type === 'main' ? 'main' : `season:${row.id.toLowerCase()}`,
    kind: row.type,
    width: row.width,
    height: row.height,
    strokeLimitPerUser: row.stroke_limit_per_user,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

function toSnapshot(
  row: SnapshotRow,
  target?: CanvasTarget,
): CanvasSnapshotRecord {
  const kind = target?.kind ?? row.canvas_type;
  if (!kind) throw new Error('Canvas snapshot row is missing its canvas type.');
  return {
    id: row.id,
    canvasId: row.canvas_id,
    canvasKey:
      target?.key ??
      (kind === 'main' ? 'main' : `season:${row.canvas_id.toLowerCase()}`),
    throughSequence: row.through_sequence,
    rendererVersion: row.renderer_version,
    width: row.width,
    height: row.height,
    status: row.status,
    isFinal: row.is_final,
    imageKey: row.image_key,
    continuationKey: row.continuation_key,
    imageBytes: row.image_bytes,
    continuationBytes: row.continuation_bytes,
    imageSha256: row.image_sha256,
    continuationSha256: row.continuation_sha256,
    continuationSchemaVersion: row.continuation_schema_version,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
  };
}

/** 스냅샷 저장소는 캡처 대상 탐색과 READY 메타데이터의 원자적 공개를 소유한다. */
@Injectable()
export class CanvasSnapshotRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly transactions: TransactionRunner,
  ) {}

  /** 조회자에게 공개된 캔버스의 READY 스냅샷을 캡처 시각과 ID 기준 최신순으로 반환한다. */
  async historyPage(
    input: Readonly<{
      canvasId: string;
      userId?: string;
      cursor?: CanvasSnapshotHistoryCursor;
      limit: number;
    }>,
    transaction: TransactionContext,
  ): Promise<CanvasSnapshotHistoryPage> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<HistoryRow>(
      `WITH accessible_canvas AS MATERIALIZED (
         SELECT c.id
         FROM canvases c
         LEFT JOIN seasons s
           ON s.canvas_id = c.id AND c.type = 'season'
         WHERE c.id = $1::uuid
           AND (
             c.type = 'main'
             OR (
               c.type = 'season'
               AND s.canvas_id IS NOT NULL
               AND (s.cancelled_at IS NULL OR s.creator_id = $2::uuid)
             )
           )
       ), page AS (
         SELECT cs.id, cs.image_key, cs.width, cs.height, cs.is_final,
                cs.captured_at,
                to_char(
                  cs.captured_at AT TIME ZONE 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) AS captured_at_cursor
         FROM canvas_snapshots cs
         JOIN accessible_canvas ac ON ac.id = cs.canvas_id
         WHERE cs.status = 'READY'
           AND (
             $3::timestamptz IS NULL
             OR (cs.captured_at, cs.id) < ($3::timestamptz, $4::uuid)
           )
         ORDER BY cs.captured_at DESC, cs.id DESC
         LIMIT $5
       )
       SELECT ac.id AS accessible_canvas_id, p.id, p.image_key, p.width,
              p.height, p.is_final, p.captured_at, p.captured_at_cursor
       FROM accessible_canvas ac
       LEFT JOIN page p ON true
       ORDER BY p.captured_at DESC, p.id DESC`,
      [
        input.canvasId,
        input.userId ?? null,
        input.cursor?.capturedAt ?? null,
        input.cursor?.id ?? null,
        input.limit,
      ],
    );

    // 접근 가능한 캔버스가 없으면 CTE 결과도 없으므로 빈 히스토리와 구분한다.
    if (result.rows.length === 0) {
      return { canvasExists: false, records: [] };
    }

    // LEFT JOIN의 null 행은 접근 가능한 캔버스에 조회할 스냅샷이 없음을 뜻한다.
    const records = result.rows.flatMap((row) => {
      if (
        row.id === null ||
        row.image_key === null ||
        row.width === null ||
        row.height === null ||
        row.is_final === null ||
        row.captured_at === null ||
        row.captured_at_cursor === null
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          imageKey: row.image_key,
          width: row.width,
          height: row.height,
          isFinal: row.is_final,
          capturedAt: row.captured_at,
          cursorCapturedAt: row.captured_at_cursor,
        },
      ];
    });
    return { canvasExists: true, records };
  }

  /** 주기 캡처 대상 또는 종료 후 최종 결과가 없는 시즌을 UUID keyset으로 최대 100개 반환한다. */
  async targets(afterId?: string, final = false): Promise<CanvasTarget[]> {
    const result = final
      ? await this.pool.query<TargetRow>(
          `SELECT c.id, c.type, c.width, c.height, c.stroke_limit_per_user,
                  c.starts_at, c.ends_at
           FROM canvases c
           JOIN seasons s ON s.canvas_id = c.id
           WHERE c.type = 'season'
             AND ($1::uuid IS NULL OR c.id > $1::uuid)
             AND s.cancelled_at IS NULL
             AND (s.force_ended_at IS NOT NULL OR c.ends_at <= CURRENT_TIMESTAMP)
             AND NOT EXISTS (
               SELECT 1 FROM canvas_snapshots cs
               WHERE cs.canvas_id = c.id
                 AND cs.status = 'READY' AND cs.is_final = true
             )
           ORDER BY c.id ASC
           LIMIT 100`,
          [afterId ?? null],
        )
      : await this.pool.query<TargetRow>(
          `SELECT c.id, c.type, c.width, c.height, c.stroke_limit_per_user,
                  c.starts_at, c.ends_at
           FROM canvases c
           LEFT JOIN seasons s ON s.canvas_id = c.id
           WHERE ($1::uuid IS NULL OR c.id > $1::uuid)
             AND (
               c.type = 'main'
               OR (
                 c.type = 'season'
                 AND s.cancelled_at IS NULL
                 AND s.force_ended_at IS NULL
                 AND c.starts_at <= CURRENT_TIMESTAMP
                 AND c.ends_at > CURRENT_TIMESTAMP
               )
             )
           ORDER BY c.id ASC
           LIMIT 100`,
          [afterId ?? null],
        );
    return result.rows.map(toTarget);
  }

  /** DB 저장 경계·크기·렌더러가 맞는 READY 스냅샷 중 가장 큰 경계를 선택한다. */
  async latestReadyForBootstrap(
    target: CanvasTarget,
    rendererVersion: string,
    persistedHead: string,
  ): Promise<CanvasSnapshotRecord | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT ${SNAPSHOT_COLUMNS}
       FROM canvas_snapshots
       WHERE canvas_id = $1
         AND status = 'READY'
         AND renderer_version = $2
         AND width = $3 AND height = $4
         AND through_sequence <= $5::bigint
       ORDER BY through_sequence DESC, created_at DESC, id DESC
       LIMIT 1`,
      [target.id, rendererVersion, target.width, target.height, persistedHead],
    );
    const row = result.rows[0];
    return row ? toSnapshot(row, target) : undefined;
  }

  /** 파일 감사기가 모든 READY 결과를 UUID keyset으로 최대 100개씩 순회하게 한다. */
  async readyPage(afterId?: string): Promise<CanvasSnapshotRecord[]> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT cs.id, cs.canvas_id, c.type AS canvas_type,
              cs.through_sequence, cs.renderer_version, cs.width, cs.height,
              cs.status, cs.is_final, cs.image_key, cs.continuation_key,
              cs.image_bytes, cs.continuation_bytes, cs.image_sha256,
              cs.continuation_sha256, cs.continuation_schema_version,
              cs.captured_at, cs.created_at
       FROM canvas_snapshots cs
       JOIN canvases c ON c.id = cs.canvas_id
       WHERE cs.status = 'READY'
         AND ($1::uuid IS NULL OR cs.id > $1::uuid)
       ORDER BY cs.id ASC
       LIMIT 100`,
      [afterId ?? null],
    );
    return result.rows.map((row) => toSnapshot(row));
  }

  /** DB 응답 유실 뒤 snapshotId로 READY·INVALID 어느 공개 결과든 다시 확인한다. */
  async findPublished(id: string): Promise<CanvasSnapshotRecord | undefined> {
    const result = await this.pool.query<SnapshotRow>(
      `SELECT cs.id, cs.canvas_id, c.type AS canvas_type,
              cs.through_sequence, cs.renderer_version, cs.width, cs.height,
              cs.status, cs.is_final, cs.image_key, cs.continuation_key,
              cs.image_bytes, cs.continuation_bytes, cs.image_sha256,
              cs.continuation_sha256, cs.continuation_schema_version,
              cs.captured_at, cs.created_at
       FROM canvas_snapshots cs
       JOIN canvases c ON c.id = cs.canvas_id
       WHERE cs.id = $1
       LIMIT 1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toSnapshot(row) : undefined;
  }

  /** 손상 판정이 READY 행에만 적용됐는지 알려 중복 감사도 안전하게 끝낸다. */
  async invalidate(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE canvas_snapshots SET status = 'INVALID'
       WHERE id = $1 AND status = 'READY'`,
      [id],
    );
    return result.rowCount === 1;
  }

  /** 확정 디렉터리가 READY·INVALID 어느 메타데이터에서든 참조되는지 확인한다. */
  async hasReference(directoryKey: string): Promise<boolean> {
    if (
      !/^snapshots\/(main|seasons)\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(
        directoryKey,
      )
    )
      throw new Error('Canvas snapshot directory key is invalid.');
    const result = await this.pool.query(
      `SELECT 1 FROM canvas_snapshots
       WHERE image_key = $1 || '/image.png'
          OR continuation_key = $1 || '/continuation.json'
       LIMIT 1`,
      [directoryKey],
    );
    return result.rowCount === 1;
  }

  /** 파일 검증을 마친 메타데이터를 DB 경계와 시즌 종료 상태를 재검사한 뒤 READY로 공개한다. */
  async publish(
    input: CanvasSnapshotPublishInput,
  ): Promise<CanvasSnapshotRecord> {
    this.assertPublishInput(input);
    return this.transactions.run(async (transaction) => {
      const executor = getPgExecutor(this.pool, transaction);
      // 캔버스 head를 잠가 공개 검증과 INSERT 사이에 저장 경계가 바뀌지 않게 한다.
      const canvasResult = await executor.query<
        TargetRow & { last_chunk_sequence: string }
      >(
        `SELECT id, type, width, height, stroke_limit_per_user,
                starts_at, ends_at, last_chunk_sequence
         FROM canvases WHERE id = $1 FOR UPDATE`,
        [input.target.id],
      );
      const canvas = canvasResult.rows[0];
      if (!canvas || canvas.type !== input.target.kind)
        throw new CanvasSnapshotPublicationRejected(
          'Canvas snapshot target is missing or changed.',
        );
      if (
        canvas.width !== input.target.width ||
        canvas.height !== input.target.height
      )
        throw new CanvasSnapshotPublicationRejected(
          'Canvas snapshot dimensions changed before publication.',
        );

      const head = BigInt(canvas.last_chunk_sequence);
      const through = BigInt(input.throughSequence);
      if (through > head)
        throw new CanvasSnapshotPublicationRejected(
          'Canvas snapshot boundary exceeds the stored canvas head.',
        );

      if (input.isFinal) {
        if (canvas.type !== 'season' || through !== head)
          throw new CanvasSnapshotPublicationRejected(
            'Final canvas snapshot must match an ended season head.',
          );
        // 시즌 상태 행도 잠가 종료·취소 전환과 최종 결과 공개가 교차하지 않게 한다.
        const seasonResult = await executor.query<{
          cancelled_at: Date | null;
          force_ended_at: Date | null;
          observed_at: Date;
        }>(
          `SELECT cancelled_at, force_ended_at,
                  CURRENT_TIMESTAMP AS observed_at
           FROM seasons WHERE canvas_id = $1 FOR UPDATE`,
          [input.target.id],
        );
        const season = seasonResult.rows[0];
        if (!season || season.cancelled_at)
          throw new CanvasSnapshotPublicationRejected(
            'Cancelled or missing season cannot publish a final snapshot.',
          );
        const ended =
          season.force_ended_at !== null ||
          (canvas.ends_at !== null && canvas.ends_at <= season.observed_at);
        if (!ended)
          throw new CanvasSnapshotPublicationRejected(
            'Season must end before publishing its final snapshot.',
          );
      }

      const duplicate = await executor.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS}
         FROM canvas_snapshots
         WHERE canvas_id = $1 AND through_sequence = $2::bigint
           AND renderer_version = $3 AND status = 'READY'
         FOR UPDATE`,
        [input.target.id, input.throughSequence, input.rendererVersion],
      );
      const existing = duplicate.rows[0];
      if (existing) {
        // 같은 경계 충돌은 호출자가 앞서 검증한 동일 snapshotId·파일 메타데이터일 때만 재사용한다.
        if (!this.samePublishedSnapshot(existing, input))
          throw new CanvasSnapshotPublicationRejected(
            'Canvas snapshot boundary is already published with different metadata.',
          );
        // 같은 경계 파일을 재사용한 최종 캡처만 기존 READY 행을 최종 결과로 승격한다.
        if (input.isFinal && !existing.is_final) {
          const promoted = await executor.query<SnapshotRow>(
            `UPDATE canvas_snapshots SET is_final = true
             WHERE id = $1
             RETURNING ${SNAPSHOT_COLUMNS}`,
            [existing.id],
          );
          return toSnapshot(promoted.rows[0], input.target);
        }
        return toSnapshot(existing, input.target);
      }

      // snapshotId 재사용은 같은 경계라도 INVALID 결과를 READY로 되살리지 않게 거절한다.
      const idCollision = await executor.query(
        'SELECT 1 FROM canvas_snapshots WHERE id = $1 LIMIT 1',
        [input.id],
      );
      if (idCollision.rowCount)
        throw new CanvasSnapshotPublicationRejected(
          'Canvas snapshot id is already published.',
        );

      const inserted = await executor.query<SnapshotRow>(
        `INSERT INTO canvas_snapshots
           (id, canvas_id, through_sequence, renderer_version, width, height,
            status, is_final, image_key, continuation_key, image_bytes,
            continuation_bytes, image_sha256, continuation_sha256,
            continuation_schema_version, captured_at)
         VALUES ($1, $2, $3::bigint, $4, $5, $6, 'READY', $7, $8, $9,
                 $10, $11, $12, $13, $14, $15)
         RETURNING ${SNAPSHOT_COLUMNS}`,
        [
          input.id,
          input.target.id,
          input.throughSequence,
          input.rendererVersion,
          input.target.width,
          input.target.height,
          input.isFinal,
          input.imageKey,
          input.continuationKey,
          input.imageBytes,
          input.continuationBytes,
          input.imageSha256,
          input.continuationSha256,
          input.continuationSchemaVersion,
          input.capturedAt,
        ],
      );
      return toSnapshot(inserted.rows[0], input.target);
    });
  }

  /** 파일 계층에서 받은 메타데이터가 DB 공개 계약의 값 범위와 대상을 지키는지 확인한다. */
  private assertPublishInput(input: CanvasSnapshotPublishInput): void {
    const keyMatchesTarget =
      (input.target.kind === 'main' && input.target.key === 'main') ||
      (input.target.kind === 'season' &&
        input.target.key === `season:${input.target.id.toLowerCase()}`);
    if (!keyMatchesTarget)
      throw new CanvasSnapshotPublicationRejected(
        'Canvas snapshot target identity is invalid.',
      );
    if (!/^(0|[1-9][0-9]*)$/.test(input.throughSequence))
      throw new CanvasSnapshotPublicationRejected(
        'Canvas snapshot boundary is invalid.',
      );
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(input.rendererVersion))
      throw new CanvasSnapshotPublicationRejected(
        'Canvas snapshot renderer version is invalid.',
      );
    if (!Number.isSafeInteger(input.imageBytes) || input.imageBytes <= 0)
      throw new CanvasSnapshotPublicationRejected(
        'Canvas snapshot image byte size is invalid.',
      );
    if (
      !Number.isSafeInteger(input.continuationBytes) ||
      input.continuationBytes <= 0
    )
      throw new CanvasSnapshotPublicationRejected(
        'Canvas snapshot continuation byte size is invalid.',
      );
    if (!Number.isFinite(input.capturedAt.getTime()))
      throw new CanvasSnapshotPublicationRejected(
        'Canvas snapshot capture time is invalid.',
      );
  }

  /** READY 경계를 재사용할 때 파일과 캡처 사실이 최초 공개 행과 정확히 같은지 확인한다. */
  private samePublishedSnapshot(
    existing: SnapshotRow,
    input: CanvasSnapshotPublishInput,
  ): boolean {
    return (
      existing.id === input.id &&
      existing.canvas_id === input.target.id &&
      existing.through_sequence === input.throughSequence &&
      existing.renderer_version === input.rendererVersion &&
      existing.width === input.target.width &&
      existing.height === input.target.height &&
      existing.image_key === input.imageKey &&
      existing.continuation_key === input.continuationKey &&
      existing.image_bytes === String(input.imageBytes) &&
      existing.continuation_bytes === String(input.continuationBytes) &&
      existing.image_sha256 === input.imageSha256 &&
      existing.continuation_sha256 === input.continuationSha256 &&
      existing.continuation_schema_version ===
        input.continuationSchemaVersion &&
      existing.captured_at.getTime() === input.capturedAt.getTime()
    );
  }
}
