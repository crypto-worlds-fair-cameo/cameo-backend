import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type {
  SeasonNftNetwork,
  SeasonNftReleaseState,
  SeasonNftTransactionKind,
} from '../../resources/season-nft/season-nft';
import { CREATOR_MINT_ELIGIBILITY_SQL } from '../../resources/season-nft/season-nft-eligibility';
import type { SeasonNftEligibilitySourceRow } from '../prepare-season-nft/season-nft-candidates.query';

export type SeasonNftMintSeason = Readonly<{
  seasonId: string;
  creatorId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  cancelled: boolean;
  ended: boolean;
  creatorWalletAddress: string | null;
  strokeCount: bigint;
  imageKey: string | null;
  eligibility: readonly SeasonNftEligibilitySourceRow[];
  release: Readonly<{
    id: string;
    state: SeasonNftReleaseState;
    version: bigint;
    supply: bigint | null;
    eligibleCount: number | null;
    creatorWalletAddress: string | null;
    creatorMintedCount: bigint;
    nftDescription: string | null;
    lastErrorCode: string | null;
    collectionAddress: string | null;
  }> | null;
  pendingTransaction: Readonly<{
    id: string;
    kind: SeasonNftTransactionKind;
    serializedTransaction: Buffer;
  }> | null;
}>;

type EligibilityRow = {
  user_id: string;
  participant_user_id: string | null;
  wallet_account_id: string | null;
  wallet_address: string | null;
  verified_wallet_id: string | null;
  wallet_user_id: string | null;
  verified_address: string | null;
  chain_namespace: string | null;
};

