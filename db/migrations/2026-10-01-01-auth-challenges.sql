-- 챌린지 발급에 필요한 현행 스키마다. 기존 테이블과 데이터는 유지한다.
BEGIN;

CREATE TABLE IF NOT EXISTS public.auth_challenges (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_method varchar(30) NOT NULL,
    nonce text COLLATE "C" NOT NULL UNIQUE,
    verification_payload jsonb NOT NULL,
    browser_binding_hash text COLLATE "C" NOT NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP + interval '5 minutes',
    consumed_at timestamptz,
    CONSTRAINT auth_challenges_method_check CHECK (auth_method ~ '^[a-z0-9][a-z0-9_-]{0,29}$'),
    CONSTRAINT auth_challenges_nonce_check CHECK (nonce ~ '^[A-Za-z0-9]{32,128}$'),
    CONSTRAINT auth_challenges_payload_check CHECK (jsonb_typeof(verification_payload) = 'object'),
    CONSTRAINT auth_challenges_binding_hash_check CHECK (browser_binding_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT auth_challenges_expiration_check CHECK (expires_at > created_at),
    CONSTRAINT auth_challenges_consumed_check CHECK (
        consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)
    )
);

CREATE INDEX IF NOT EXISTS auth_challenges_expires_at_idx
    ON public.auth_challenges (expires_at);

ALTER TABLE public.auth_challenges ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.auth_challenges.verification_payload IS
    'Exact server-issued sign-in input. Its nonce and expiration must agree with the corresponding columns.';
COMMENT ON COLUMN public.auth_challenges.browser_binding_hash IS
    'Lowercase hex SHA-256 digest of a random temporary browser cookie.';

COMMIT;
