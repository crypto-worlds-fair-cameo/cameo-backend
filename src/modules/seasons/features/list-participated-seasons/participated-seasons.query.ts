import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../../../database/pg.constants';
import { getPgExecutor } from '../../../../database/transaction/pg-executor';
import type { TransactionContext } from '../../../../database/transaction/transaction-context';
import type {
  SeasonNftClaimState,
  SeasonNftNetwork,
  SeasonNftReceiptState,
  SeasonNftReleaseStage,
  SeasonNftReleaseState,
} from '../../../season-nfts/resources/season-nft/season-nft';
import type { SeasonNftViewSource } from '../../../season-nfts/resources/season-nft/season-nft-view';

export type ParticipatedSeasonRecord = Readonly<{
  seasonId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  joinedAt: Date;
  cancelledAt: Date | null;
  forceEndedAt: Date | null;
  observedAt: Date;
  ownStrokeCount: number;
  finalImageKey: string | null;
  nftSource: SeasonNftViewSource;
}>;

type ParticipatedSeasonRow = Readonly<{
  season_id: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  joined_at: Date;
  cancelled_at: Date | null;
  force_ended_at: Date | null;
  observed_at: Date;
  participant_wallet_address: string;
  own_stroke_count: number;
  is_creator: boolean;
  entry_fee_lamports: string;
  has_confirmed_payment: boolean;
  final_image_key: string | null;
  release_state: SeasonNftReleaseState | null;
  release_stage: SeasonNftReleaseStage | null;
  snapshot_id: string | null;
  eligible_count: number | null;
  asset_name: string | null;
  image_uri: string | null;
  metadata_uri: string | null;
  last_error_code: string | null;
  claim_state: SeasonNftClaimState | null;
  claim_wallet_address: string | null;
  active_attempt_id: string | null;
  asset_address: string | null;
  mint_signature: string | null;
  receipt_state: SeasonNftReceiptState | null;
  claimed_at: Date | null;
}>;

/** 참여 기록을 기준으로 현재 사용자의 시즌 page와 NFT read model을 DB에서 읽는다. */
@Injectable()
export class ParticipatedSeasonsQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async count(
    userId: string,
    transaction: TransactionContext,
  ): Promise<number> {
    const result = await getPgExecutor(this.pool, transaction).query<{
      total: number;
    }>(
      `SELECT count(*)::integer AS total
       FROM season_participants
       WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0].total;
  }

  async list(
    input: Readonly<{
      userId: string;
      network: SeasonNftNetwork;
      limit: number;
      offset: number;
    }>,
    transaction: TransactionContext,
  ): Promise<ParticipatedSeasonRecord[]> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<ParticipatedSeasonRow>(
      `WITH participant_page AS (
         SELECT season_id, user_id, wallet_address, joined_at
         FROM season_participants
         WHERE user_id = $1
         ORDER BY joined_at DESC, season_id DESC
         LIMIT $3 OFFSET $4
       ), own_usage AS (
         SELECT canvas_id, count(*)::integer AS stroke_count
         FROM canvas_stroke_usages
         WHERE user_id = $1
         GROUP BY canvas_id
       )
       SELECT participant.season_id, season.title,
              canvas.starts_at, canvas.ends_at, participant.joined_at,
              season.cancelled_at, season.force_ended_at,
              CURRENT_TIMESTAMP AS observed_at,
              participant.wallet_address AS participant_wallet_address,
              COALESCE(usage.stroke_count, 0)::integer AS own_stroke_count,
              season.creator_id = $1 AS is_creator,
              season.entry_fee_lamports::text AS entry_fee_lamports,
              EXISTS (
                SELECT 1 FROM season_entry_payments payment
                WHERE payment.season_id = season.canvas_id
                  AND payment.user_id = $1
                  AND payment.status = 'CONFIRMED'
              ) AS has_confirmed_payment,
              final_snapshot.image_key AS final_image_key,
              release.state AS release_state, release.stage AS release_stage,
              release.snapshot_id, release.eligible_count, release.asset_name,
              release.image_uri, release.metadata_uri, release.last_error_code,
              claim.state AS claim_state,
              claim.wallet_address AS claim_wallet_address,
              attempt.id AS active_attempt_id, claim.asset_address,
              claim.mint_signature, claim.receipt_state, claim.claimed_at
       FROM participant_page participant
       JOIN seasons season ON season.canvas_id = participant.season_id
       JOIN canvases canvas
         ON canvas.id = season.canvas_id AND canvas.type = season.canvas_type
       LEFT JOIN own_usage usage ON usage.canvas_id = participant.season_id
       LEFT JOIN canvas_snapshots final_snapshot
         ON final_snapshot.canvas_id = participant.season_id
        AND final_snapshot.status = 'READY' AND final_snapshot.is_final = true
       LEFT JOIN season_nft_releases release
         ON release.season_id = participant.season_id AND release.network = $2
       LEFT JOIN season_nft_claims claim
         ON claim.release_id = release.id AND claim.network = release.network
        AND claim.user_id = $1
       LEFT JOIN LATERAL (
         SELECT candidate.id
         FROM season_nft_claim_attempts candidate
         WHERE candidate.claim_id = claim.id
           AND candidate.state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       ) attempt ON true
       ORDER BY participant.joined_at DESC, participant.season_id DESC`,
      [input.userId, input.network, input.limit, input.offset],
    );
    return result.rows.map(toRecord);
  }
}

function toRecord(row: ParticipatedSeasonRow): ParticipatedSeasonRecord {
  const release: SeasonNftViewSource['release'] =
    row.release_state === null || row.release_stage === null
      ? null
      : {
          state: row.release_state,
          stage: row.release_stage,
          snapshotId: row.snapshot_id,
          eligibleCount: row.eligible_count,
          assetName: row.asset_name,
          imageUri: row.image_uri,
          metadataUri: row.metadata_uri,
          lastErrorCode: row.last_error_code,
        };
  const claim: SeasonNftViewSource['claim'] =
    row.claim_state === null ||
    row.claim_wallet_address === null ||
    row.receipt_state === null
      ? null
      : {
          state: row.claim_state,
          walletAddress: row.claim_wallet_address,
          activeAttemptId: row.active_attempt_id,
          assetAddress: row.asset_address,
          signature: row.mint_signature,
          receiptState: row.receipt_state,
          claimedAt: row.claimed_at,
        };
  return {
    seasonId: row.season_id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    joinedAt: row.joined_at,
    cancelledAt: row.cancelled_at,
    forceEndedAt: row.force_ended_at,
    observedAt: row.observed_at,
    ownStrokeCount: row.own_stroke_count,
    finalImageKey: row.final_image_key,
    nftSource: {
      seasonId: row.season_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      cancelledAt: row.cancelled_at,
      forceEndedAt: row.force_ended_at,
      observedAt: row.observed_at,
      participantWalletAddress: row.participant_wallet_address,
      ownStrokeCount: row.own_stroke_count,
      isCreator: row.is_creator,
      entryFeeLamports: row.entry_fee_lamports,
      hasConfirmedPayment: row.has_confirmed_payment,
      release,
      claim,
    },
  };
}
