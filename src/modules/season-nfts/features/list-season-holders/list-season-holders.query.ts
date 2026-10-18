import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type { SeasonNftNetwork } from '../../resources/season-nft/season-nft';

export type SeasonHolderRecord = Readonly<{
  displayName: string | null;
  walletAddress: string;
  claimed: boolean;
  isCreator: boolean;
  creatorMintedCount: bigint;
}>;

export type SeasonHoldersSource = Readonly<{
  collectionAddress: string | null;
  total: number;
  records: SeasonHolderRecord[];
}>;

type SeasonHoldersRow = Readonly<{
  collection_address: string | null;
  total: number;
  display_name: string | null;
  wallet_address: string | null;
  claimed: boolean | null;
  is_creator: boolean | null;
  creator_minted_count: string | null;
}>;

/**
 * 목록 대상은 개설자와, 유료 시즌이면 입장료 결제가 확정된 참가자, 무료 시즌이면 획을 하나 이상 남긴 참가자다.
 * 개설자를 맨 앞에 두고 참가 지갑과 현재 network의 수령 여부를 한 SQL snapshot에서 읽는다.
 */
@Injectable()
export class ListSeasonHoldersQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 볼 수 없는 시즌이면 null을 반환해 존재 여부를 숨긴다. */
  async find(
    input: Readonly<{
      seasonId: string;
      userId?: string;
      network: SeasonNftNetwork | null;
      searchPattern: string | null;
      limit: number;
      offset: number;
    }>,
    transaction: TransactionContext,
  ): Promise<SeasonHoldersSource | null> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SeasonHoldersRow>(
      `WITH season AS MATERIALIZED (
         SELECT s.canvas_id, s.creator_id, s.entry_fee_lamports,
                release.id AS release_id,
                release.network AS release_network,
                CASE WHEN release.state = 'READY'
                  THEN release.collection_address END AS collection_address,
                COALESCE(release.creator_minted_count, 0)::text AS creator_minted_count
         FROM seasons s
         JOIN canvases c ON c.id = s.canvas_id AND c.type = 'season'
         LEFT JOIN season_nft_releases release
           ON release.season_id = s.canvas_id AND release.network = $3::text
         WHERE s.canvas_id = $1::uuid
           AND (s.cancelled_at IS NULL OR s.creator_id = $2::uuid)
           AND (s.entry_rule = 'anyone' OR $2::uuid IS NOT NULL)
       ), holders AS (
         SELECT p.user_id, p.joined_at, p.wallet_address, u.display_name,
                p.user_id = season.creator_id AS is_creator,
                claim.id IS NOT NULL AS claimed
         FROM season
         JOIN season_participants p ON p.season_id = season.canvas_id
         JOIN users u ON u.id = p.user_id
         LEFT JOIN season_nft_claims claim
           ON claim.release_id = season.release_id
          AND claim.network = season.release_network
          AND claim.user_id = p.user_id
          AND claim.state = 'CLAIMED'
         WHERE (
             p.user_id = season.creator_id
             OR CASE WHEN season.entry_fee_lamports > 0
               THEN EXISTS (
                 SELECT 1 FROM season_entry_payments payment
                 WHERE payment.season_id = p.season_id
                   AND payment.user_id = p.user_id
                   AND payment.status = 'CONFIRMED'
               )
               ELSE EXISTS (
                 SELECT 1 FROM canvas_stroke_usages usage
                 WHERE usage.canvas_id = p.season_id
                   AND usage.user_id = p.user_id
               )
             END
           )
           AND (
             $4::text IS NULL
             OR u.display_name ILIKE $4 ESCAPE '\\'
             OR p.wallet_address ILIKE $4 ESCAPE '\\'
           )
       ), page AS (
         SELECT * FROM holders
         ORDER BY is_creator DESC, joined_at ASC, user_id ASC
         LIMIT $5 OFFSET $6
       )
       SELECT season.collection_address, season.creator_minted_count,
              (SELECT count(*)::integer FROM holders) AS total,
              page.display_name, page.wallet_address, page.claimed, page.is_creator
       FROM season
       LEFT JOIN page ON true
       ORDER BY page.is_creator DESC, page.joined_at ASC, page.user_id ASC`,
      [
        input.seasonId,
        input.userId ?? null,
        input.network,
        input.searchPattern,
        input.limit,
        input.offset,
      ],
    );
    const first = result.rows[0];
    if (!first) return null;
    return {
      collectionAddress: first.collection_address,
      total: first.total,
      records: result.rows.flatMap((row) =>
        row.wallet_address === null
          ? []
          : [
              {
                displayName: row.display_name,
                walletAddress: row.wallet_address,
                claimed: row.claimed === true,
                isCreator: row.is_creator === true,
                creatorMintedCount: BigInt(row.creator_minted_count ?? '0'),
              },
            ],
      ),
    };
  }
}
