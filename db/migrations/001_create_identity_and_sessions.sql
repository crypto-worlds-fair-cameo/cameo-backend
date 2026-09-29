-- PostgreSQL 16+. Apply once through a privileged migration connection.
-- Scope: service users, wallet identities, one-time login challenges, sessions.
-- Authentication and session renewal are implemented by NestJS, not this DDL.
BEGIN;

CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name varchar(50),
  avatar_url text,
  status varchar(20) NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at timestamptz,
  withdrawn_at timestamptz,
  CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'withdrawn')),
  CONSTRAINT users_withdrawal_check CHECK (
    (status = 'withdrawn') = (withdrawn_at IS NOT NULL)
  ),
  CONSTRAINT users_display_name_check CHECK (
    display_name IS NULL OR length(btrim(display_name)) > 0
  )
);

CREATE TABLE public.user_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  chain_namespace varchar(20) NOT NULL,
  address text COLLATE "C" NOT NULL,
  address_key text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at timestamptz,
  CONSTRAINT user_wallets_identity_unique UNIQUE (chain_namespace, address_key),
  CONSTRAINT user_wallets_namespace_check CHECK (
    chain_namespace ~ '^[a-z0-9][a-z0-9_-]{0,19}$'
  ),
  CONSTRAINT user_wallets_address_check CHECK (
    length(address) BETWEEN 1 AND 256 AND address = btrim(address)
    AND length(address_key) BETWEEN 1 AND 256 AND address_key = btrim(address_key)
  ),
  -- Base58 shape only. NestJS must decode and validate a 32-byte Solana public key.
  CONSTRAINT user_wallets_solana_address_check CHECK (
    chain_namespace <> 'solana' OR (
      address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND address_key = address
    )
  )
);

CREATE INDEX user_wallets_user_id_idx ON public.user_wallets (user_id);

CREATE TABLE public.auth_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_method varchar(30) NOT NULL,
  nonce text COLLATE "C" NOT NULL UNIQUE,
  verification_payload jsonb NOT NULL,
  browser_binding_hash text COLLATE "C" NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '5 minutes'),
  consumed_at timestamptz,
  CONSTRAINT auth_challenges_method_check CHECK (
    auth_method ~ '^[a-z0-9][a-z0-9_-]{0,29}$'
  ),
  -- Generate at least 128 random bits server-side; length alone is not entropy.
  CONSTRAINT auth_challenges_nonce_check CHECK (nonce ~ '^[A-Za-z0-9]{32,128}$'),
  CONSTRAINT auth_challenges_payload_check CHECK (
    jsonb_typeof(verification_payload) = 'object'
  ),
  CONSTRAINT auth_challenges_binding_hash_check CHECK (
    browser_binding_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT auth_challenges_expiration_check CHECK (expires_at > created_at),
  CONSTRAINT auth_challenges_consumed_check CHECK (
    consumed_at IS NULL OR (consumed_at >= created_at AND consumed_at < expires_at)
  )
);

CREATE INDEX auth_challenges_expires_at_idx ON public.auth_challenges (expires_at);

CREATE TABLE public.auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  token_hash text COLLATE "C" NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '7 days'),
  absolute_expires_at timestamptz NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_sessions_expiration_check CHECK (
    expires_at > created_at AND expires_at <= absolute_expires_at
  ),
  CONSTRAINT auth_sessions_last_seen_check CHECK (
    last_seen_at >= created_at AND last_seen_at < expires_at
  ),
  CONSTRAINT auth_sessions_revoked_check CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

CREATE INDEX auth_sessions_user_id_idx ON public.auth_sessions (user_id);
CREATE INDEX auth_sessions_expires_at_idx ON public.auth_sessions (expires_at);

-- Supabase Data API clients must not read or mutate these authentication tables.
-- No browser policies are granted. NestJS uses a trusted server-side DB role.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.users IS 'Service accounts independent of login provider or wallet application.';
COMMENT ON TABLE public.user_wallets IS 'Verified wallet identities; multiple wallets may belong to one service account.';
COMMENT ON COLUMN public.user_wallets.address_key IS 'Chain-specific canonical address. Solana preserves case. Network-specific smart accounts require a future identity-scope migration.';
COMMENT ON COLUMN public.users.updated_at IS 'Updated explicitly by the application whenever member data changes.';
COMMENT ON TABLE public.auth_challenges IS 'Single-use login challenges. Only server-issued inputs are trusted; no private keys are stored.';
COMMENT ON COLUMN public.auth_challenges.verification_payload IS 'Exact server-issued sign-in input. Its nonce and expiration must agree with the corresponding columns.';
COMMENT ON COLUMN public.auth_challenges.browser_binding_hash IS 'Lowercase hex SHA-256 digest of a random temporary browser cookie.';
COMMENT ON TABLE public.auth_sessions IS 'Opaque server-side sessions with rolling idle expiration and a fixed absolute expiration.';
COMMENT ON COLUMN public.auth_sessions.token_hash IS 'Lowercase hex SHA-256 digest of a cryptographically random session token; never store the raw token.';
COMMENT ON COLUMN public.auth_sessions.absolute_expires_at IS 'Fixed at session creation. Renewal must never extend this timestamp.';

COMMIT;
