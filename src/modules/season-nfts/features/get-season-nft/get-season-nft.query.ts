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
} from '../../resources/season-nft/season-nft';
import type { SeasonNftViewSource } from '../../resources/season-nft/season-nft-view';

type SeasonNftViewRow = Readonly<{
  season_id: string;
  starts_at: Date;
  ends_at: Date;
  cancelled_at: Date | null;
  force_ended_at: Date | null;
  observed_at: Date;
  participant_wallet_address: string | null;
  own_stroke_count: number;
  is_creator: boolean;
  entry_fee_lamports: string;
  has_confirmed_payment: boolean;
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

/** 시즌과 현재 사용자의 참가·usage·claim을 지정 network에서 한 번에 읽는다. */
@Injectable()
export class GetSeasonNftQuery {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async find(
    seasonId: string,
    userId: string,
    network: SeasonNftNetwork,
    transaction: TransactionContext,
  ): Promise<SeasonNftViewSource | null> {
    const result = await getPgExecutor(
      this.pool,
      transaction,
    ).query<SeasonNftViewRow>(
      `WITH own_usage AS (
         SELECT canvas_id, count(*)::integer AS stroke_count
         FROM canvas_stroke_usages
         WHERE user_id = $2
         GROUP BY canvas_id
       )
       SELECT s.canvas_id AS season_id, c.starts_at, c.ends_at,
              s.cancelled_at, s.force_ended_at,
              CURRENT_TIMESTAMP AS observed_at,
              participant.wallet_address AS participant_wallet_address,
              COALESCE(usage.stroke_count, 0)::integer AS own_stroke_count,
              s.creator_id = $2 AS is_creator,
              s.entry_fee_lamports::text AS entry_fee_lamports,
              EXISTS (
                SELECT 1 FROM season_entry_payments payment
                WHERE payment.season_id = s.canvas_id
                  AND payment.user_id = $2
                  AND payment.status = 'CONFIRMED'
              ) AS has_confirmed_payment,
              release.state AS release_state, release.stage AS release_stage,
              release.snapshot_id, release.eligible_count, release.asset_name,
              release.image_uri, release.metadata_uri, release.last_error_code,
              claim.state AS claim_state,
              claim.wallet_address AS claim_wallet_address,
              attempt.id AS active_attempt_id, claim.asset_address,
              claim.mint_signature, claim.receipt_state, claim.claimed_at
       FROM seasons s
       JOIN canvases c ON c.id = s.canvas_id AND c.type = s.canvas_type
       LEFT JOIN season_participants participant
         ON participant.season_id = s.canvas_id AND participant.user_id = $2
       LEFT JOIN own_usage usage ON usage.canvas_id = s.canvas_id
       LEFT JOIN season_nft_releases release
         ON release.season_id = s.canvas_id AND release.network = $3
       LEFT JOIN season_nft_claims claim
         ON claim.release_id = release.id AND claim.network = release.network
        AND claim.user_id = $2
       LEFT JOIN LATERAL (
         SELECT candidate.id
         FROM season_nft_claim_attempts candidate
         WHERE candidate.claim_id = claim.id
           AND candidate.state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING')
         ORDER BY candidate.created_at DESC, candidate.id DESC
         LIMIT 1
       ) attempt ON true
       WHERE s.canvas_id = $1`,
      [seasonId, userId, network],
    );
    const row = result.rows[0];
    return row ? toSource(row) : null;
  }
}

function toSource(row: SeasonNftViewRow): SeasonNftViewSource {
  return {
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
    release:
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
          },
    claim:
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
          },
  };
}
