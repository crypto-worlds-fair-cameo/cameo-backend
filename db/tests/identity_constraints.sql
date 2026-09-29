-- Run only against a dedicated test database after applying migration 001.
-- All test data and the temporary test role are rolled back.
BEGIN;

DO $$
DECLARE
  first_user uuid;
  second_user uuid;
  session_id uuid;
  challenge_id uuid;
  affected integer;
BEGIN
  INSERT INTO public.users DEFAULT VALUES RETURNING id INTO first_user;
  INSERT INTO public.users DEFAULT VALUES RETURNING id INTO second_user;

  INSERT INTO public.user_wallets (user_id, chain_namespace, address, address_key)
  VALUES
    (first_user, 'solana', repeat('1', 32), repeat('1', 32)),
    (first_user, 'solana', repeat('2', 32), repeat('2', 32));

  BEGIN
    INSERT INTO public.user_wallets (user_id, chain_namespace, address, address_key)
    VALUES (second_user, 'solana', repeat('1', 32), repeat('1', 32));
    RAISE EXCEPTION 'Duplicate wallet was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.user_wallets (user_id, chain_namespace, address, address_key)
    VALUES (first_user, 'solana', repeat('A', 32), repeat('a', 32));
    RAISE EXCEPTION 'Incorrect Solana normalization was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.users SET status = 'withdrawn' WHERE id = first_user;
    RAISE EXCEPTION 'Withdrawal without timestamp was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  INSERT INTO public.auth_sessions (user_id, token_hash)
  VALUES (first_user, repeat('a', 64)) RETURNING id INTO session_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.auth_sessions WHERE id = session_id
    AND expires_at = created_at + interval '7 days'
    AND absolute_expires_at = created_at + interval '30 days'
  ) THEN RAISE EXCEPTION 'Session expiration defaults do not match policy'; END IF;

  BEGIN
    UPDATE public.auth_sessions SET expires_at = absolute_expires_at + interval '1 second'
    WHERE id = session_id;
    RAISE EXCEPTION 'Expiration beyond absolute limit was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  UPDATE public.auth_sessions
  SET expires_at = LEAST(CURRENT_TIMESTAMP + interval '7 days', absolute_expires_at),
      last_seen_at = CURRENT_TIMESTAMP
  WHERE id = session_id AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
    AND absolute_expires_at > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Valid session did not renew'; END IF;

  UPDATE public.auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = session_id;
  UPDATE public.auth_sessions SET expires_at = absolute_expires_at
  WHERE id = session_id AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Revoked session was renewed'; END IF;

  INSERT INTO public.auth_challenges
    (auth_method, nonce, verification_payload, browser_binding_hash)
  VALUES ('solana_siws', repeat('b', 32), jsonb_build_object('nonce', repeat('b', 32)), repeat('c', 64))
  RETURNING id INTO challenge_id;

  UPDATE public.auth_challenges SET consumed_at = CURRENT_TIMESTAMP
  WHERE id = challenge_id AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'Fresh challenge was not consumed'; END IF;

  UPDATE public.auth_challenges SET consumed_at = CURRENT_TIMESTAMP
  WHERE id = challenge_id AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 0 THEN RAISE EXCEPTION 'Challenge replay was accepted'; END IF;

  BEGIN
    DELETE FROM public.users WHERE id = first_user;
    RAISE EXCEPTION 'Referenced user deletion was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;

CREATE ROLE cameo_schema_test_browser NOLOGIN;
GRANT USAGE ON SCHEMA public TO cameo_schema_test_browser;
GRANT SELECT ON public.users, public.user_wallets, public.auth_challenges, public.auth_sessions
  TO cameo_schema_test_browser;
SET LOCAL ROLE cameo_schema_test_browser;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.users)
    OR EXISTS (SELECT 1 FROM public.user_wallets)
    OR EXISTS (SELECT 1 FROM public.auth_challenges)
    OR EXISTS (SELECT 1 FROM public.auth_sessions)
  THEN RAISE EXCEPTION 'RLS exposed authentication data to an untrusted role'; END IF;
END $$;
RESET ROLE;

ROLLBACK;
SELECT 'Identity constraints and RLS checks passed' AS result;
