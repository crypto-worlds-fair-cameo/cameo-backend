-- 시즌별 NFT 준비, 수령, 거래와 영구 미디어 복구 상태를 저장한다.
BEGIN;

ALTER TABLE public.canvas_snapshots
    ADD CONSTRAINT canvas_snapshots_canvas_id_id_key UNIQUE (canvas_id, id);

CREATE TABLE public.season_nft_releases (
    id uuid PRIMARY KEY,
    season_id uuid NOT NULL REFERENCES public.seasons (canvas_id) ON DELETE RESTRICT,
    network text NOT NULL,
    state text NOT NULL,
    stage text NOT NULL,
    snapshot_id uuid,
    through_sequence bigint,
    eligible_count integer,
    frozen_title text,
    frozen_description text,
    season_ended_at timestamptz,
    asset_name text,
    image_byte_length bigint,
    image_sha256 text,
    metadata_sha256 text,
    image_uri text,
    metadata_uri text,
    collection_address text,
    candy_machine_address text,
    candy_guard_address text,
    merkle_root bytea,
    preparation_keys jsonb NOT NULL DEFAULT '{}'::jsonb,
    locked_at timestamptz,
    ready_at timestamptz,
    retry_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error_code text,
    last_error_message text,
    version bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_nft_releases_network_check
        CHECK (network IN ('devnet', 'mainnet-beta')),
    CONSTRAINT season_nft_releases_state_check
        CHECK (state IN ('WAITING_SNAPSHOT', 'PREPARING', 'READY', 'EMPTY', 'BLOCKED')),
    CONSTRAINT season_nft_releases_stage_check
        CHECK (stage IN ('SNAPSHOT', 'FROZEN', 'IMAGE', 'METADATA', 'COLLECTION', 'MACHINE', 'LOCKED')),
    CONSTRAINT season_nft_releases_snapshot_fk
        FOREIGN KEY (season_id, snapshot_id)
        REFERENCES public.canvas_snapshots (canvas_id, id) ON DELETE RESTRICT,
    CONSTRAINT season_nft_releases_through_sequence_check
        CHECK (through_sequence IS NULL OR through_sequence >= 0),
    CONSTRAINT season_nft_releases_eligible_count_check
        CHECK (eligible_count IS NULL OR eligible_count BETWEEN 0 AND 100),
    CONSTRAINT season_nft_releases_image_byte_length_check
        CHECK (image_byte_length IS NULL OR image_byte_length > 0),
    CONSTRAINT season_nft_releases_image_sha256_check
        CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT season_nft_releases_metadata_sha256_check
        CHECK (metadata_sha256 IS NULL OR metadata_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT season_nft_releases_merkle_root_check
        CHECK (merkle_root IS NULL OR octet_length(merkle_root) = 32),
    CONSTRAINT season_nft_releases_preparation_keys_check
        CHECK (jsonb_typeof(preparation_keys) = 'object'),
    CONSTRAINT season_nft_releases_retry_count_check CHECK (retry_count >= 0),
    CONSTRAINT season_nft_releases_version_check CHECK (version >= 0),
    CONSTRAINT season_nft_releases_ready_check CHECK (
        state <> 'READY'
        OR (
            stage = 'LOCKED'
            AND snapshot_id IS NOT NULL
            AND through_sequence IS NOT NULL
            AND eligible_count IS NOT NULL
            AND eligible_count BETWEEN 1 AND 100
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
            AND merkle_root IS NOT NULL
            AND locked_at IS NOT NULL
            AND ready_at IS NOT NULL
        )
    ),
    CONSTRAINT season_nft_releases_empty_check CHECK (
        state <> 'EMPTY'
        OR (
            eligible_count IS NOT NULL
            AND eligible_count = 0
            AND image_uri IS NULL
            AND metadata_uri IS NULL
            AND collection_address IS NULL
            AND candy_machine_address IS NULL
            AND candy_guard_address IS NULL
            AND merkle_root IS NULL
            AND locked_at IS NULL
            AND ready_at IS NULL
        )
    )
);

ALTER TABLE public.season_nft_releases
    ADD CONSTRAINT season_nft_releases_id_network_key UNIQUE (id, network),
    ADD CONSTRAINT season_nft_releases_season_network_key UNIQUE (season_id, network);

CREATE INDEX season_nft_release_due_idx
    ON public.season_nft_releases (state, next_attempt_at, id);

CREATE TABLE public.season_nft_claims (
    id uuid PRIMARY KEY,
    release_id uuid NOT NULL,
    network text NOT NULL,
    user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    wallet_account_id uuid NOT NULL,
    wallet_address text COLLATE "C" NOT NULL,
    state text NOT NULL DEFAULT 'UNCLAIMED',
    merkle_proof jsonb NOT NULL,
    asset_address text,
    mint_signature text,
    claimed_at timestamptz,
    receipt_state text NOT NULL DEFAULT 'NONE',
    receipt_next_check_at timestamptz,
    receipt_retry_count integer NOT NULL DEFAULT 0,
    receipt_history_before text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_nft_claims_release_network_fk
        FOREIGN KEY (release_id, network)
        REFERENCES public.season_nft_releases (id, network) ON DELETE RESTRICT,
    CONSTRAINT season_nft_claims_user_wallet_fk
        FOREIGN KEY (user_id, wallet_account_id, wallet_address)
        REFERENCES public.user_wallets (user_id, id, address) ON DELETE RESTRICT,
    CONSTRAINT season_nft_claims_network_check
        CHECK (network IN ('devnet', 'mainnet-beta')),
    CONSTRAINT season_nft_claims_state_check
        CHECK (state IN ('UNCLAIMED', 'PROCESSING', 'CLAIMED')),
    CONSTRAINT season_nft_claims_receipt_state_check
        CHECK (receipt_state IN ('NONE', 'RESOLVING', 'VERIFIED')),
    CONSTRAINT season_nft_claims_wallet_address_check CHECK (
        wallet_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        AND wallet_address = btrim(wallet_address)
    ),
    CONSTRAINT season_nft_claims_merkle_proof_check
        CHECK (jsonb_typeof(merkle_proof) = 'array'),
    CONSTRAINT season_nft_claims_asset_address_check CHECK (
        asset_address IS NULL
        OR (
            asset_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
            AND asset_address = btrim(asset_address)
        )
    ),
    CONSTRAINT season_nft_claims_receipt_retry_count_check
        CHECK (receipt_retry_count >= 0),
    CONSTRAINT season_nft_claims_state_receipt_check CHECK (
        (state = 'CLAIMED' AND receipt_state IN ('RESOLVING', 'VERIFIED'))
        OR (state IN ('UNCLAIMED', 'PROCESSING') AND receipt_state = 'NONE')
    ),
    CONSTRAINT season_nft_claims_receipt_due_check CHECK (
        (receipt_state = 'RESOLVING' AND receipt_next_check_at IS NOT NULL)
        OR (receipt_state <> 'RESOLVING' AND receipt_next_check_at IS NULL)
    ),
    CONSTRAINT season_nft_claims_verified_check CHECK (
        receipt_state <> 'VERIFIED'
        OR (
            state = 'CLAIMED'
            AND asset_address IS NOT NULL
            AND mint_signature IS NOT NULL
            AND claimed_at IS NOT NULL
        )
    )
);

ALTER TABLE public.season_nft_claims
    ADD CONSTRAINT season_nft_claims_id_release_key UNIQUE (id, release_id),
    ADD CONSTRAINT season_nft_claims_release_user_key UNIQUE (release_id, user_id),
    ADD CONSTRAINT season_nft_claims_release_wallet_key UNIQUE (release_id, wallet_address),
    ADD CONSTRAINT season_nft_claims_network_asset_key UNIQUE (network, asset_address);

CREATE INDEX season_nft_claim_receipt_due_idx
    ON public.season_nft_claims (receipt_next_check_at, id)
    WHERE state = 'CLAIMED' AND receipt_state = 'RESOLVING';

CREATE TABLE public.season_nft_claim_attempts (
    id uuid PRIMARY KEY,
    claim_id uuid NOT NULL REFERENCES public.season_nft_claims (id) ON DELETE RESTRICT,
    state text NOT NULL,
    step text NOT NULL,
    asset_address text,
    last_error_code text,
    retry_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_nft_claim_attempts_state_check CHECK (
        state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING',
                  'SUCCEEDED', 'EXPIRED', 'FAILED')
    ),
    CONSTRAINT season_nft_claim_attempts_step_check
        CHECK (step IN ('ALLOWLIST_PROOF', 'MINT')),
    CONSTRAINT season_nft_claim_attempts_asset_address_check CHECK (
        asset_address IS NULL
        OR (
            asset_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
            AND asset_address = btrim(asset_address)
        )
    ),
    CONSTRAINT season_nft_claim_attempts_retry_count_check
        CHECK (retry_count >= 0)
);

