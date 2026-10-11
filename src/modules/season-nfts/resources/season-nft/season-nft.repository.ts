import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import bs58 from 'bs58';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import { TransactionRunner } from '../../../../database/transaction/transaction-runner';
import { withDbOnlyRetry } from '../nft-worker/db-only-retry';
import type {
  SeasonNftNetwork,
  SeasonNftReleaseRecord,
  SeasonNftReleaseStage,
} from './season-nft';
import { SeasonNftInternalErrorCodes } from './season-nft.error-codes';

type ReleaseRow = {
  id: string;
  season_id: string;
  network: SeasonNftNetwork;
  state: SeasonNftReleaseRecord['state'];
  stage: SeasonNftReleaseStage;
  snapshot_id: string | null;
  through_sequence: string | null;
  eligible_count: number | null;
  frozen_title: string | null;
  frozen_description: string | null;
  season_ended_at: Date | null;
  version: string;
  asset_name: string | null;
  image_byte_length: string | null;
  image_sha256: string | null;
  metadata_sha256: string | null;
  image_uri: string | null;
  metadata_uri: string | null;
  collection_address: string | null;
  candy_machine_address: string | null;
  candy_guard_address: string | null;
  merkle_root: Buffer | null;
  preparation_keys: Record<string, string>;
  locked_at: Date | null;
  ready_at: Date | null;
  next_attempt_at: Date;
  retry_count: number;
  created_at: Date;
};

type FrozenClaim = Readonly<{
  id?: string;
  userId: string;
  walletAccountId: string;
  walletAddress: string;
  merkleProof: readonly (readonly number[])[];
}>;

export type FrozenEligibilityRow = Readonly<{
  userId: string;
  participantUserId: string | null;
  walletAccountId: string | null;
  walletAddress: string | null;
  verifiedWalletId: string | null;
  walletUserId: string | null;
  verifiedAddress: string | null;
  chainNamespace: string | null;
}>;

export type FreezeSeasonNftInput = Readonly<{
  releaseId: string;
  expectedVersion: bigint;
  snapshotId: string;
  throughSequence: bigint;
  imageByteLength: bigint;
  imageSha256: string;
  frozenTitle: string;
  frozenDescription: string | null;
  seasonEndedAt: Date;
  eligibilityRows: readonly FrozenEligibilityRow[];
  merkleRoot: Buffer | null;
  claims: readonly FrozenClaim[];
}>;

export type AdvanceSeasonNftStageInput = Readonly<{
  releaseId: string;
  expectedVersion: bigint;
  expectedStage: SeasonNftReleaseStage;
  nextStage: Exclude<SeasonNftReleaseStage, 'SNAPSHOT' | 'FROZEN'>;
  assetName?: string;
  imageByteLength?: bigint;
  imageSha256?: string;
  metadataSha256?: string;
  imageUri?: string;
  metadataUri?: string;
  collectionAddress?: string;
  candyMachineAddress?: string;
  candyGuardAddress?: string;
  preparationKeys?: Readonly<Record<string, string>>;
  lockedAt?: Date;
  readyAt?: Date;
}>;

export type SeasonNftMediaSource = Readonly<{
  releaseId: string;
  seasonId: string;
  state: SeasonNftReleaseRecord['state'];
  stage: SeasonNftReleaseStage;
  version: bigint;
  snapshotId: string | null;
  throughSequence: bigint | null;
  eligibleCount: number | null;
  frozenTitle: string | null;
  frozenDescription: string | null;
  seasonEndedAt: Date | null;
  imageByteLength: bigint | null;
  imageSha256: string | null;
  imageUri: string | null;
}>;

export type SeasonNftChainSource = Readonly<{
  releaseId: string;
  network: SeasonNftNetwork;
  state: SeasonNftReleaseRecord['state'];
  stage: SeasonNftReleaseStage;
  version: bigint;
  name: string;
  metadataUri: string;
  eligibleCount: number;
  merkleRoot: Buffer;
  collectionAddress: string | null;
  candyMachineAddress: string | null;
  candyGuardAddress: string | null;
  preparationKeys: Readonly<Record<string, string>>;
}>;

export type DueSeasonNftRelease = Readonly<{
  releaseId: string;
  seasonId: string;
  state: Extract<
    SeasonNftReleaseRecord['state'],
    'WAITING_SNAPSHOT' | 'PREPARING'
  >;
  stage: SeasonNftReleaseStage;
  version: bigint;
  retryCount: number;
}>;

