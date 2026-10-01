-- 지갑 로그인에 필요한 현행 계정·지갑·세션 스키마다. 기존 테이블과 데이터는 유지한다.
BEGIN;

CREATE TABLE IF NOT EXISTS public.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name varchar(50),
    avatar_url text,
    status varchar(20) NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at timestamptz,
    withdrawn_at timestamptz,
    CONSTRAINT users_display_name_check CHECK (
        display_name IS NULL OR length(btrim(display_name)) > 0
    ),
    CONSTRAINT users_status_check CHECK (
        status IN ('active', 'suspended', 'withdrawn')
    ),
    CONSTRAINT users_withdrawal_check CHECK (
        (status = 'withdrawn') = (withdrawn_at IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.user_wallets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    chain_namespace varchar(20) NOT NULL,
    address text COLLATE "C" NOT NULL,
    address_key text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at timestamptz,
    CONSTRAINT user_wallets_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE RESTRICT,
    CONSTRAINT user_wallets_identity_unique UNIQUE (chain_namespace, address_key),
    CONSTRAINT user_wallets_namespace_check CHECK (
        chain_namespace ~ '^[a-z0-9][a-z0-9_-]{0,19}$'
    ),
    CONSTRAINT user_wallets_address_check CHECK (
        length(address) BETWEEN 1 AND 256
        AND address = btrim(address)
        AND length(address_key) BETWEEN 1 AND 256
        AND address_key = btrim(address_key)
    ),
    -- Solana의 Base58 공개키는 대소문자를 구분하며 별도 정규화 없이 식별 키로 쓴다.
    CONSTRAINT user_wallets_solana_address_check CHECK (
        chain_namespace <> 'solana'
        OR (
            address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
            AND address_key = address
        )
    )
);

CREATE INDEX IF NOT EXISTS user_wallets_user_id_idx
    ON public.user_wallets (user_id);

CREATE TABLE IF NOT EXISTS public.auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    token_hash text COLLATE "C" NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '7 days',
    absolute_expires_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '30 days',
    revoked_at timestamptz,
    CONSTRAINT auth_sessions_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public.users (id) ON DELETE RESTRICT,
    CONSTRAINT auth_sessions_token_hash_check CHECK (
        token_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT auth_sessions_expiration_check CHECK (
        expires_at > created_at
        AND expires_at <= absolute_expires_at
    ),
    CONSTRAINT auth_sessions_last_seen_check CHECK (
        last_seen_at >= created_at
        AND last_seen_at < expires_at
    ),
    CONSTRAINT auth_sessions_revoked_check CHECK (
        revoked_at IS NULL OR revoked_at >= created_at
    )
);

CREATE INDEX IF NOT EXISTS auth_sessions_user_id_idx
    ON public.auth_sessions (user_id);

CREATE INDEX IF NOT EXISTS auth_sessions_expires_at_idx
    ON public.auth_sessions (expires_at);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.users IS
    '로그인 제공자나 지갑 앱과 독립적인 서비스 계정.';
COMMENT ON COLUMN public.users.updated_at IS
    '회원 데이터 변경 시 애플리케이션이 명시적으로 갱신하는 시각.';
COMMENT ON TABLE public.user_wallets IS
    '증명을 검증한 지갑 식별자. 한 계정에 여러 지갑이 연결될 수 있다.';
COMMENT ON COLUMN public.user_wallets.address_key IS
    '체인별 계정 식별 주소. Solana는 대소문자를 유지한다. 네트워크별 스마트 계정은 식별 범위를 확장하는 별도 변경이 필요하다.';
COMMENT ON TABLE public.auth_sessions IS
    '활동 만료와 고정된 절대 만료를 가진 서버 세션.';
COMMENT ON COLUMN public.auth_sessions.token_hash IS
    '암호학적 난수 세션 토큰의 SHA-256 소문자 16진수 해시. 원문 토큰은 저장하지 않는다.';
COMMENT ON COLUMN public.auth_sessions.absolute_expires_at IS
    '세션 생성 시 고정한다. 세션 갱신으로 이 시각을 연장하지 않는다.';

COMMIT;
