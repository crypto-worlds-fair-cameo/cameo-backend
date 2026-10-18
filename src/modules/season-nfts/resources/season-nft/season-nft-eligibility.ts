/** 개설자 발행에 쓰는 받을 사람 명단. 개설자는 항상 포함하고, 유료 시즌은 결제가 확정된 참가자, 무료 시즌은 획을 남긴 참가자만 포함한다. */
export const CREATOR_MINT_ELIGIBILITY_SQL = `
  SELECT p.user_id,
         p.user_id AS participant_user_id,
         p.wallet_account_id,
         p.wallet_address COLLATE "C" AS wallet_address,
         w.id AS verified_wallet_id,
         w.user_id AS wallet_user_id,
         w.address AS verified_address,
         w.chain_namespace
  FROM season_participants p
  JOIN seasons s ON s.canvas_id = p.season_id
  LEFT JOIN user_wallets w ON w.id = p.wallet_account_id
  WHERE p.season_id = $1
    AND (
      p.user_id = s.creator_id
      OR (
        s.entry_fee_lamports > 0
        AND EXISTS (
          SELECT 1 FROM season_entry_payments payment
          WHERE payment.season_id = p.season_id
            AND payment.user_id = p.user_id
            AND payment.status = 'CONFIRMED'
        )
      )
      OR (
        s.entry_fee_lamports = 0
        AND EXISTS (
          SELECT 1 FROM canvas_stroke_usages usage
          WHERE usage.canvas_id = p.season_id
            AND usage.user_id = p.user_id
        )
      )
    )
  ORDER BY p.wallet_address COLLATE "C" ASC NULLS FIRST, p.user_id ASC`;

/** 수량을 고르기 전에 만든 자동 준비 기록은 예전처럼 획을 남긴 사람만 고정한다. */
export const LEGACY_ELIGIBILITY_SQL = `
  SELECT DISTINCT u.user_id, p.user_id AS participant_user_id,
         p.wallet_account_id, p.wallet_address COLLATE "C" AS wallet_address,
         w.id AS verified_wallet_id, w.user_id AS wallet_user_id,
         w.address AS verified_address, w.chain_namespace
  FROM canvas_stroke_usages u
  LEFT JOIN season_participants p
    ON p.season_id = u.canvas_id AND p.user_id = u.user_id
  LEFT JOIN user_wallets w ON w.id = p.wallet_account_id
  WHERE u.canvas_id = $1
  ORDER BY p.wallet_address COLLATE "C" ASC NULLS FIRST, u.user_id ASC`;

/** Candy Guard mintLimit.limit 이 u16 이라 개설자 몫은 이 값을 넘길 수 없다. */
export const MAX_CREATOR_ALLOCATION = 65_535;

/** 참가자 수령 그룹 이름. Candy Guard 라벨은 6바이트를 넘기면 안 된다. */
export const CLAIM_GUARD_GROUP = 'claim';

/** 개설자 몫 그룹 이름. */
export const CREATOR_GUARD_GROUP = 'owner';