const RELEASE_COLUMNS = `
  id, season_id, network, state, stage, snapshot_id, through_sequence,
  eligible_count, frozen_title, frozen_description, season_ended_at, version,
  asset_name, image_byte_length, image_sha256, metadata_sha256, image_uri, metadata_uri,
  collection_address, candy_machine_address, candy_guard_address,
  merkle_root, preparation_keys, locked_at, ready_at, next_attempt_at, retry_count, created_at`;

const NEXT_STAGE: Readonly<
  Partial<Record<SeasonNftReleaseStage, SeasonNftReleaseStage>>
> = {
  FROZEN: 'IMAGE',
  IMAGE: 'METADATA',
  METADATA: 'COLLECTION',
  COLLECTION: 'MACHINE',
  MACHINE: 'LOCKED',
};

function toRecord(row: ReleaseRow): SeasonNftReleaseRecord {
  return {
    id: row.id,
    seasonId: row.season_id,
    network: row.network,
    state: row.state,
    stage: row.stage,
    version: BigInt(row.version),
  };
}

function validProof(proof: readonly (readonly number[])[]): boolean {
  return proof.every(
    (node) =>
      node.length === 32 &&
      node.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255),
  );
}

function validEligibility(rows: readonly FrozenEligibilityRow[]): boolean {
  if (rows.length > 100) return false;
  const addresses = new Set<string>();
  return rows.every((row) => {
    if (
      row.participantUserId !== row.userId ||
      row.walletAccountId === null ||
      row.walletAddress === null ||
      row.verifiedWalletId !== row.walletAccountId ||
      row.walletUserId !== row.userId ||
      row.verifiedAddress !== row.walletAddress ||
      row.chainNamespace !== 'solana' ||
      addresses.has(row.walletAddress)
    ) {
      return false;
    }
    try {
      if (bs58.decode(row.walletAddress).length !== 32) return false;
    } catch {
      return false;
    }
    addresses.add(row.walletAddress);
    return true;
  });
}

function sameEligibility(
  left: readonly FrozenEligibilityRow[],
  right: readonly FrozenEligibilityRow[],
): boolean {
  const fields: readonly (keyof FrozenEligibilityRow)[] = [
    'userId',
    'participantUserId',
    'walletAccountId',
    'walletAddress',
    'verifiedWalletId',
    'walletUserId',
    'verifiedAddress',
    'chainNamespace',
  ];
  return (
    left.length === right.length &&
    left.every((row, index) =>
      fields.every((field) => row[field] === right[index]?.[field]),
    )
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right))
    return left.equals(right);
  if (left instanceof Date && right instanceof Date)
    return left.getTime() === right.getTime();
  return left === right;
}

function validPreparationKeys(keys: Readonly<Record<string, string>>): boolean {
  return Object.entries(keys).every(
    ([address, path]) =>
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) &&
      typeof path === 'string' &&
      path.length > 0 &&
      !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').includes('..'),
  );
}