ALTER TABLE public.season_nft_claim_attempts
    ADD CONSTRAINT season_nft_claim_attempts_id_claim_key UNIQUE (id, claim_id);

CREATE UNIQUE INDEX season_nft_one_active_attempt
    ON public.season_nft_claim_attempts (claim_id)
    WHERE state IN ('QUEUED', 'AWAITING_SIGNATURE', 'SUBMITTING', 'CONFIRMING');
CREATE INDEX season_nft_attempt_due_idx
    ON public.season_nft_claim_attempts (next_attempt_at, id)
    WHERE state IN ('QUEUED', 'SUBMITTING', 'CONFIRMING');

CREATE TABLE public.season_nft_transactions (
    id uuid PRIMARY KEY,
    network text NOT NULL,
    release_id uuid NOT NULL,
    attempt_id uuid,
    operation_key text NOT NULL,
    kind text NOT NULL,
    state text NOT NULL,
    message_hash text NOT NULL,
    serialized_transaction bytea NOT NULL,
    signature text,
    recent_blockhash text NOT NULL,
    last_valid_block_height bigint NOT NULL,
    asset_address text,
    estimated_cost_lamports bigint,
    estimated_at timestamptz,
    cost_breakdown jsonb,
    reconciliation_evidence jsonb,
    next_check_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    confirmation_check_count integer NOT NULL DEFAULT 0,
    retry_count integer NOT NULL DEFAULT 0,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_nft_transactions_release_network_fk
        FOREIGN KEY (release_id, network)
        REFERENCES public.season_nft_releases (id, network) ON DELETE RESTRICT,
    CONSTRAINT season_nft_transactions_attempt_fk
        FOREIGN KEY (attempt_id)
        REFERENCES public.season_nft_claim_attempts (id) ON DELETE RESTRICT,
    CONSTRAINT season_nft_transactions_network_check
        CHECK (network IN ('devnet', 'mainnet-beta')),
    CONSTRAINT season_nft_transactions_kind_check CHECK (
        kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD',
                 'SETUP_LOCK', 'USER_PROOF', 'USER_MINT')
    ),
    CONSTRAINT season_nft_transactions_state_check CHECK (
        state IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED', 'FINALIZED',
                  'RECONCILED', 'FAILED', 'EXPIRED')
    ),
    CONSTRAINT season_nft_transactions_message_hash_check
        CHECK (message_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT season_nft_transactions_serialized_check
        CHECK (octet_length(serialized_transaction) > 0),
    CONSTRAINT season_nft_transactions_block_height_check
        CHECK (last_valid_block_height >= 0),
    CONSTRAINT season_nft_transactions_confirmation_check_count_check
        CHECK (confirmation_check_count >= 0),
    CONSTRAINT season_nft_transactions_retry_count_check
        CHECK (retry_count >= 0),
    CONSTRAINT season_nft_transactions_asset_address_check CHECK (
        asset_address IS NULL
        OR (
            asset_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
            AND asset_address = btrim(asset_address)
        )
    ),
    CONSTRAINT season_nft_transactions_estimated_cost_check
        CHECK (estimated_cost_lamports IS NULL OR estimated_cost_lamports >= 0),
    CONSTRAINT season_nft_transactions_quote_pair_check CHECK (
        (estimated_cost_lamports IS NULL) = (estimated_at IS NULL)
    ),
    CONSTRAINT season_nft_transactions_user_quote_check CHECK (
        kind NOT IN ('USER_PROOF', 'USER_MINT')
        OR state <> 'PREPARED'
        OR (estimated_cost_lamports IS NOT NULL AND estimated_at IS NOT NULL)
    ),
    CONSTRAINT season_nft_transactions_cost_breakdown_check
        CHECK (cost_breakdown IS NULL OR jsonb_typeof(cost_breakdown) = 'object'),
    CONSTRAINT season_nft_transactions_reconciled_check CHECK (
        state <> 'RECONCILED'
        OR (
            reconciliation_evidence IS NOT NULL
            AND jsonb_typeof(reconciliation_evidence) = 'object'
        )
    ),
    CONSTRAINT season_nft_transactions_attempt_kind_check CHECK (
        (kind IN ('USER_PROOF', 'USER_MINT') AND attempt_id IS NOT NULL)
        OR (kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD', 'SETUP_LOCK')
            AND attempt_id IS NULL)
    ),
    CONSTRAINT season_nft_transactions_operation_key_check CHECK (
        (
            kind IN ('SETUP_COLLECTION', 'SETUP_MACHINE', 'SETUP_GUARD', 'SETUP_LOCK')
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
    )
);

CREATE UNIQUE INDEX season_nft_one_live_or_completed_operation
    ON public.season_nft_transactions (network, release_id, operation_key)
    WHERE state IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED',
                    'FINALIZED', 'RECONCILED');
