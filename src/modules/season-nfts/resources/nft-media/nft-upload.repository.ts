import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type {
  SeasonNftUploadKind,
  SeasonNftUploadState,
} from '../season-nft/season-nft';

type UploadRow = {
  id: string;
  release_id: string;
  kind: SeasonNftUploadKind;
  sha256: string;
  byte_length: string;
  data_item_id: string;
  signed_item_path: string;
  state: SeasonNftUploadState;
  uri: string | null;
  receipt: unknown;
};

export type PreparedUploadResult = Readonly<{
  created: boolean;
  uploadId: string;
  state: SeasonNftUploadState;
  dataItemId: string;
  signedItemPath: string;
  sha256: string;
  byteLength: bigint;
  uri: string | null;
  receipt: unknown;
}>;

export type PreparedUploadRecord = Omit<PreparedUploadResult, 'created'>;

const UPLOAD_COLUMNS = `
  id, release_id, kind, sha256, byte_length, data_item_id,
  signed_item_path, state, uri, receipt`;

/** release/kind별 signed data item 하나를 유지하고 receipt와 공개 검증 상태를 기록한다. */
@Injectable()
export class NftUploadRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 서명 전 복구 판단을 위해 release/kind의 기존 item identity와 진행 상태를 조회한다. */
  async findItem(
    releaseId: string,
    kind: SeasonNftUploadKind,
  ): Promise<PreparedUploadRecord | null> {
    const result = await this.pool.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS}
       FROM season_nft_uploads WHERE release_id = $1 AND kind = $2`,
      [releaseId, kind],
    );
    return result.rows[0] ? this.record(result.rows[0]) : null;
  }

  /** 같은 release/kind 재시도는 기존 item을 반환하고 다른 item으로 교체하려는 요청은 거절한다. */
  async prepareItem(
    input: Readonly<{
      releaseId: string;
      kind: SeasonNftUploadKind;
      sha256: string;
      byteLength: bigint;
      dataItemId: string;
      signedItemPath: string;
    }>,
    transaction: TransactionContext,
  ): Promise<PreparedUploadResult> {
    const executor = getPgExecutor(this.pool, transaction);
    await this.lockRelease(input.releaseId, transaction);
    const existing = await executor.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS}
       FROM season_nft_uploads
       WHERE release_id = $1 AND kind = $2 FOR UPDATE`,
      [input.releaseId, input.kind],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (
        row.sha256 !== input.sha256 ||
        BigInt(row.byte_length) !== input.byteLength ||
        row.data_item_id !== input.dataItemId ||
        row.signed_item_path !== input.signedItemPath
      ) {
        throw new Error('Season NFT upload does not match the prepared item.');
      }
      if (row.state === 'FAILED') {
        // 실패 재시도도 서명한 data item을 바꾸지 않고 같은 행을 다시 전송 대기로 돌린다.
        const rearmed = await executor.query<UploadRow>(
          `UPDATE season_nft_uploads
           SET state = 'PREPARED', uri = NULL, receipt = NULL,
               verified_at = NULL, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = 'FAILED'
           RETURNING ${UPLOAD_COLUMNS}`,
          [row.id],
        );
        return this.result(rearmed.rows[0], false);
      }
      return this.result(row, false);
    }
    const inserted = await executor.query<UploadRow>(
      `INSERT INTO season_nft_uploads
         (id, release_id, kind, sha256, byte_length, data_item_id,
          signed_item_path, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PREPARED')
       RETURNING ${UPLOAD_COLUMNS}`,
      [
        randomUUID(),
        input.releaseId,
        input.kind,
        input.sha256,
        input.byteLength.toString(),
        input.dataItemId,
        input.signedItemPath,
      ],
    );
    return this.result(inserted.rows[0], true);
  }

  /** 업로드 provider receipt를 같은 data item 행에 기록하고 PREPARED만 UPLOADED로 전이한다. */
  async recordReceipt(
    input: Readonly<{
      uploadId: string;
      dataItemId: string;
      receipt: Readonly<Record<string, unknown>>;
    }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean; state: SeasonNftUploadState }>> {
    const row = await this.lockUpload(input.uploadId, transaction);
    if (row.data_item_id !== input.dataItemId) {
      throw new Error(
        'Season NFT upload receipt has a different data item ID.',
      );
    }
    if (row.state !== 'PREPARED') {
      if (isDeepStrictEqual(row.receipt, input.receipt)) {
        return { updated: false, state: row.state };
      }
      throw new Error('Season NFT upload already has a different receipt.');
    }
    const updated = await getPgExecutor(this.pool, transaction).query<{
      state: SeasonNftUploadState;
    }>(
      `UPDATE season_nft_uploads
       SET state = 'UPLOADED', receipt = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'PREPARED' RETURNING state`,
      [input.uploadId, JSON.stringify(input.receipt)],
    );
    return { updated: true, state: updated.rows[0].state };
  }

  /** 공개 URI bytes 검증 후 같은 item을 VERIFIED로 표시하며 동일 URI 재검증은 no-op이다. */
  async markVerified(
    input: Readonly<{ uploadId: string; dataItemId: string; uri: string }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean; state: SeasonNftUploadState }>> {
    const row = await this.lockUpload(input.uploadId, transaction);
    if (row.data_item_id !== input.dataItemId) {
      throw new Error(
        'Season NFT verified upload has a different data item ID.',
      );
    }
    if (row.state === 'VERIFIED') {
      if (row.uri === input.uri) return { updated: false, state: row.state };
      throw new Error(
        'Season NFT upload already has a different verified URI.',
      );
    }
    if (row.state !== 'UPLOADED') {
      throw new Error(
        'Season NFT upload must have a receipt before verification.',
      );
    }
    const updated = await getPgExecutor(this.pool, transaction).query<{
      state: SeasonNftUploadState;
    }>(
      `UPDATE season_nft_uploads
       SET state = 'VERIFIED', uri = $2, verified_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'UPLOADED' RETURNING state`,
      [input.uploadId, input.uri],
    );
    return { updated: true, state: updated.rows[0].state };
  }

  private result(row: UploadRow, created: boolean): PreparedUploadResult {
    return {
      created,
      ...this.record(row),
    };
  }

  private record(row: UploadRow): PreparedUploadRecord {
    return {
      uploadId: row.id,
      state: row.state,
      dataItemId: row.data_item_id,
      signedItemPath: row.signed_item_path,
      sha256: row.sha256,
      byteLength: BigInt(row.byte_length),
      uri: row.uri,
      receipt: row.receipt,
    };
  }

  /** season과 release를 잠근 뒤 upload 행을 마지막에 잠가 저장 lane의 교착 순서를 통일한다. */
  private async lockUpload(
    uploadId: string,
    transaction: TransactionContext,
  ): Promise<UploadRow> {
    const executor = getPgExecutor(this.pool, transaction);
    const identity = await executor.query<{ release_id: string }>(
      `SELECT release_id FROM season_nft_uploads WHERE id = $1`,
      [uploadId],
    );
    if (!identity.rows[0]) throw new Error('Season NFT upload was not found.');
    await this.lockRelease(identity.rows[0].release_id, transaction);
    const row = await executor.query<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS}
       FROM season_nft_uploads WHERE id = $1 FOR UPDATE`,
      [uploadId],
    );
    return row.rows[0];
  }

  /** season을 먼저 잠그고 release를 잠가 다른 NFT repository와 순서를 맞춘다. */
  private async lockRelease(
    releaseId: string,
    transaction: TransactionContext,
  ): Promise<void> {
    const executor = getPgExecutor(this.pool, transaction);
    const release = await executor.query<{ season_id: string }>(
      `SELECT season_id FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    );
    if (!release.rows[0]) throw new Error('Season NFT release was not found.');
    await executor.query(
      `SELECT canvas_id FROM seasons WHERE canvas_id = $1 FOR UPDATE`,
      [release.rows[0].season_id],
    );
    await executor.query(
      `SELECT id FROM season_nft_releases WHERE id = $1 FOR UPDATE`,
      [releaseId],
    );
  }
}
