-- 개설자가 고른 발행 수량과 개설자 지갑으로 바로 넣는 수량을 저장한다.
-- 받을 사람 수에는 상한을 두지 않는다. Candy Machine의 개설자 mintLimit은 u16이라
-- 개설자 몫은 애플리케이션에서 65535개까지로 검증한다.
BEGIN;

ALTER TABLE public.season_nft_releases
    ADD COLUMN supply bigint,
    ADD COLUMN creator_wallet_address text COLLATE "C",
    ADD COLUMN creator_minted_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN nft_description text,
    ADD COLUMN claim_group text;

ALTER TABLE public.season_nft_releases
    DROP CONSTRAINT season_nft_releases_eligible_count_check;

ALTER TABLE public.season_nft_releases
    ADD CONSTRAINT season_nft_releases_eligible_count_check
        CHECK (eligible_count IS NULL OR eligible_count >= 0),
    ADD CONSTRAINT season_nft_releases_supply_check CHECK (
        supply IS NULL OR supply >= 1
    ),
    ADD CONSTRAINT season_nft_releases_supply_covers_eligible_check CHECK (
        supply IS NULL
        OR eligible_count IS NULL
        OR supply >= eligible_count
    ),
    ADD CONSTRAINT season_nft_releases_creator_wallet_check CHECK (
        creator_wallet_address IS NULL
        OR creator_wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    ),
    ADD CONSTRAINT season_nft_releases_creator_minted_count_check
        CHECK (creator_minted_count >= 0),
    ADD CONSTRAINT season_nft_releases_claim_group_check CHECK (
        claim_group IS NULL OR claim_group IN ('claim')
    );

ALTER TABLE public.season_nft_releases
    DROP CONSTRAINT season_nft_releases_ready_check;

ALTER TABLE public.season_nft_releases
    ADD CONSTRAINT season_nft_releases_ready_check CHECK (
        state <> 'READY'
        OR (
            stage = 'LOCKED'
            AND snapshot_id IS NOT NULL
            AND through_sequence IS NOT NULL
            AND eligible_count IS NOT NULL
            AND eligible_count >= 1
            AND frozen_title IS NOT NULL
            AND season_ended_at IS NOT NULL
            AND asset_name IS NOT NULL
            AND image_byte_length IS NOT NULL
            AND image_sha256 IS NOT NULL
            AND metadata_sha256 IS NOT NULL
            AND image_uri IS NOT NULL
            AND metadata_uri IS NOT NULL
            AND collection_address IS NOT NULL
            AND candy_machine_address IS NOT NULL
            AND candy_guard_address IS NOT NULL
            AND (
                merkle_root IS NOT NULL
                OR (supply IS NOT NULL AND eligible_count = 1)
            )
            AND locked_at IS NOT NULL
            AND ready_at IS NOT NULL
            AND (
                supply IS NULL
                OR (
                    creator_wallet_address IS NOT NULL
                    AND creator_minted_count = supply - eligible_count + 1
                )
            )
        )
    );

ALTER TABLE public.season_nft_transactions
    DROP CONSTRAINT season_nft_transactions_kind_check,
    DROP CONSTRAINT season_nft_transactions_attempt_kind_check,
    DROP CONSTRAINT season_nft_transactions_operation_key_check;

ALTER TABLE public.season_nft_transactions
    ADD CONSTRAINT season_nft_transactions_kind_check CHECK (
        kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                 'SETUP_LOCK', 'SETUP_CREATOR_MINT', 'USER_PROOF', 'USER_MINT')
    ),
    ADD CONSTRAINT season_nft_transactions_attempt_kind_check CHECK (
        (kind IN ('USER_PROOF', 'USER_MINT') AND attempt_id IS NOT NULL)
        OR (kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                     'SETUP_LOCK', 'SETUP_CREATOR_MINT')
            AND attempt_id IS NULL)
    ),
    ADD CONSTRAINT season_nft_transactions_operation_key_check CHECK (
        (
            kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                     'SETUP_LOCK', 'SETUP_CREATOR_MINT')
            AND operation_key ~ '^setup:[a-z][a-z0-9_-]*:[0-9]+$'
        )
        OR (
            kind = 'USER_PROOF'
            AND operation_key = 'claim:' || attempt_id::text || ':ALLOWLIST_PROOF'
        )
        OR (
            kind = 'USER_MINT'
            AND operation_key = 'claim:' || attempt_id::text || ':MINT'
        )
    );

COMMENT ON COLUMN public.season_nft_releases.supply IS
    '개설자가 고른 총 발행 수량. 받을 사람 수 이상이며 비어 있으면 예전 자동 준비 기록이다.';
COMMENT ON COLUMN public.season_nft_releases.creator_wallet_address IS
    '개설자 몫 NFT를 받을 지갑. 발행 요청 때 참가 지갑으로 고정한다.';
COMMENT ON COLUMN public.season_nft_releases.creator_minted_count IS
    '개설자 지갑으로 이미 만든 NFT 수. 목표 수량은 supply - eligible_count + 1이다.';
COMMENT ON COLUMN public.season_nft_releases.nft_description IS
    '개설자가 발행 화면에서 입력한 NFT 설명. 비어 있으면 시즌 설명을 쓴다.';
COMMENT ON COLUMN public.season_nft_releases.claim_group IS
    '참가자 수령에 쓰는 Candy Guard 그룹 이름. 개설자 발행본만 claim이며 예전 기계는 NULL이다.';

COMMIT;