/** release와 확정 claim 집합의 CAS 변경을 season 잠금 아래 원자적으로 소유한다. */
@Injectable()
export class SeasonNftRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly transactions: TransactionRunner,
  ) {}

  /** due release를 계층 잠금 아래 선점하고 callback 시작 전에 다음 검사 시각을 저장한다. */
  async claimDue(
    input: Readonly<{
      network: SeasonNftNetwork;
      limit: number;
      claimDurationMs: number;
    }>,
  ): Promise<readonly DueSeasonNftRelease[]> {
    return withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const executor = getPgExecutor(this.pool, transaction);
        const candidates = await executor.query<{ id: string }>(
          `SELECT id FROM season_nft_releases
           WHERE network = $1 AND state IN ('WAITING_SNAPSHOT', 'PREPARING')
             AND next_attempt_at <= statement_timestamp()
           ORDER BY next_attempt_at ASC, created_at ASC, id ASC
           LIMIT $2`,
          [input.network, input.limit],
        );
        const claimed: DueSeasonNftRelease[] = [];
        for (const candidate of candidates.rows) {
          const release = await this.lockRelease(candidate.id, transaction);
          if (
            release.network !== input.network ||
            (release.state !== 'WAITING_SNAPSHOT' &&
              release.state !== 'PREPARING')
          ) {
            continue;
          }
          const updated = await executor.query(
            `UPDATE season_nft_releases
             SET next_attempt_at = statement_timestamp() +
                   ($2::double precision * interval '1 millisecond'),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND state = $3
               AND next_attempt_at <= statement_timestamp()
             RETURNING id`,
            [release.id, input.claimDurationMs, release.state],
          );
          // 잠금 대기 중 다른 선점이 due 시각을 바꿨으면 stale 후보를 건너뛴다.
          if (updated.rows.length === 0) continue;
          claimed.push({
            releaseId: release.id,
            seasonId: release.season_id,
            state: release.state,
            stage: release.stage,
            version: BigInt(release.version),
            retryCount: release.retry_count,
          });
        }
        return claimed;
      }),
    );
  }

  /** transient 준비 실패를 같은 release identity에 기록하고 exponential backoff 시각을 고정한다. */
  async rescheduleDue(
    input: Readonly<{
      releaseId: string;
      retryDelayMs: number;
      errorCode: string;
    }>,
  ): Promise<void> {
    await withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const release = await this.lockRelease(input.releaseId, transaction);
        if (
          release.state !== 'WAITING_SNAPSHOT' &&
          release.state !== 'PREPARING'
        )
          return;
        await getPgExecutor(this.pool, transaction).query(
          `UPDATE season_nft_releases
           SET retry_count = retry_count + 1,
               next_attempt_at = statement_timestamp() +
                 ($2::double precision * interval '1 millisecond'),
               last_error_code = $3, updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND state = $4`,
          [input.releaseId, input.retryDelayMs, input.errorCode, release.state],
        );
      }),
    );
  }

  /** storage lane이 frozen snapshot identity와 metadata 원본만 읽도록 release 값을 선택한다. */
  async findMediaSource(
    releaseId: string,
  ): Promise<SeasonNftMediaSource | null> {
    const result = await this.pool.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS}
       FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      releaseId: row.id,
      seasonId: row.season_id,
      state: row.state,
      stage: row.stage,
      version: BigInt(row.version),
      snapshotId: row.snapshot_id,
      throughSequence:
        row.through_sequence === null ? null : BigInt(row.through_sequence),
      eligibleCount: row.eligible_count,
      frozenTitle: row.frozen_title,
      frozenDescription: row.frozen_description,
      seasonEndedAt: row.season_ended_at,
      imageByteLength:
        row.image_byte_length === null ? null : BigInt(row.image_byte_length),
      imageSha256: row.image_sha256,
      imageUri: row.image_uri,
    };
  }

  /** Chain preparation reads only frozen, verified release values and prior durable identities. */
  async findChainSource(
    releaseId: string,
  ): Promise<SeasonNftChainSource | null> {
    const result = await this.pool.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS} FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (
      row.asset_name === null ||
      row.metadata_uri === null ||
      row.eligible_count === null ||
      row.merkle_root === null
    ) {
      throw new Error('Season NFT chain source is not frozen and verified.');
    }
    return {
      releaseId: row.id,
      network: row.network,
      state: row.state,
      stage: row.stage,
      version: BigInt(row.version),
      name: row.asset_name,
      metadataUri: row.metadata_uri,
      eligibleCount: row.eligible_count,
      merkleRoot: row.merkle_root,
      collectionAddress: row.collection_address,
      candyMachineAddress: row.candy_machine_address,
      candyGuardAddress: row.candy_guard_address,
      preparationKeys: row.preparation_keys,
    };
  }

  /** Public addresses and relative key references become durable before any setup transaction is prepared. */
  async recordPreparationIdentity(
    input: Readonly<{
      releaseId: string;
      expectedVersion: bigint;
      collectionAddress: string;
      candyMachineAddress: string;
      candyGuardAddress: string;
      preparationKeys: Readonly<Record<string, string>>;
    }>,
  ): Promise<Readonly<{ updated: boolean; conflict: boolean }>> {
    if (!validPreparationKeys(input.preparationKeys)) {
      throw new Error('Season NFT preparation key path is invalid.');
    }
    return withDbOnlyRetry(() =>
      this.transactions.run(async (transaction) => {
        const row = await this.lockRelease(input.releaseId, transaction);
        if (
          BigInt(row.version) !== input.expectedVersion ||
          row.state !== 'PREPARING' ||
          !['METADATA', 'COLLECTION', 'MACHINE'].includes(row.stage)
        ) {
          return { updated: false, conflict: false };
        }
        const addresses = [
          [row.collection_address, input.collectionAddress],
          [row.candy_machine_address, input.candyMachineAddress],
          [row.candy_guard_address, input.candyGuardAddress],
        ] as const;
        const conflict =
          addresses.some(
            ([actual, expected]) => actual !== null && actual !== expected,
          ) ||
          Object.entries(input.preparationKeys).some(
            ([address, keyPath]) =>
              row.preparation_keys[address] !== undefined &&
              row.preparation_keys[address] !== keyPath,
          );
        const executor = getPgExecutor(this.pool, transaction);
        if (conflict) {
          await executor.query(
            `UPDATE season_nft_releases
             SET state = 'BLOCKED', last_error_code = 'NFT_PREPARATION_IDENTITY_CONFLICT',
                 last_error_message = 'A durable NFT preparation identity changed.',
                 version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1 AND version = $2`,
            [input.releaseId, input.expectedVersion.toString()],
          );
          return { updated: false, conflict: true };
        }
        const keys = { ...row.preparation_keys, ...input.preparationKeys };
        const result = await executor.query(
          `UPDATE season_nft_releases
           SET collection_address = COALESCE(collection_address, $3),
               candy_machine_address = COALESCE(candy_machine_address, $4),
               candy_guard_address = COALESCE(candy_guard_address, $5),
               preparation_keys = $6::jsonb, version = version + 1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND version = $2 AND state = 'PREPARING'
           RETURNING id`,
          [
            input.releaseId,
            input.expectedVersion.toString(),
            input.collectionAddress,
            input.candyMachineAddress,
            input.candyGuardAddress,
            JSON.stringify(keys),
          ],
        );
        return { updated: result.rows.length === 1, conflict: false };
      }),
    );
  }

  /** 정상 종료 후보를 season/network당 한 번만 만들고 잠근 기존 행도 같은 계약으로 반환한다. */
  async insertCandidate(
    input: Readonly<{ seasonId: string; network: SeasonNftNetwork }>,
    transaction: TransactionContext,
  ): Promise<
    Readonly<{
      created: boolean;
      releaseId: string;
      state: SeasonNftReleaseRecord['state'];
      stage: SeasonNftReleaseStage;
      version: bigint;
    }>
  > {
    const executor = getPgExecutor(this.pool, transaction);
    // release보다 season을 먼저 잠가 후보 생성과 후속 작업의 전역 잠금 순서를 유지한다.
    const season = await executor.query(
      `SELECT s.canvas_id
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id
       WHERE s.canvas_id = $1
         AND c.type = 'season'
         AND s.cancelled_at IS NULL
         AND s.force_ended_at IS NULL
         AND c.ends_at <= CURRENT_TIMESTAMP
       FOR UPDATE OF s`,
      [input.seasonId],
    );
    if (season.rows.length === 0)
      throw new Error('Season NFT season is not eligible for a release.');

    const id = randomUUID();
    const inserted = await executor.query(
      `INSERT INTO season_nft_releases
         (id, season_id, network, state, stage)
       VALUES ($1, $2, $3, 'WAITING_SNAPSHOT', 'SNAPSHOT')
       ON CONFLICT (season_id, network) DO NOTHING
       RETURNING id`,
      [id, input.seasonId, input.network],
    );
    const result = await executor.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS}
       FROM season_nft_releases
       WHERE season_id = $1 AND network = $2
       FOR UPDATE`,
      [input.seasonId, input.network],
    );
    const release = toRecord(result.rows[0]);
    return {
      created: inserted.rows.length === 1,
      releaseId: release.id,
      state: release.state,
      stage: release.stage,
      version: release.version,
    };
  }

  /** final snapshot이 아직 없으면 CAS 소유권을 확인하고 다음 조회를 60초 뒤로 미룬다. */
  async deferSnapshot(
    input: Readonly<{ releaseId: string; expectedVersion: bigint }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    const executor = getPgExecutor(this.pool, transaction);
    const release = await this.lockRelease(input.releaseId, transaction);
    if (
      BigInt(release.version) !== input.expectedVersion ||
      release.state !== 'WAITING_SNAPSHOT' ||
      release.stage !== 'SNAPSHOT'
    ) {
      return { updated: false };
    }
    const result = await executor.query(
      `UPDATE season_nft_releases
       SET next_attempt_at = CURRENT_TIMESTAMP + interval '60 seconds',
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND version = $2
         AND state = 'WAITING_SNAPSHOT' AND stage = 'SNAPSHOT'
       RETURNING id`,
      [input.releaseId, input.expectedVersion.toString()],
    );
    return { updated: result.rows.length === 1 };
  }

  /** 최종 snapshot 경계와 참여 지갑 집합을 다시 확인하고 release와 claim을 한 commit으로 고정한다. */
  async freeze(
    input: FreezeSeasonNftInput,
    transaction: TransactionContext,
  ): Promise<
    Readonly<{
      updated: boolean;
      reason?: 'BLOCKED' | 'SOURCE_CHANGED';
    }>
  > {
    const executor = getPgExecutor(this.pool, transaction);
    const identity = await executor.query<{ season_id: string }>(
      `SELECT season_id FROM season_nft_releases WHERE id = $1`,
      [input.releaseId],
    );
    if (identity.rows.length === 0)
      throw new Error('Season NFT release was not found.');

    // season, release, snapshot/head 순서로 잠가 다른 repository와 교착 순서를 맞춘다.
    const season = await executor.query<{
      canvas_id: string;
      title: string;
      description: string | null;
      cancelled_at: Date | null;
      force_ended_at: Date | null;
    }>(
      `SELECT s.canvas_id, s.title, s.description,
              s.cancelled_at, s.force_ended_at
       FROM seasons s
       WHERE s.canvas_id = $1
       FOR UPDATE OF s`,
      [identity.rows[0].season_id],
    );
    if (season.rows.length === 0)
      throw new Error('Season NFT season was not found.');
    const locked = await executor.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS}
       FROM season_nft_releases WHERE id = $1 FOR UPDATE`,
      [input.releaseId],
    );
    const release = locked.rows[0];
    if (
      BigInt(release.version) !== input.expectedVersion ||
      release.state !== 'WAITING_SNAPSHOT' ||
      release.stage !== 'SNAPSHOT'
    ) {
      return { updated: false };
    }
    const source = season.rows[0];
    if (source.cancelled_at !== null || source.force_ended_at !== null) {
      return this.blockSourceIneligible(input, transaction);
    }
    // CAS 소유권을 확인한 뒤에만 이 worker가 계산한 proof와 root를 검증한다.
    if (
      input.claims.length > 100 ||
      input.claims.some((claim) => !validProof(claim.merkleProof)) ||
      input.imageByteLength <= 0n ||
      !/^[0-9a-f]{64}$/.test(input.imageSha256)
    ) {
      throw new Error('Season NFT frozen claim proof is invalid.');
    }
    if (
      (input.claims.length === 0 && input.merkleRoot !== null) ||
      (input.claims.length > 0 && input.merkleRoot?.length !== 32)
    ) {
      throw new Error('Season NFT frozen Merkle root is invalid.');
    }
    if (
      source.title !== input.frozenTitle ||
      source.description !== input.frozenDescription
    ) {
      return { updated: false, reason: 'SOURCE_CHANGED' };
    }
    const snapshot = await executor.query<{
      through_sequence: string;
      last_chunk_sequence: string;
      ends_at: Date;
      canvas_type: string;
      observed_at: Date;
      image_bytes: string;
      image_sha256: string;
    }>(
      `SELECT cs.through_sequence, c.last_chunk_sequence, c.ends_at,
              c.type AS canvas_type, CURRENT_TIMESTAMP AS observed_at,
              cs.image_bytes, cs.image_sha256
       FROM canvas_snapshots cs
       JOIN canvases c ON c.id = cs.canvas_id
       WHERE cs.id = $1 AND cs.canvas_id = $2
         AND cs.status = 'READY' AND cs.is_final = true
       FOR UPDATE OF cs, c`,
      [input.snapshotId, release.season_id],
    );
    if (
      snapshot.rows.length === 0 ||
      BigInt(snapshot.rows[0].through_sequence) !== input.throughSequence ||
      BigInt(snapshot.rows[0].last_chunk_sequence) !== input.throughSequence ||
      snapshot.rows[0].ends_at.getTime() !== input.seasonEndedAt.getTime() ||
      BigInt(snapshot.rows[0].image_bytes) !== input.imageByteLength ||
      snapshot.rows[0].image_sha256 !== input.imageSha256
    ) {
      return { updated: false, reason: 'SOURCE_CHANGED' };
    }
    if (
      snapshot.rows[0].canvas_type !== 'season' ||
      snapshot.rows[0].ends_at.getTime() >
        snapshot.rows[0].observed_at.getTime()
    ) {
      return this.blockSourceIneligible(input, transaction);
    }

    // snapshot/head 뒤에 usage와 참가 지갑 행을 잠가 확정 직전 명단 변경을 직렬화한다.
    await executor.query(
      `SELECT id FROM canvas_stroke_usages
       WHERE canvas_id = $1 ORDER BY user_id ASC, id ASC FOR UPDATE`,
      [release.season_id],
    );
    await executor.query(
      `SELECT season_id, user_id FROM season_participants
       WHERE season_id = $1 ORDER BY user_id ASC FOR UPDATE`,
      [release.season_id],
    );
    await executor.query(
      `SELECT w.id
       FROM user_wallets w
       JOIN season_participants p ON p.wallet_account_id = w.id
       WHERE p.season_id = $1 ORDER BY w.id ASC FOR SHARE OF w`,
      [release.season_id],
    );
    const eligibility = await executor.query<{
      user_id: string;
      participant_user_id: string | null;
      wallet_account_id: string | null;
      wallet_address: string | null;
      verified_wallet_id: string | null;
      wallet_user_id: string | null;
      verified_address: string | null;
      chain_namespace: string | null;
    }>(
      `SELECT DISTINCT u.user_id, p.user_id AS participant_user_id,
              p.wallet_account_id, p.wallet_address COLLATE "C" AS wallet_address,
              w.id AS verified_wallet_id, w.user_id AS wallet_user_id,
              w.address AS verified_address, w.chain_namespace
       FROM canvas_stroke_usages u
       LEFT JOIN season_participants p
         ON p.season_id = u.canvas_id AND p.user_id = u.user_id
       LEFT JOIN user_wallets w ON w.id = p.wallet_account_id
       WHERE u.canvas_id = $1
       ORDER BY p.wallet_address COLLATE "C" ASC NULLS FIRST, u.user_id ASC`,
      [release.season_id],
    );
    const lockedEligibility: FrozenEligibilityRow[] = eligibility.rows.map(
      (row) => ({
        userId: row.user_id,
        participantUserId: row.participant_user_id,
        walletAccountId: row.wallet_account_id,
        walletAddress: row.wallet_address,
        verifiedWalletId: row.verified_wallet_id,
        walletUserId: row.wallet_user_id,
        verifiedAddress: row.verified_address,
        chainNamespace: row.chain_namespace,
      }),
    );
    // 바깥 계산 뒤 한 필드라도 바뀌면 이번 commit을 비워 두고 새 원본으로 다시 계산한다.
    if (!sameEligibility(input.eligibilityRows, lockedEligibility))
      return { updated: false, reason: 'SOURCE_CHANGED' };
    if (!validEligibility(lockedEligibility)) {
      const blocked = await executor.query(
        `UPDATE season_nft_releases
         SET state = 'BLOCKED', last_error_code = $3,
             last_error_message = 'Season NFT eligibility source is invalid.',
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND version = $2
           AND state = 'WAITING_SNAPSHOT' AND stage = 'SNAPSHOT'
         RETURNING id`,
        [
          input.releaseId,
          input.expectedVersion.toString(),
          SeasonNftInternalErrorCodes.EligibilityCorrupt,
        ],
      );
      return {
        updated: blocked.rows.length === 1,
        ...(blocked.rows.length === 1 ? { reason: 'BLOCKED' as const } : {}),
      };
    }
    const claimsMatch = input.claims.every((claim, index) => {
      const member = lockedEligibility[index];
      return (
        member !== undefined &&
        claim.userId === member.userId &&
        claim.walletAccountId === member.walletAccountId &&
        claim.walletAddress === member.walletAddress
      );
    });
    if (input.claims.length !== lockedEligibility.length || !claimsMatch)
      throw new Error('Season NFT frozen claims do not match eligibility.');

    const state = input.claims.length === 0 ? 'EMPTY' : 'PREPARING';
    const updated = await executor.query(
      `UPDATE season_nft_releases
       SET state = $3, stage = 'FROZEN', snapshot_id = $4,
           through_sequence = $5, eligible_count = $6, frozen_title = $7,
           frozen_description = $8, season_ended_at = $9, merkle_root = $10,
           image_byte_length = $11, image_sha256 = $12,
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND version = $2
         AND state = 'WAITING_SNAPSHOT' AND stage = 'SNAPSHOT'
       RETURNING id`,
      [
        input.releaseId,
        input.expectedVersion.toString(),
        state,
        input.snapshotId,
        input.throughSequence.toString(),
        input.claims.length,
        input.frozenTitle,
        input.frozenDescription,
        input.seasonEndedAt,
        input.merkleRoot,
        input.imageByteLength.toString(),
        input.imageSha256,
      ],
    );
    if (updated.rows.length === 0) return { updated: false };
    for (const claim of input.claims) {
      await executor.query(
        `INSERT INTO season_nft_claims
           (id, release_id, network, user_id, wallet_account_id,
            wallet_address, state, merkle_proof, receipt_state)
         VALUES ($1, $2, $3, $4, $5, $6, 'UNCLAIMED', $7, 'NONE')`,
        [
          claim.id ?? randomUUID(),
          input.releaseId,
          release.network,
          claim.userId,
          claim.walletAccountId,
          claim.walletAddress,
          JSON.stringify(claim.merkleProof),
        ],
      );
    }
    return { updated: true };
  }

  /** commit 시점에도 정상 종료가 아닌 원본이면 같은 CAS 아래 영구 부적격을 기록한다. */
  private async blockSourceIneligible(
    input: Readonly<{ releaseId: string; expectedVersion: bigint }>,
    transaction: TransactionContext,
  ): Promise<
    Readonly<{ updated: boolean; reason?: 'BLOCKED' | 'SOURCE_CHANGED' }>
  > {
    const blocked = await this.block(
      {
        releaseId: input.releaseId,
        expectedVersion: input.expectedVersion,
        errorCode: SeasonNftInternalErrorCodes.SourceIneligible,
        errorMessage: 'Season NFT source is no longer eligible.',
        nextAttemptAt: new Date(),
      },
      transaction,
    );
    return {
      updated: blocked.updated,
      ...(blocked.updated ? { reason: 'BLOCKED' as const } : {}),
    };
  }

  /** 준비 단계의 확정값을 NULL에서 한 번만 채우고 expectedVersion이 맞을 때만 다음 단계로 이동한다. */
  async advanceStage(
    input: AdvanceSeasonNftStageInput,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    const executor = getPgExecutor(this.pool, transaction);
    const release = await this.lockRelease(input.releaseId, transaction);
    // stale worker의 미완성 입력은 새 작업의 검증 실패가 아니라 CAS 패배로 처리한다.
    if (
      BigInt(release.version) !== input.expectedVersion ||
      release.state !== 'PREPARING' ||
      release.stage !== input.expectedStage
    ) {
      return { updated: false };
    }
    if (NEXT_STAGE[input.expectedStage] !== input.nextStage) {
      throw new Error('Season NFT release stage transition is invalid.');
    }
    if (input.preparationKeys && !validPreparationKeys(input.preparationKeys)) {
      throw new Error('Season NFT preparation key path is invalid.');
    }
    const requiredValuesPresent =
      (input.nextStage !== 'IMAGE' ||
        (input.imageByteLength !== undefined &&
          input.imageSha256 !== undefined &&
          input.imageUri !== undefined)) &&
      (input.nextStage !== 'METADATA' ||
        (input.assetName !== undefined &&
          input.metadataSha256 !== undefined &&
          input.metadataUri !== undefined)) &&
      (input.nextStage !== 'COLLECTION' ||
        input.collectionAddress !== undefined) &&
      (input.nextStage !== 'MACHINE' ||
        (input.candyMachineAddress !== undefined &&
          input.candyGuardAddress !== undefined)) &&
      (input.nextStage !== 'LOCKED' ||
        (input.lockedAt !== undefined && input.readyAt !== undefined));
    if (!requiredValuesPresent) {
      throw new Error('Season NFT release stage evidence is incomplete.');
    }
    const changes: Array<[keyof ReleaseRow, unknown]> = [
      ['asset_name', input.assetName],
      ['image_byte_length', input.imageByteLength?.toString()],
      ['image_sha256', input.imageSha256],
      ['metadata_sha256', input.metadataSha256],
      ['image_uri', input.imageUri],
      ['metadata_uri', input.metadataUri],
      ['collection_address', input.collectionAddress],
      ['candy_machine_address', input.candyMachineAddress],
      ['candy_guard_address', input.candyGuardAddress],
      ['locked_at', input.lockedAt],
      ['ready_at', input.readyAt],
    ];
    const conflict = changes.some(
      ([column, value]) =>
        value !== undefined &&
        release[column] !== null &&
        !sameValue(release[column], value),
    );
    const mergedKeys = {
      ...release.preparation_keys,
      ...input.preparationKeys,
    };
    const keyConflict = Object.entries(input.preparationKeys ?? {}).some(
      ([key, value]) =>
        release.preparation_keys[key] !== undefined &&
        release.preparation_keys[key] !== value,
    );
    // 이미 확정한 URI, hash, 주소 또는 key 파일이 달라지면 release를 BLOCKED로 보존한다.
    if (conflict || keyConflict) {
      await executor.query(
        `UPDATE season_nft_releases
         SET state = 'BLOCKED', last_error_code = 'NFT_FROZEN_VALUE_CONFLICT',
             last_error_message = 'A frozen NFT preparation value changed.',
             version = version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND version = $2`,
        [input.releaseId, input.expectedVersion.toString()],
      );
      return { updated: false };
    }
    const ready = input.nextStage === 'LOCKED';
    const result = await executor.query(
      `UPDATE season_nft_releases
       SET state = $3, stage = $4,
           asset_name = COALESCE(asset_name, $5),
           image_byte_length = COALESCE(image_byte_length, $6),
           image_sha256 = COALESCE(image_sha256, $7),
           metadata_sha256 = COALESCE(metadata_sha256, $8),
           image_uri = COALESCE(image_uri, $9),
           metadata_uri = COALESCE(metadata_uri, $10),
           collection_address = COALESCE(collection_address, $11),
           candy_machine_address = COALESCE(candy_machine_address, $12),
           candy_guard_address = COALESCE(candy_guard_address, $13),
           preparation_keys = $14::jsonb,
           locked_at = COALESCE(locked_at, $15),
           ready_at = COALESCE(ready_at, $16),
           version = version + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND version = $2
         AND state = 'PREPARING' AND stage = $17
       RETURNING id`,
      [
        input.releaseId,
        input.expectedVersion.toString(),
        ready ? 'READY' : 'PREPARING',
        input.nextStage,
        input.assetName ?? null,
        input.imageByteLength?.toString() ?? null,
        input.imageSha256 ?? null,
        input.metadataSha256 ?? null,
        input.imageUri ?? null,
        input.metadataUri ?? null,
        input.collectionAddress ?? null,
        input.candyMachineAddress ?? null,
        input.candyGuardAddress ?? null,
        JSON.stringify(mergedKeys),
        input.lockedAt ?? null,
        input.readyAt ?? null,
        input.expectedStage,
      ],
    );
    return { updated: result.rows.length === 1 };
  }

  /** 자동 진행을 멈추고 frozen 값을 유지한 채 운영 오류와 재검사 시각만 기록한다. */
  async block(
    input: Readonly<{
      releaseId: string;
      expectedVersion: bigint;
      errorCode: string;
      errorMessage: string;
      nextAttemptAt: Date;
    }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    const executor = getPgExecutor(this.pool, transaction);
    const release = await this.lockRelease(input.releaseId, transaction);
    if (
      BigInt(release.version) !== input.expectedVersion ||
      release.state === 'READY' ||
      release.state === 'EMPTY'
    ) {
      return { updated: false };
    }
    const result = await executor.query(
      `UPDATE season_nft_releases
       SET state = 'BLOCKED', last_error_code = $3, last_error_message = $4,
           next_attempt_at = $5, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND version = $2 RETURNING id`,
      [
        input.releaseId,
        input.expectedVersion.toString(),
        input.errorCode,
        input.errorMessage,
        input.nextAttemptAt,
      ],
    );
    return { updated: result.rows.length === 1 };
  }

  /** BLOCKED release만 기존 snapshot 유무에 맞는 준비 상태로 되돌려 재검사를 예약한다. */
  async retryBlocked(
    input: Readonly<{ releaseId: string; network: SeasonNftNetwork }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{ updated: boolean }>> {
    const executor = getPgExecutor(this.pool, transaction);
    const release = await this.lockRelease(input.releaseId, transaction);
    if (release.network !== input.network || release.state !== 'BLOCKED') {
      return { updated: false };
    }
    const result = await executor.query(
      `UPDATE season_nft_releases
       SET state = CASE WHEN snapshot_id IS NULL THEN 'WAITING_SNAPSHOT' ELSE 'PREPARING' END,
           last_error_code = NULL, last_error_message = NULL,
           next_attempt_at = CURRENT_TIMESTAMP, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND state = 'BLOCKED' RETURNING id`,
      [input.releaseId],
    );
    return { updated: result.rows.length === 1 };
  }

  /** season을 먼저 잠근 뒤 release를 잠가 모든 release 쓰기의 잠금 순서를 통일한다. */
  private async lockRelease(
    releaseId: string,
    transaction: TransactionContext,
  ): Promise<ReleaseRow> {
    const executor = getPgExecutor(this.pool, transaction);
    const identity = await executor.query<{ season_id: string }>(
      `SELECT season_id FROM season_nft_releases WHERE id = $1`,
      [releaseId],
    );
    if (identity.rows.length === 0)
      throw new Error('Season NFT release was not found.');
    await executor.query(
      `SELECT canvas_id FROM seasons WHERE canvas_id = $1 FOR UPDATE`,
      [identity.rows[0].season_id],
    );
    const result = await executor.query<ReleaseRow>(
      `SELECT ${RELEASE_COLUMNS} FROM season_nft_releases WHERE id = $1 FOR UPDATE`,
      [releaseId],
    );
    return result.rows[0];
  }
}
