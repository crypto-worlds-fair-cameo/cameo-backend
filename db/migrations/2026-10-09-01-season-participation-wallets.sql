-- 로그인에서 검증한 지갑을 세션과 시즌 참가 기록에 고정한다.
BEGIN;

-- 과거 행의 지갑을 추정하지 않는다. 운영자는 전용 초기화 도구로 구세션과 개발 시즌을 먼저 제거한다.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.auth_sessions) THEN
        RAISE EXCEPTION
            'Existing auth sessions have no verified wallet binding. Run the development season reset before this migration.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.season_participants) THEN
        RAISE EXCEPTION
            'Existing season participants have no verified wallet binding. Run the development season reset before this migration.';
    END IF;
END $$;

ALTER TABLE public.user_wallets
    ADD CONSTRAINT user_wallets_user_id_id_key UNIQUE (user_id, id),
    ADD CONSTRAINT user_wallets_user_id_id_address_key
        UNIQUE (user_id, id, address);

ALTER TABLE public.auth_sessions
    ADD COLUMN wallet_account_id uuid NOT NULL,
    ADD CONSTRAINT auth_sessions_user_wallet_fk
        FOREIGN KEY (user_id, wallet_account_id)
        REFERENCES public.user_wallets (user_id, id) ON DELETE RESTRICT;

ALTER TABLE public.season_participants
    ADD COLUMN wallet_account_id uuid NOT NULL,
    ADD COLUMN wallet_address text COLLATE "C" NOT NULL,
    ADD CONSTRAINT season_participant_wallet_fk
        FOREIGN KEY (user_id, wallet_account_id, wallet_address)
        REFERENCES public.user_wallets (user_id, id, address) ON DELETE RESTRICT,
    ADD CONSTRAINT season_wallet_unique UNIQUE (season_id, wallet_address),
    ADD CONSTRAINT season_participant_wallet_address_check CHECK (
        wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND wallet_address = btrim(wallet_address)
    );

COMMENT ON COLUMN public.auth_sessions.wallet_account_id IS
    'SIWS 서명을 검증해 이 세션에 고정한 사용자 소유 Solana 지갑.';
COMMENT ON COLUMN public.season_participants.wallet_account_id IS
    '참가 요청을 인증한 사용자 소유 Solana 지갑. 참가 후 변경하지 않는다.';
COMMENT ON COLUMN public.season_participants.wallet_address IS
    '참가 시점의 대소문자를 보존한 Solana 주소. NFT 수령 자격에 사용한다.';

COMMIT;