/** 발행 화면이 읽는 시즌, 받을 사람, 스냅샷, 진행 중 서명을 한 트랜잭션에서 모은다. */
@Injectable()
export class SeasonNftMintQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async load(
    seasonId: string,
    network: SeasonNftNetwork,
    transaction?: TransactionContext,
    lock = false,
  ): Promise<SeasonNftMintSeason | null> {
    const executor = getPgExecutor(this.pool, transaction);
    const season = await executor.query<{
      canvas_id: string;
      creator_id: string;
      title: string;
      description: string | null;
      starts_at: Date;
      ends_at: Date;
      cancelled_at: Date | null;
      force_ended_at: Date | null;
      observed_at: Date;
      creator_wallet: string | null;
    }>(
      `SELECT s.canvas_id, s.creator_id, s.title, s.description,
              c.starts_at, c.ends_at, s.cancelled_at, s.force_ended_at,
              CURRENT_TIMESTAMP AS observed_at,
              p.wallet_address AS creator_wallet
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = 'season'
       LEFT JOIN season_participants p
         ON p.season_id = s.canvas_id AND p.user_id = s.creator_id
       WHERE s.canvas_id = $1
       ${lock ? 'FOR UPDATE OF s' : ''}`,
      [seasonId],
    );
    const row = season.rows[0];
    if (!row) return null;
    const eligibility = await executor.query<EligibilityRow>(
      CREATOR_MINT_ELIGIBILITY_SQL,
      [seasonId],
    );
    const strokes = await executor.query<{ stroke_count: string }>(
      `SELECT count(*)::text AS stroke_count
       FROM canvas_stroke_usages WHERE canvas_id = $1`,
      [seasonId],
    );
    const snapshot = await executor.query<{ image_key: string }>(
      `SELECT image_key
       FROM canvas_snapshots
       WHERE canvas_id = $1 AND status = 'READY' AND is_final = true
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [seasonId],
    );
    const release = await executor.query<{
      id: string;
      state: SeasonNftReleaseState;
      version: string;
      supply: string | null;
      eligible_count: number | null;
      creator_wallet_address: string | null;
      creator_minted_count: string;
      nft_description: string | null;
      last_error_code: string | null;
      collection_address: string | null;
    }>(
      `SELECT id, state, version::text AS version, supply::text AS supply,
              eligible_count, creator_wallet_address,
              creator_minted_count::text AS creator_minted_count,
              nft_description, last_error_code, collection_address
       FROM season_nft_releases
       WHERE season_id = $1 AND network = $2`,
      [seasonId, network],
    );
    const current = release.rows[0] ?? null;
    const pending = current
      ? await executor.query<{
          id: string;
          kind: SeasonNftTransactionKind;
          serialized_transaction: Buffer;
        }>(
          `SELECT id, kind, serialized_transaction
           FROM season_nft_transactions
           WHERE release_id = $1 AND state = 'PREPARED'
             AND kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                          'SETUP_LOCK', 'SETUP_CREATOR_MINT')
           ORDER BY created_at ASC, id ASC
           LIMIT 1`,
          [current.id],
        )
      : { rows: [] };
    const pendingRow = pending.rows[0] ?? null;
    return {
      seasonId: row.canvas_id,
      creatorId: row.creator_id,
      title: row.title,
      description: row.description,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      cancelled: row.cancelled_at !== null,
      ended:
        row.force_ended_at !== null ||
        row.ends_at.getTime() <= row.observed_at.getTime(),
      creatorWalletAddress: row.creator_wallet,
      strokeCount: BigInt(strokes.rows[0]?.stroke_count ?? '0'),
      imageKey: snapshot.rows[0]?.image_key ?? null,
      eligibility: eligibility.rows.map((member) => ({
        userId: member.user_id,
        participantUserId: member.participant_user_id,
        walletAccountId: member.wallet_account_id,
        walletAddress: member.wallet_address,
        verifiedWalletId: member.verified_wallet_id,
        walletUserId: member.wallet_user_id,
        verifiedAddress: member.verified_address,
        chainNamespace: member.chain_namespace,
      })),
      release: current
        ? {
            id: current.id,
            state: current.state,
            version: BigInt(current.version),
            supply: current.supply === null ? null : BigInt(current.supply),
            eligibleCount: current.eligible_count,
            creatorWalletAddress: current.creator_wallet_address,
            creatorMintedCount: BigInt(current.creator_minted_count),
            nftDescription: current.nft_description,
            lastErrorCode: current.last_error_code,
            collectionAddress: current.collection_address,
          }
        : null,
      pendingTransaction: pendingRow
        ? {
            id: pendingRow.id,
            kind: pendingRow.kind,
            serializedTransaction: pendingRow.serialized_transaction,
          }
        : null,
    };
  }

  /** 이 시즌의 준비 거래가 개설자 서명 대상인지 확인한다. */
  async findOwnedSetup(
    input: Readonly<{ seasonId: string; transactionId: string }>,
    transaction: TransactionContext,
  ): Promise<Readonly<{
    transactionId: string;
    network: SeasonNftNetwork;
    state: string;
    messageHash: string;
    serializedTransaction: Buffer;
    creatorId: string;
    creatorWalletAddress: string | null;
  }> | null> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      id: string;
      network: SeasonNftNetwork;
      state: string;
      message_hash: string;
      serialized_transaction: Buffer;
      creator_id: string;
      creator_wallet_address: string | null;
    }>(
      `SELECT t.id, t.network, t.state, t.message_hash, t.serialized_transaction,
              s.creator_id, r.creator_wallet_address
       FROM season_nft_transactions t
       JOIN season_nft_releases r ON r.id = t.release_id AND r.network = t.network
       JOIN seasons s ON s.canvas_id = r.season_id
       WHERE t.id = $1 AND r.season_id = $2
         AND t.kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                        'SETUP_LOCK', 'SETUP_CREATOR_MINT')`,
      [input.transactionId, input.seasonId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      transactionId: row.id,
      network: row.network,
      state: row.state,
      messageHash: row.message_hash,
      serializedTransaction: row.serialized_transaction,
      creatorId: row.creator_id,
      creatorWalletAddress: row.creator_wallet_address,
    };
  }
}
