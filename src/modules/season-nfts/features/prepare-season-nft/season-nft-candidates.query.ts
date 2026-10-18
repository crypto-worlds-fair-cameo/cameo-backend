import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type { SeasonNftNetwork } from '../../resources/season-nft/season-nft';
import {
  CREATOR_MINT_ELIGIBILITY_SQL,
  LEGACY_ELIGIBILITY_SQL,
} from '../../resources/season-nft/season-nft-eligibility';

export type SeasonNftEligibilitySourceRow = Readonly<{
  userId: string;
  participantUserId: string | null;
  walletAccountId: string | null;
  walletAddress: string | null;
  verifiedWalletId: string | null;
  walletUserId: string | null;
  verifiedAddress: string | null;
  chainNamespace: string | null;
}>;

export type SeasonNftFreezeSource = Readonly<{
  seasonId: string;
  title: string;
  description: string | null;
  endedAt: Date;
  creatorId: string;
  supply: bigint | null;
  creatorWalletAddress: string | null;
  nftDescription: string | null;
  eligibility: readonly SeasonNftEligibilitySourceRow[];
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

function toEligibility(row: EligibilityRow): SeasonNftEligibilitySourceRow {
  return {
    userId: row.user_id,
    participantUserId: row.participant_user_id,
    walletAccountId: row.wallet_account_id,
    walletAddress: row.wallet_address,
    verifiedWalletId: row.verified_wallet_id,
    walletUserId: row.wallet_user_id,
    verifiedAddress: row.verified_address,
    chainNamespace: row.chain_namespace,
  };
}

/** 정상 종료 후보와 freeze에 필요한 usage·고정 참가 지갑 원본을 읽는다. */
@Injectable()
export class SeasonNftCandidatesQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 취소·강제 종료를 제외한 정상 종료 시즌 ID를 UUID 순서로 반환한다. */
  async findNormallyEnded(afterId?: string, limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT c.id
       FROM canvases c
       JOIN seasons s ON s.canvas_id = c.id
       WHERE c.type = 'season' AND c.ends_at <= CURRENT_TIMESTAMP
         AND s.cancelled_at IS NULL AND s.force_ended_at IS NULL
         AND ($1::uuid IS NULL OR c.id > $1::uuid)
       ORDER BY c.id ASC
       LIMIT $2`,
      [afterId ?? null, limit],
    );
    return result.rows.map((row) => row.id);
  }

  /** configured network에 release가 아직 없는 정상 종료 시즌만 신규 worker 후보로 제한한다. */
  async findUnreleased(
    network: SeasonNftNetwork,
    limit = 100,
  ): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT c.id
       FROM canvases c
       JOIN seasons s ON s.canvas_id = c.id
       WHERE c.type = 'season' AND c.ends_at <= CURRENT_TIMESTAMP
         AND s.cancelled_at IS NULL AND s.force_ended_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM season_nft_releases r
           WHERE r.season_id = c.id AND r.network = $1
         )
       ORDER BY c.id ASC
       LIMIT $2`,
      [network, limit],
    );
    return result.rows.map((row) => row.id);
  }

  /** 시즌 공통값과 발행 수량에 맞는 받을 사람 명단을 읽는다. */
  async readFreezeSource(
    seasonId: string,
    network: SeasonNftNetwork,
    transaction?: TransactionContext,
  ): Promise<SeasonNftFreezeSource | null> {
    const executor = getPgExecutor(this.pool, transaction);
    const season = await executor.query<{
      canvas_id: string;
      title: string;
      description: string | null;
      ends_at: Date;
      creator_id: string;
      supply: string | null;
      creator_wallet_address: string | null;
      nft_description: string | null;
    }>(
      `SELECT s.canvas_id, s.title, s.description, c.ends_at, s.creator_id,
              r.supply::text AS supply, r.creator_wallet_address, r.nft_description
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id
       LEFT JOIN season_nft_releases r
         ON r.season_id = s.canvas_id AND r.network = $2
       WHERE s.canvas_id = $1 AND c.type = 'season'
         AND s.cancelled_at IS NULL
         AND (r.supply IS NOT NULL OR s.force_ended_at IS NULL)
         AND (s.force_ended_at IS NOT NULL OR c.ends_at <= CURRENT_TIMESTAMP)`,
      [seasonId, network],
    );
    const row = season.rows[0];
    if (!row) return null;
    const creatorMint = row.supply !== null;
    const eligibility = await executor.query<EligibilityRow>(
      creatorMint ? CREATOR_MINT_ELIGIBILITY_SQL : LEGACY_ELIGIBILITY_SQL,
      [seasonId],
    );
    return {
      seasonId: row.canvas_id,
      title: row.title,
      description: row.description,
      endedAt: row.ends_at,
      creatorId: row.creator_id,
      supply: row.supply === null ? null : BigInt(row.supply),
      creatorWalletAddress: row.creator_wallet_address,
      nftDescription: row.nft_description,
      eligibility: eligibility.rows.map(toEligibility),
    };
  }
}