CREATE UNIQUE INDEX season_nft_transaction_signature_unique
    ON public.season_nft_transactions (network, signature)
    WHERE signature IS NOT NULL;
CREATE INDEX season_nft_transaction_due_idx
    ON public.season_nft_transactions (next_check_at, id)
    WHERE state IN ('PREPARED', 'SIGNED', 'SUBMITTED', 'CONFIRMED');

CREATE TABLE public.season_nft_uploads (
    id uuid PRIMARY KEY,
    release_id uuid NOT NULL REFERENCES public.season_nft_releases (id) ON DELETE RESTRICT,
    kind text NOT NULL,
    sha256 text NOT NULL,
    byte_length bigint NOT NULL,
    data_item_id text NOT NULL,
    signed_item_path text NOT NULL,
    state text NOT NULL,
    uri text,
    receipt jsonb,
    verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT season_nft_uploads_kind_check CHECK (kind IN ('IMAGE', 'METADATA')),
    CONSTRAINT season_nft_uploads_state_check
        CHECK (state IN ('PREPARED', 'UPLOADED', 'VERIFIED', 'FAILED')),
    CONSTRAINT season_nft_uploads_sha256_check
        CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT season_nft_uploads_byte_length_check CHECK (byte_length > 0),
    CONSTRAINT season_nft_uploads_data_item_id_check CHECK (data_item_id <> ''),
    CONSTRAINT season_nft_uploads_signed_item_path_check CHECK (
        signed_item_path <> ''
        AND signed_item_path !~ '^/'
        AND signed_item_path !~ '(^|/)\.\.(/|$)'
    ),
    CONSTRAINT season_nft_uploads_receipt_check CHECK (
        state NOT IN ('UPLOADED', 'VERIFIED') OR receipt IS NOT NULL
    ),
    CONSTRAINT season_nft_uploads_verified_check CHECK (
        state <> 'VERIFIED'
        OR (uri IS NOT NULL AND verified_at IS NOT NULL AND receipt IS NOT NULL)
    )
);

