import { isDeepStrictEqual } from 'node:util';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type {
  StrokeBrush,
  StrokePoint,
  StrokePreview,
} from '../canvas-stroke/canvas-stroke';
import type {
  CanvasKey,
  CanvasTarget,
} from '../canvas-definition/canvas-target';

export type StoredChunk = { usageId: string; preview: StrokePreview };

type ChunkRow = {
  usage_id: string;
  user_id: string;
  client_stroke_id: string;
  sequence: string;
  chunk_index: number;
  brush: StrokeBrush;
  points: StrokePoint[];
  is_final: boolean;
};

/** DB 청크 행에 조회 대상 키와 현재 서버 세대를 더해 소켓 응답으로 바꾼다. */
function toStoredChunk(
  row: ChunkRow,
  epoch: string,
  canvasKey: CanvasKey,
): StoredChunk {
  return {
    usageId: row.usage_id,
    preview: {
      canvasKey,
      userId: row.user_id,
      epoch,
      sequence: row.sequence,
      clientStrokeId: row.client_stroke_id,
      brush: row.brush,
      points: row.points,
      chunkIndex: row.chunk_index,
      isFinal: row.is_final,
    },
  };
}

/** 좌표 묶음을 캔버스 순서로 저장하고 현재 서버 epoch으로 복구한다. */
@Injectable()
export class CanvasChunkRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 기존 메인 설정을 읽어 일반 대상 초기화 경로로 위임한다. */
  async initialize(): Promise<{ canvasId: string; headSequence: string }> {
    const result = await this.pool.query<{
      id: string;
      width: number;
      height: number;
      stroke_limit_per_user: number;
    }>(
      `SELECT id, width, height, stroke_limit_per_user
       FROM canvases WHERE type = 'main'`,
    );
    const canvas = result.rows[0];
    // 메인 설정이 없으면 임의 캔버스를 만들지 않고 서버 초기화를 중단한다.
    if (!canvas) throw new Error('Main canvas is missing.');
    return this.initializeTarget({
      id: canvas.id,
      key: 'main',
      kind: 'main',
      width: canvas.width,
      height: canvas.height,
      strokeLimitPerUser: canvas.stroke_limit_per_user,
      startsAt: null,
      endsAt: null,
    });
  }

  /** 대상 캔버스의 DB head와 실제 마지막 청크가 일치할 때 초기 상태를 반환한다. */
  async initializeTarget(
    target: CanvasTarget,
  ): Promise<{ canvasId: string; headSequence: string }> {
    this.assertTargetIdentity(target.id, target.key, target.kind);
    const result = await this.pool.query<{
      last_chunk_sequence: string;
      stored_head_sequence: string;
    }>(
      `SELECT c.last_chunk_sequence,
              COALESCE((
                SELECT max(ch.sequence) FROM canvas_stroke_chunks ch
                WHERE ch.canvas_id = c.id
              ), 0)::text AS stored_head_sequence
       FROM canvases c WHERE c.id = $1 AND c.type = $2`,
      [target.id, target.kind],
    );
    const canvas = result.rows[0];
    // 삭제됐거나 type이 달라진 대상은 별도 런타임으로 초기화하지 않는다.
    if (!canvas)
      throw new Error(
        target.kind === 'main'
          ? 'Main canvas is missing.'
          : 'Canvas is missing.',
      );
    // head와 마지막 저장 행이 다르면 누락 범위를 숨기지 않고 초기화를 중단한다.
    if (canvas.last_chunk_sequence !== canvas.stored_head_sequence)
      throw new Error(
        target.kind === 'main'
          ? 'Main canvas chunk head is inconsistent.'
          : 'Canvas chunk head is inconsistent.',
      );
    return { canvasId: target.id, headSequence: canvas.last_chunk_sequence };
  }

  /** 같은 사용자의 획에서 마지막으로 저장된 청크를 현재 epoch으로 반환한다. */
  async latest(
    canvasId: string,
    userId: string,
    clientStrokeId: string,
    epoch: string,
    canvasKey: CanvasKey = 'main',
  ): Promise<StoredChunk | undefined> {
    const result = await this.pool.query<ChunkRow>(
      `SELECT c.stroke_usage_id AS usage_id, u.user_id,
              u.client_stroke_id, c.sequence, c.chunk_index,
              c.brush, c.points, c.is_final
       FROM canvas_stroke_chunks c
       JOIN canvas_stroke_usages u
         ON u.canvas_id = c.canvas_id AND u.id = c.stroke_usage_id
       WHERE c.canvas_id = $1 AND u.user_id = $2
         AND u.client_stroke_id = $3
       ORDER BY c.sequence DESC LIMIT 1`,
      [canvasId, userId, clientStrokeId],
    );
    const row = result.rows[0];
    return row ? toStoredChunk(row, epoch, canvasKey) : undefined;
  }

  /** 같은 사용자의 획에서 지정한 chunkIndex로 저장된 청크를 현재 epoch으로 반환한다. */
  async byIndex(
    canvasId: string,
    userId: string,
    clientStrokeId: string,
    chunkIndex: number,
    epoch: string,
    canvasKey: CanvasKey = 'main',
  ): Promise<StoredChunk | undefined> {
    const result = await this.pool.query<ChunkRow>(
      `SELECT c.stroke_usage_id AS usage_id, u.user_id,
              u.client_stroke_id, c.sequence, c.chunk_index,
              c.brush, c.points, c.is_final
       FROM canvas_stroke_chunks c
       JOIN canvas_stroke_usages u
         ON u.canvas_id = c.canvas_id AND u.id = c.stroke_usage_id
       WHERE c.canvas_id = $1 AND u.user_id = $2
         AND u.client_stroke_id = $3 AND c.chunk_index = $4
       LIMIT 1`,
      [canvasId, userId, clientStrokeId, chunkIndex],
    );
    const row = result.rows[0];
    return row ? toStoredChunk(row, epoch, canvasKey) : undefined;
  }

  /** 지정한 전역 순서 범위의 청크를 오름차순으로 제한해 반환한다. */
  async page(
    canvasId: string,
    afterSequence: string,
    throughSequence: string,
    limit: number,
    epoch: string,
    canvasKey: CanvasKey = 'main',
  ): Promise<StrokePreview[]> {
    const result = await this.pool.query<ChunkRow>(
      `SELECT c.stroke_usage_id AS usage_id, u.user_id,
              u.client_stroke_id, c.sequence, c.chunk_index,
              c.brush, c.points, c.is_final
       FROM canvas_stroke_chunks c
       JOIN canvas_stroke_usages u
         ON u.canvas_id = c.canvas_id AND u.id = c.stroke_usage_id
       WHERE c.canvas_id = $1 AND c.sequence > $2::bigint
         AND c.sequence <= $3::bigint
       ORDER BY c.sequence ASC LIMIT $4`,
      [canvasId, afterSequence, throughSequence, limit],
    );
    return result.rows.map(
      (row) => toStoredChunk(row, epoch, canvasKey).preview,
    );
  }

  /**
   * afterSequence 다음의 연속 청크를 저장하고 캔버스의 청크 head를 같은 트랜잭션에서 전진시킨다.
   * 커밋 결과를 잃어 같은 배치를 다시 보내면 저장된 내용이 모두 같을 때만 성공으로 취급한다.
   */
  async save(
    canvasId: string,
    chunks: readonly StoredChunk[],
    afterSequence: string,
    transaction: TransactionContext,
    canvasKey: CanvasKey = 'main',
  ): Promise<void> {
    // 빈 flush는 DB head를 잠그거나 바꾸지 않는다.
    if (chunks.length === 0) return;

    const after = BigInt(afterSequence);
    this.assertTargetIdentity(
      canvasId,
      canvasKey,
      canvasKey === 'main' ? 'main' : 'season',
    );
    this.assertContiguous(chunks, after, canvasKey);
    const first = chunks[0].preview.sequence;
    const last = chunks.at(-1)!.preview.sequence;
    const executor = getPgExecutor(this.pool, transaction);

    // 한 캔버스의 flush를 직렬화해 서로 다른 배치가 같은 전역 순서를 차지하지 못하게 한다.
    const locked = await executor.query<{ last_chunk_sequence: string }>(
      `SELECT last_chunk_sequence FROM canvases
       WHERE id = $1 FOR UPDATE`,
      [canvasId],
    );
    const canvas = locked.rows[0];
    if (!canvas) throw new Error('Canvas is missing.');
    const databaseHead = BigInt(canvas.last_chunk_sequence);

    // 이미 head가 배치 끝을 지났다면 커밋 응답 유실 재시도인지 내용을 비교한다.
    if (databaseHead >= BigInt(last)) {
      await this.assertAlreadySaved(canvasId, chunks, first, last, transaction);
      return;
    }
    // DB head와 호출자가 본 head가 다르면 중간 순서를 건너뛰거나 덮어쓰지 않는다.
    if (databaseHead !== after)
      throw new Error('Canvas chunk sequence does not match database head.');

    await this.assertUsagesMatch(canvasId, chunks, transaction);
    // PostgreSQL 매개변수 한도를 넘지 않게 나누되 같은 트랜잭션 안에서 모두 저장한다.
    for (let start = 0; start < chunks.length; start += 1_000) {
      const part = chunks.slice(start, start + 1_000);
      const parameters: unknown[] = [];
      const values = part.map((chunk, index) => {
        const offset = index * 7;
        parameters.push(
          canvasId,
          chunk.usageId,
          chunk.preview.sequence,
          chunk.preview.chunkIndex,
          JSON.stringify(chunk.preview.brush),
          JSON.stringify(chunk.preview.points),
          chunk.preview.isFinal,
        );
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}::bigint,
                 $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6}::jsonb,
                 $${offset + 7})`;
      });
      await executor.query(
        `INSERT INTO canvas_stroke_chunks
           (canvas_id, stroke_usage_id, sequence, chunk_index, brush, points, is_final)
         VALUES ${values.join(', ')}`,
        parameters,
      );
    }
    const advanced = await executor.query(
      `UPDATE canvases SET last_chunk_sequence = $2::bigint
       WHERE id = $1 AND last_chunk_sequence = $3::bigint`,
      [canvasId, last, afterSequence],
    );
    if (advanced.rowCount !== 1)
      throw new Error('Canvas chunk head could not be advanced.');
  }

  /** 입력 배치가 afterSequence 바로 다음부터 빈틈없이 증가하는지 확인한다. */
  private assertContiguous(
    chunks: readonly StoredChunk[],
    afterSequence: bigint,
    canvasKey: CanvasKey,
  ): void {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      const expected = afterSequence + BigInt(index + 1);
      if (
        chunk.preview.canvasKey !== canvasKey ||
        BigInt(chunk.preview.sequence) !== expected
      )
        throw new Error('Canvas chunks must form a contiguous sequence.');
    }
  }

  /** 시즌 키의 UUID와 canvasId를 맞추고 키가 주장한 대상 종류를 확인한다. */
  private assertTargetIdentity(
    canvasId: string,
    canvasKey: CanvasKey,
    kind: CanvasTarget['kind'],
  ): void {
    const matches =
      (kind === 'main' && canvasKey === 'main') ||
      (kind === 'season' && canvasKey === `season:${canvasId.toLowerCase()}`);
    if (!matches) throw new Error('Canvas target identity does not match.');
  }

  /** 모든 usageId가 입력 preview의 캔버스·사용자·획 ID와 일치하는지 저장 전에 확인한다. */
  private async assertUsagesMatch(
    canvasId: string,
    chunks: readonly StoredChunk[],
    transaction: TransactionContext,
  ): Promise<void> {
    const unique = new Map<
      string,
      { userId: string; clientStrokeId: string }
    >();
    for (const chunk of chunks) {
      const identity = {
        userId: chunk.preview.userId,
        clientStrokeId: chunk.preview.clientStrokeId,
      };
      const previous = unique.get(chunk.usageId);
      if (previous && !isDeepStrictEqual(previous, identity))
        throw new Error('Stroke usage identity differs within the batch.');
      unique.set(chunk.usageId, identity);
    }
    const usageIds = [...unique.keys()];
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
      user_id: string;
      client_stroke_id: string;
    }>(
      `SELECT id, user_id, client_stroke_id
       FROM canvas_stroke_usages
       WHERE canvas_id = $1 AND id = ANY($2::uuid[])`,
      [canvasId, usageIds],
    );
    const found = new Map(result.rows.map((row) => [row.id, row]));
    for (const [usageId, expected] of unique) {
      const row = found.get(usageId);
      if (
        !row ||
        row.user_id !== expected.userId ||
        row.client_stroke_id !== expected.clientStrokeId
      )
        throw new Error('Stroke usage does not match chunk identity.');
    }
  }

  /** 저장된 행 전체가 재시도 배치와 같을 때만 과거 커밋 성공으로 인정한다. */
  private async assertAlreadySaved(
    canvasId: string,
    chunks: readonly StoredChunk[],
    firstSequence: string,
    lastSequence: string,
    transaction: TransactionContext,
  ): Promise<void> {
    const result = await getPgExecutor(this.pool, transaction).query<ChunkRow>(
      `SELECT c.stroke_usage_id AS usage_id, u.user_id,
              u.client_stroke_id, c.sequence, c.chunk_index,
              c.brush, c.points, c.is_final
       FROM canvas_stroke_chunks c
       JOIN canvas_stroke_usages u
         ON u.canvas_id = c.canvas_id AND u.id = c.stroke_usage_id
       WHERE c.canvas_id = $1 AND c.sequence BETWEEN $2::bigint AND $3::bigint
       ORDER BY c.sequence ASC`,
      [canvasId, firstSequence, lastSequence],
    );
    const same =
      result.rows.length === chunks.length &&
      result.rows.every((row, index) => {
        const expected = chunks[index];
        return (
          row.usage_id === expected.usageId &&
          row.user_id === expected.preview.userId &&
          row.client_stroke_id === expected.preview.clientStrokeId &&
          row.sequence === expected.preview.sequence &&
          row.chunk_index === expected.preview.chunkIndex &&
          row.is_final === expected.preview.isFinal &&
          isDeepStrictEqual(row.brush, expected.preview.brush) &&
          isDeepStrictEqual(row.points, expected.preview.points)
        );
      });
    if (!same)
      throw new Error('Stored canvas chunks conflict with retry payload.');
  }
}
