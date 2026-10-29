-- 그림 파일 저장 비용은 개설자 지갑이 서명하는 별도 거래로 낸다.
BEGIN;

ALTER TABLE public.season_nft_transactions
    DROP CONSTRAINT season_nft_transactions_kind_check,
    DROP CONSTRAINT season_nft_transactions_attempt_kind_check,
    DROP CONSTRAINT season_nft_transactions_operation_key_check;

ALTER TABLE public.season_nft_transactions
    ADD CONSTRAINT season_nft_transactions_kind_check CHECK (
        kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                 'SETUP_LOCK', 'SETUP_CREATOR_MINT', 'SETUP_STORAGE_FUND',
                 'USER_PROOF', 'USER_MINT')
    ),
    ADD CONSTRAINT season_nft_transactions_attempt_kind_check CHECK (
        (kind IN ('USER_PROOF', 'USER_MINT') AND attempt_id IS NOT NULL)
        OR (kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                     'SETUP_LOCK', 'SETUP_CREATOR_MINT', 'SETUP_STORAGE_FUND')
            AND attempt_id IS NULL)
    ),
    ADD CONSTRAINT season_nft_transactions_operation_key_check CHECK (
        (
            kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                     'SETUP_LOCK', 'SETUP_CREATOR_MINT', 'SETUP_STORAGE_FUND')
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

COMMENT ON CONSTRAINT season_nft_transactions_kind_check
    ON public.season_nft_transactions IS
    'SETUP_STORAGE_FUND는 파일 저장 비용을 개설자 지갑이 Turbo에 내는 거래다.';

COMMIT;
