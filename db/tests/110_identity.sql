-- ===========================================================================
-- Identity: the doors email opens, and the one member a tenant cannot lose.
--
-- Runs as app_role. The two new §2.1 functions are exercised through their
-- grants rather than as the owner, because the point of a door is what it
-- does for the role that is allowed to knock.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- The tables behind the doors are not reachable any other way.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  IF has_table_privilege('app_role', 'public.auth_tokens', 'SELECT')
     OR has_table_privilege('app_role', 'public.auth_tokens', 'INSERT')
     OR has_table_privilege('app_role', 'public.auth_tokens', 'UPDATE') THEN
    RAISE EXCEPTION 'app_role can reach auth_tokens without going through auth.*';
  END IF;

  -- The bodies carry live links. An application that could read this table
  -- could read every reset link in flight.
  IF has_table_privilege('app_role', 'public.outbox', 'SELECT') THEN
    RAISE EXCEPTION 'app_role can read the outbox';
  END IF;
  IF NOT has_table_privilege('app_role', 'public.outbox', 'INSERT') THEN
    RAISE EXCEPTION 'app_role cannot enqueue mail';
  END IF;
  IF has_table_privilege('app_role', 'public.outbox', 'UPDATE')
     OR has_table_privilege('app_role', 'public.outbox', 'DELETE') THEN
    RAISE EXCEPTION 'the outbox is not append-only';
  END IF;
  RAISE NOTICE '   ok: tokens and mail are reachable only through the auth doors';
END
$t$;

-- ---------------------------------------------------------------------------
-- An unknown address is indistinguishable from a known one.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
DECLARE n bigint;
BEGIN
  -- Known address: a token and a message exist afterwards.
  PERFORM auth.request_email_token(
    'alice@alpha.test', 'password_reset', 'sha256:reset-alice',
    now() + interval '1 hour', 'Reset your password', 'https://example.test/r/tok');

  -- Unknown address: the call succeeds and writes nothing. The caller gets
  -- void back either way, which is what stops the endpoint answering "is
  -- this address registered?".
  PERFORM auth.request_email_token(
    'nobody@nowhere.test', 'password_reset', 'sha256:reset-ghost',
    now() + interval '1 hour', 'Reset your password', 'https://example.test/r/ghost');
  RAISE NOTICE '   ok: a reset for an unknown address is silently nothing';

  -- Spending it returns the user; spending it twice does not.
  IF auth.consume_auth_token('password_reset', 'sha256:reset-alice')
     IS DISTINCT FROM '01920000-0000-7000-8000-0000000000a1'::uuid THEN
    RAISE EXCEPTION 'a live reset token did not resolve to its user';
  END IF;
  IF auth.consume_auth_token('password_reset', 'sha256:reset-alice') IS NOT NULL THEN
    RAISE EXCEPTION 'a reset token was spent twice';
  END IF;
  RAISE NOTICE '   ok: a token resolves once and is then spent';

  -- The ghost token never existed, so it cannot be spent either.
  IF auth.consume_auth_token('password_reset', 'sha256:reset-ghost') IS NOT NULL THEN
    RAISE EXCEPTION 'a token was issued for an address with no account';
  END IF;

  -- Kind is part of the match: a verification link is not a password reset.
  PERFORM auth.request_email_token(
    'alice@alpha.test', 'email_verification', 'sha256:verify-alice',
    now() + interval '1 hour', 'Confirm your email', 'https://example.test/v/tok');
  IF auth.consume_auth_token('password_reset', 'sha256:verify-alice') IS NOT NULL THEN
    RAISE EXCEPTION 'a verification token was accepted as a password reset';
  END IF;
  RAISE NOTICE '   ok: one kind of token cannot be spent as another';

  -- And an expired one is not a token.
  PERFORM auth.request_email_token(
    'alice@alpha.test', 'password_reset', 'sha256:reset-stale',
    now() - interval '1 second', 'Reset your password', 'https://example.test/r/stale');
  IF auth.consume_auth_token('password_reset', 'sha256:reset-stale') IS NOT NULL THEN
    RAISE EXCEPTION 'an expired token was accepted';
  END IF;
  RAISE NOTICE '   ok: an expired token is refused';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §3.1: you can see the people you fly with. You can only write yourself.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice
