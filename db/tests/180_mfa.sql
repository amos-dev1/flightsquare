-- ===========================================================================
-- MFA: the second factor, and the three things it must not become.
--
-- A login code is an email token of a new kind, which means most of what
-- protects it is already proved in `110_identity` — single use, one kind cannot
-- be spent as another, expired is refused, and `app_role` cannot touch
-- `auth_tokens` at all. This file covers what is new: that mandatory means
-- mandatory, that a trusted device is a credential and behaves like one, and
-- that `find_user_by_email` answers the device question without becoming a
-- writer.
--
-- Runs as app_role, in transactions that roll back.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Mandatory is the default plus the absence of a door.
--
-- Not an `if` in a route: there is no grant that could set this false, which is
-- the only version of "mandatory" that cannot be undone by a code change
-- somebody makes in a hurry.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
         AND column_name = 'mfa_enabled') NOT LIKE '%true%' THEN
    RAISE EXCEPTION 'a new user would be created without a second factor';
  END IF;
  RAISE NOTICE '   ok: a new account has MFA on before anybody chooses';

  IF has_column_privilege('app_role', 'public.users', 'mfa_enabled', 'UPDATE') THEN
    RAISE EXCEPTION 'app_role can switch off a second factor';
  END IF;
  RAISE NOTICE '   ok: and no grant exists that could switch it off';

  -- The backfill is part of the policy: rows written before the decision are
  -- rows the decision has to reach.
  SELECT count(*) INTO n FROM public.users WHERE NOT mfa_enabled;
  IF n <> 0 THEN
    RAISE EXCEPTION '% existing users still have no second factor', n;
  END IF;
  RAISE NOTICE '   ok: and everybody who already existed was brought along';
END
$t$;

-- ---------------------------------------------------------------------------
-- A login code is a kind of email token, and the kinds stay closed.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'auth_tokens_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%mfa_code%') THEN
    RAISE EXCEPTION 'auth_tokens will not hold a login code';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbox_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%mfa_code%') THEN
    RAISE EXCEPTION 'the outbox will not carry a login code';
  END IF;
  RAISE NOTICE '   ok: a login code is a kind of email token and of message';

  -- Still unreachable. The doors are the only way in, which is what makes a
  -- code a code rather than a row the application can read.
  IF has_table_privilege('app_role', 'public.auth_tokens', 'SELECT') THEN
    RAISE EXCEPTION 'app_role can read the codes it is meant to be checking';
  END IF;
  RAISE NOTICE '   ok: and app_role still cannot read one';
END
$t$;

-- ---------------------------------------------------------------------------
-- A trusted device belongs to one user, and the lookup says so.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.trusted_devices (user_id, token_hash, client, expires_at)
VALUES ('01920000-0000-7000-8000-0000000000a1',
        'sha256:device-a', 'ios', now() + interval '30 days');

DO $t$
DECLARE r record;
BEGIN
  -- The owner's own device: trusted.
  SELECT * INTO r FROM auth.find_user_by_email(
    (SELECT email FROM public.users WHERE id = '01920000-0000-7000-8000-0000000000a1'),
    'sha256:device-a');
  IF NOT r.device_trusted THEN
    RAISE EXCEPTION 'a live device of this user was not recognised';
  END IF;
  IF NOT r.mfa_enabled THEN
    RAISE EXCEPTION 'the credential check no longer reports the second factor';
  END IF;
  RAISE NOTICE '   ok: a live device of the right user skips the code';

  -- The same token against somebody else: not trusted. This is the one that
  -- matters — a token lifted from one account must be worth nothing against
  -- another, and the join is on the user as well as the hash.
  SELECT * INTO r FROM auth.find_user_by_email(
    (SELECT email FROM public.users WHERE id = '01920000-0000-7000-8000-0000000000b1'),
    'sha256:device-a');
  IF r.device_trusted THEN
    RAISE EXCEPTION 'one user''s device vouched for another user';
  END IF;
  RAISE NOTICE '   ok: and vouches for nobody else';

  -- No token at all, which is every first sign-in.
  SELECT * INTO r FROM auth.find_user_by_email(
    (SELECT email FROM public.users WHERE id = '01920000-0000-7000-8000-0000000000a1'));
  IF r.device_trusted THEN
    RAISE EXCEPTION 'a caller with no device token was treated as trusted';
  END IF;
  RAISE NOTICE '   ok: and no device means no shortcut';
END
$t$;

-- -------------------------------------------------------------------------
-- Expired and revoked are both refused, and neither can be undone in place.
-- -------------------------------------------------------------------------
DO $t$
DECLARE r record;
BEGIN
  UPDATE public.trusted_devices SET revoked_at = now()
   WHERE token_hash = 'sha256:device-a';

  SELECT * INTO r FROM auth.find_user_by_email(
    (SELECT email FROM public.users WHERE id = '01920000-0000-7000-8000-0000000000a1'),
    'sha256:device-a');
  IF r.device_trusted THEN
    RAISE EXCEPTION 'a revoked device still skips the code';
  END IF;
  RAISE NOTICE '   ok: a revoked device is refused';

  -- Thirty days is a limit, not a suggestion: a trust that could be extended
  -- in place would never actually end.
  BEGIN
    UPDATE public.trusted_devices SET expires_at = now() + interval '10 years'
     WHERE token_hash = 'sha256:device-a';
    RAISE EXCEPTION 'app_role extended a device trust';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: and its expiry cannot be pushed out';
  END;

  BEGIN
    UPDATE public.trusted_devices SET token_hash = 'sha256:device-b'
     WHERE token_hash = 'sha256:device-a';
    RAISE EXCEPTION 'app_role repointed a device trust at another token';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: nor its token replaced';
  END;

  BEGIN
    DELETE FROM public.trusted_devices WHERE token_hash = 'sha256:device-a';
    RAISE EXCEPTION 'app_role deleted a device trust';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: and a revoked device stays a row';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §6.1 item 5 and 6, in their user-scoped form: one person's devices are
-- their own, and none can be written for anybody else.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';

INSERT INTO public.trusted_devices (user_id, token_hash, client, expires_at)
VALUES ('01920000-0000-7000-8000-0000000000a1',
        'sha256:mine', 'web', now() + interval '30 days');

SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000b1';

DO $t$
DECLARE msg text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.trusted_devices) THEN
    RAISE EXCEPTION 'another user''s devices are visible';
  END IF;
  RAISE NOTICE '   ok: a person sees only their own devices';

  BEGIN
    INSERT INTO public.trusted_devices (user_id, token_hash, client, expires_at)
    VALUES ('01920000-0000-7000-8000-0000000000a1',
            'sha256:planted', 'web', now() + interval '30 days');
    RAISE EXCEPTION 'a device was trusted on somebody else''s behalf';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'rejected, but not by RLS: %', msg;
    END IF;
    RAISE NOTICE '   ok: and cannot trust a device for anybody else';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- The lookup reads a second table and is still not a writer.
--
-- Stamping `last_used_at` inside it would have been the obvious convenience and
-- would have moved it onto `030`'s list of auth functions that write. The stamp
-- happens afterwards, under the user context the session already has.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  IF (SELECT provolatile FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'auth' AND p.proname = 'find_user_by_email') <> 's' THEN
    RAISE EXCEPTION 'the credential check has learned to write';
  END IF;
  RAISE NOTICE '   ok: the credential check reads two tables and writes none';
END
$t$;