ALTER TABLE public.season_nft_uploads
    ADD CONSTRAINT season_nft_uploads_release_kind_key UNIQUE (release_id, kind),
    ADD CONSTRAINT season_nft_uploads_data_item_id_key UNIQUE (data_item_id);

-- 브라우저에서 직접 읽거나 쓰지 않고 서버 DB role만 기존 연결 방식으로 접근한다.
ALTER TABLE public.season_nft_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_nft_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_nft_claim_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_nft_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_nft_uploads ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.season_nft_releases IS
    '정상 종료 시즌의 고정 이미지, 참여자 root와 온체인 발행 준비 상태.';
COMMENT ON COLUMN public.season_nft_releases.preparation_keys IS
    '공개 준비 계정 주소별 지속 저장소 상대 key 파일 식별자. 비밀키 bytes는 저장하지 않는다.';
COMMENT ON COLUMN public.season_nft_releases.version IS
    'stale worker의 상태 덮어쓰기를 막는 repository CAS 버전.';
COMMENT ON TABLE public.season_nft_claims IS
    '고정 참가 지갑에 귀속한 시즌별 단일 NFT 수령 권한과 receipt 복구 상태.';
COMMENT ON COLUMN public.season_nft_claims.receipt_next_check_at IS
    '완료 attempt나 transaction 없이도 RESOLVING receipt를 다시 조회할 시각.';
COMMENT ON TABLE public.season_nft_claim_attempts IS
    '한 claim의 사용자 서명 및 체인 확인 진행 상태. 활성 attempt는 하나만 허용한다.';
COMMENT ON TABLE public.season_nft_transactions IS
    '외부 전송 전에 저장한 setup 및 사용자 거래와 재시작 복구 증거.';
COMMENT ON COLUMN public.season_nft_transactions.serialized_transaction IS
    '재전송과 검증에 쓰는 거래 bytes. 로그나 공개 응답에 포함하지 않는다.';
COMMENT ON COLUMN public.season_nft_transactions.reconciliation_evidence IS
    '정확한 성공 signature 없이 목표 효과가 finalized임을 확인한 계정과 slot 증거.';
COMMENT ON TABLE public.season_nft_uploads IS
    '재시도에서 같은 signed data item을 유지하는 시즌 이미지와 metadata 업로드 상태.';
COMMENT ON COLUMN public.season_nft_uploads.signed_item_path IS
    '지속 저장소 루트 기준 signed item 상대 경로.';

COMMIT;
