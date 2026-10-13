-- 시즌 정원 무제한, 입장 규칙, SOL 입장료와 입장료 결제 기록을 추가한다.
BEGIN;

ALTER TABLE public.seasons
    ALTER COLUMN capacity DROP NOT NULL;

ALTER TABLE public.seasons
    DROP CONSTRAINT seasons_capacity_check;

ALTER TABLE public.seasons
    ADD CONSTRAINT seasons_capacity_check CHECK (
        capacity IS NULL OR capacity BETWEEN 2 AND 100
    ),
    ADD COLUMN entry_rule varchar(20) NOT NULL DEFAULT 'anyone',
    ADD COLUMN entry_fee_lamports bigint NOT NULL DEFAULT 0,
    ADD COLUMN entry_fee_recipient text COLLATE "C",
    ADD CONSTRAINT seasons_entry_rule_check CHECK (
        entry_rule IN ('anyone', 'wallet_holders')
    ),
    -- 0.001 SOL 미만은 수령 지갑의 rent-exempt 최소 잔액보다 작아 전송이 실패할 수 있다.
    ADD CONSTRAINT seasons_entry_fee_check CHECK (
        entry_fee_lamports = 0
        OR entry_fee_lamports BETWEEN 1000000 AND 100000000000
    ),
    ADD CONSTRAINT seasons_entry_fee_recipient_check CHECK (
        (entry_fee_lamports = 0 AND entry_fee_recipient IS NULL)
        OR (
            entry_fee_lamports > 0
            AND entry_fee_recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        )
    );

COMMENT ON COLUMN public.seasons.capacity IS
    '개설자를 포함한 누적 참가 정원. NULL이면 무제한이며 접속 종료나 재입장으로 감소하거나 중복 증가하지 않는다.';
COMMENT ON COLUMN public.seasons.entry_rule IS
    'anyone이면 손님도 캔버스를 관람하고, wallet_holders이면 지갑으로 로그인한 사용자만 캔버스에 입장한다.';
COMMENT ON COLUMN public.seasons.entry_fee_lamports IS
    '개설자를 제외한 신규 참가자가 내는 lamports 단위 입장료. 0이면 무료다.';
COMMENT ON COLUMN public.seasons.entry_fee_recipient IS
    '입장료를 받는 개설자 지갑 주소. 개설 시 인증 지갑으로 고정하며 무료 시즌은 NULL이다.';

CREATE TABLE IF NOT EXISTS public.season_entry_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    season_id uuid NOT NULL,
    user_id uuid NOT NULL,
    wallet_account_id uuid NOT NULL,
    payer_address text COLLATE "C" NOT NULL,
    recipient_address text COLLATE "C" NOT NULL,
    network varchar(20) NOT NULL,
    lamports bigint NOT NULL,
    status varchar(30) NOT NULL,
    prepared_transaction bytea NOT NULL,
    message_hash char(64) NOT NULL,
    signature text COLLATE "C",
    last_valid_block_height bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_entry_payments_season_id_fkey FOREIGN KEY (season_id)
        REFERENCES public.seasons (canvas_id) ON DELETE RESTRICT,
    CONSTRAINT season_entry_payments_wallet_fkey
        FOREIGN KEY (user_id, wallet_account_id, payer_address)
        REFERENCES public.user_wallets (user_id, id, address) ON DELETE RESTRICT,
    CONSTRAINT season_entry_payments_network_check CHECK (
        network IN ('devnet', 'mainnet-beta')
    ),
    CONSTRAINT season_entry_payments_lamports_check CHECK (lamports > 0),
    CONSTRAINT season_entry_payments_status_check CHECK (
        status IN ('AWAITING_SIGNATURE', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'EXPIRED')
    ),
    CONSTRAINT season_entry_payments_signature_check CHECK (
        status NOT IN ('SUBMITTED', 'CONFIRMED') OR signature IS NOT NULL
    ),
    CONSTRAINT season_entry_payments_message_hash_check CHECK (
        message_hash ~ '^[0-9a-f]{64}$'
    )
);

-- 같은 서명은 한 결제 기록에만 연결한다.
CREATE UNIQUE INDEX IF NOT EXISTS season_entry_payments_signature_key
    ON public.season_entry_payments (signature)
    WHERE signature IS NOT NULL;

-- 사용자별로 서명 대기·제출 중인 결제는 시즌마다 하나만 둔다.
CREATE UNIQUE INDEX IF NOT EXISTS season_entry_payments_open_key
    ON public.season_entry_payments (season_id, user_id)
    WHERE status IN ('AWAITING_SIGNATURE', 'SUBMITTED');

-- 확정 결제는 시즌과 사용자마다 한 번만 기록한다.
CREATE UNIQUE INDEX IF NOT EXISTS season_entry_payments_confirmed_key
    ON public.season_entry_payments (season_id, user_id)
    WHERE status = 'CONFIRMED';

ALTER TABLE public.season_entry_payments ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.season_entry_payments IS
    '유료 시즌 참가자가 개설자 지갑으로 보내는 SOL 입장료 거래. 확정되면 참가 기록을 추가하며 환불하지 않는다.';
COMMENT ON COLUMN public.season_entry_payments.status IS
    'AWAITING_SIGNATURE는 지갑 서명 대기, SUBMITTED는 전송 후 확정 대기, CONFIRMED는 참가 완료, FAILED·EXPIRED는 다시 시작해야 하는 종료 상태다.';
COMMENT ON COLUMN public.season_entry_payments.prepared_transaction IS
    '서버가 만든 미서명 legacy 거래. 제출된 서명 거래의 message가 이 값과 같아야 한다.';
COMMENT ON COLUMN public.season_entry_payments.last_valid_block_height IS
    '준비 거래 blockhash의 마지막 유효 block height. finalized height가 이 값을 넘으면 거래는 더 이상 처리되지 않는다.';
COMMENT ON COLUMN public.season_entry_payments.expires_at IS
    '지갑 서명을 받을 서버 기한. 기한이 지난 서명 대기 결제는 정원을 예약하지 않는다.';

COMMIT;