DO $t$
DECLARE n bigint;
BEGIN
  -- Alice and Carol share tenant A, so Alice can read Carol.
  SELECT count(*) INTO n FROM public.users
   WHERE id = '01920000-0000-7000-8000-0000000000c1';
  IF n <> 1 THEN RAISE EXCEPTION 'a member cannot see a fellow member'; END IF;

  UPDATE public.users SET name = 'Alice Alpha', phone = '+1 650 555 0100'
   WHERE id = '01920000-0000-7000-8000-0000000000a1';
  IF (SELECT name FROM public.users WHERE id = '01920000-0000-7000-8000-0000000000a1')
     <> 'Alice Alpha' THEN
    RAISE EXCEPTION 'a user cannot write their own profile';
  END IF;
  RAISE NOTICE '   ok: a member reads the club and writes only themselves';

  -- The same human is an Admin here and a Pilot at the field next door, so a
  -- club admin editing their global profile would reach across tenants.
  UPDATE public.users SET name = 'Not Carol'
   WHERE id = '01920000-0000-7000-8000-0000000000c1';
  IF FOUND THEN
    RAISE EXCEPTION 'an admin rewrote a fellow member''s global profile';
  END IF;
  RAISE NOTICE '   ok: an admin cannot edit another member''s profile';

  -- Nor the address they sign in with, which would be an account takeover
  -- with no re-verification anywhere in sight.
  BEGIN
    UPDATE public.users SET email = 'attacker@example.test'
     WHERE id = '01920000-0000-7000-8000-0000000000a1';
    RAISE EXCEPTION 'a user changed the address they sign in with';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: the sign-in address is not editable in v1';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §4.4: "A tenant must always have at least one member holding
-- `members: write`" — on role change and on removal alike.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE
  v_pilot uuid;
  v_admin uuid;
BEGIN
  SELECT id INTO v_pilot FROM public.role_bundles WHERE code = 'pilot';
  SELECT id INTO v_admin FROM public.role_bundles WHERE code = 'admin';

  -- Alice is the only Admin; Carol is a Pilot. Demoting Alice would leave
  -- the club with two people and nobody able to add a third.
  BEGIN
    UPDATE public.memberships SET role_bundle_id = v_pilot
     WHERE id = '01920000-0000-7000-8000-0000000000a2';
    RAISE EXCEPTION 'the last admin was demoted';
  EXCEPTION WHEN SQLSTATE 'FS409' THEN
    RAISE NOTICE '   ok: the last admin cannot be demoted';
  END;

  BEGIN
    UPDATE public.memberships SET status = 'removed'
     WHERE id = '01920000-0000-7000-8000-0000000000a2';
    RAISE EXCEPTION 'the last admin was removed';
  EXCEPTION WHEN SQLSTATE 'FS409' THEN
    RAISE NOTICE '   ok: the last admin cannot be deactivated';
  END;

  -- Promote Carol first, and the rule stops applying to Alice.
  UPDATE public.memberships SET role_bundle_id = v_admin
   WHERE id = '01920000-0000-7000-8000-0000000000a3';
  UPDATE public.memberships SET status = 'removed'
   WHERE id = '01920000-0000-7000-8000-0000000000a2';
  RAISE NOTICE '   ok: with a second admin, the first may step down';

  -- §3.1 and M1: removal is a status, so the flights they flew stay theirs.
  IF NOT EXISTS (SELECT 1 FROM public.memberships
                  WHERE id = '01920000-0000-7000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'removing a member deleted the membership row';
  END IF;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- An invitation carries the role it is an invitation to.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE v_pilot uuid;
BEGIN
  SELECT id INTO v_pilot FROM public.role_bundles WHERE code = 'pilot';

  INSERT INTO public.invites
    (tenant_id, email, name, token_hash, invited_by, expires_at, role_bundle_id)
  VALUES ('01920000-0000-7000-8000-00000000000a', 'frank@example.test', 'Frank',
          'sha256:alpha-frank', '01920000-0000-7000-8000-0000000000a1',
          now() + interval '7 days', v_pilot);

  -- The invite resolves before there is any membership to scope by — that is
  -- what the §2.1 door is for — and the bundle travels with it.
  IF NOT EXISTS (SELECT 1 FROM auth.resolve_invite_token('sha256:alpha-frank')) THEN
    RAISE EXCEPTION 'a live invite did not resolve';
  END IF;
  RAISE NOTICE '   ok: an invite carries its role and resolves before membership';

  -- A bundle this tenant does not own is unrepresentable, which is what the
  -- composite (tenant_id, role_bundle_id) key is for: the pair has to exist
  -- together, so another tenant's bundle cannot be borrowed even if its id
  -- were known.
  BEGIN
    INSERT INTO public.invites
      (tenant_id, email, token_hash, invited_by, expires_at, role_bundle_id)
    VALUES ('01920000-0000-7000-8000-00000000000a', 'gina@example.test',
            'sha256:alpha-gina', '01920000-0000-7000-8000-0000000000a1',
            now() + interval '7 days', gen_random_uuid());
    RAISE EXCEPTION 'an invite took a role bundle that does not exist here';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE '   ok: an invite cannot carry a role this tenant does not own';
  END;
END
$t$;
ROLLBACK;
