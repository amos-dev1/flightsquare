-- ===========================================================================
-- Session user context, and the seventh §2.1 function.
--
-- Runs as app_role. Everything happens inside transactions that roll back, so
-- the suite stays re-runnable.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- A user can read their own row with no tenant context.
--
-- This is the state every session is in between authenticating and picking a
-- tenant, and §3.1 says a user with no memberships at all is valid — so
-- membership cannot be the only route to one's own row.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE ids uuid[];
BEGIN
  IF app.current_user_id() <> '01920000-0000-7000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'app.current_user_id() did not read the session GUC';
  END IF;

  SELECT array_agg(id) INTO ids FROM public.users;
  IF ids IS DISTINCT FROM ARRAY['01920000-0000-7000-8000-0000000000a1']::uuid[] THEN
    RAISE EXCEPTION 'expected alice to see exactly herself, saw %', ids;
  END IF;
  RAISE NOTICE '   ok: user context alone reveals one''s own row and nothing else';
END
$t$;
COMMIT;

-- Carol is in both tenants; inside one of them she sees herself and her
-- co-member there, and still nobody from the other.
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000c1';
DO $t$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(id ORDER BY id) INTO ids FROM public.users;
  IF ids IS DISTINCT FROM ARRAY['01920000-0000-7000-8000-0000000000a1',
                                '01920000-0000-7000-8000-0000000000c1']::uuid[] THEN
    RAISE EXCEPTION 'carol in tenant A saw %, expected alice + herself', ids;
  END IF;
  RAISE NOTICE '   ok: self-visibility does not widen the tenant roster';
END
$t$;
COMMIT;

-- ---------------------------------------------------------------------------
-- Provisioning a new tenant, with no tenant context, as app_role.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
DECLARE
  r record;
  n bigint;
BEGIN
  SELECT * INTO r FROM auth.provision_tenant(
    'delta-flyers', 'Delta Flyers', 'club',
    'new.owner@delta.test', 'argon2id$fixture$delta', NULL);

  IF r.tenant_id IS NULL OR r.user_id IS NULL OR r.membership_id IS NULL THEN
    RAISE EXCEPTION 'provision_tenant returned %, %, %',
      r.tenant_id, r.user_id, r.membership_id;
  END IF;

  -- The write door did not widen reads: still nothing visible without context.
  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 0 THEN
    RAISE EXCEPTION 'provisioning left % tenants readable with no context', n;
  END IF;

  -- And the new tenant is a complete, working tenant under its own context.
  PERFORM set_config('app.tenant_id', r.tenant_id::text, true);
  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 1 THEN RAISE EXCEPTION 'new tenant not visible under its own context'; END IF;

  SELECT count(*) INTO n FROM public.memberships
   WHERE user_id = r.user_id AND status = 'active';
  IF n <> 1 THEN RAISE EXCEPTION 'creator has % active memberships, expected 1', n; END IF;

  PERFORM set_config('app.tenant_id', '', true);

  -- The new user can authenticate: the credential lookup finds them.
  IF (SELECT user_id FROM auth.find_user_by_email('new.owner@delta.test'))
     <> r.user_id THEN
    RAISE EXCEPTION 'provisioned user is not resolvable by email';
  END IF;

  -- And the tenant picker shows them exactly one tenant.
  SELECT count(*) INTO n FROM auth.list_memberships_for_user(r.user_id);
  IF n <> 1 THEN RAISE EXCEPTION 'picker shows % tenants, expected 1', n; END IF;

  RAISE NOTICE '   ok: provision_tenant creates a working tenant, user and membership';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- What it refuses.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
BEGIN
  -- A taken slug and a taken email both surface as the same class of error.
  -- The caller must answer both with one generic message, or signup becomes
  -- an account-existence oracle.
  BEGIN
    PERFORM auth.provision_tenant('alpha', 'Impostor Club', 'club',
                                  'someone@else.test', 'hash', NULL);
    RAISE EXCEPTION 'provision_tenant accepted a slug already in use';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok: duplicate slug rejected';
  END;

  BEGIN
    PERFORM auth.provision_tenant('echo-club', 'Echo Club', 'club',
                                  'alice@alpha.test', 'hash', NULL);
    RAISE EXCEPTION 'provision_tenant accepted an email already registered';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok: duplicate email rejected';
  END;

  -- Neither an authenticated user nor credentials to make one.
  BEGIN
    PERFORM auth.provision_tenant('foxtrot-club', 'Foxtrot Club', 'club',
                                  NULL, NULL, NULL);
    RAISE EXCEPTION 'provision_tenant accepted a call with no subject';
  EXCEPTION WHEN invalid_parameter_value THEN
    RAISE NOTICE '   ok: a call with neither a user nor credentials is rejected';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- The user id it is handed must be the authenticated one.
--
-- Without this, anyone could create a tenant and drop a stranger's account
-- into it as its Admin. The check is in the database, so it holds whether or
-- not the API remembers.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE r record; n bigint;
BEGIN
  BEGIN
    PERFORM auth.provision_tenant('golf-club', 'Golf Club', 'club', NULL, NULL,
                                  '01920000-0000-7000-8000-0000000000b1');
    RAISE EXCEPTION 'provision_tenant attached a user other than the session''s';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cannot enrol another user into a tenant you create';
  END;

  -- The same call for oneself is the §3.1 case: one human, many memberships.
  SELECT * INTO r FROM auth.provision_tenant(
    'hotel-club', 'Hotel Club', 'partnership', NULL, NULL,
    '01920000-0000-7000-8000-0000000000a1');
  IF r.user_id <> '01920000-0000-7000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'expected the existing user to be reused, got %', r.user_id;
  END IF;

  SELECT count(*) INTO n
    FROM auth.list_memberships_for_user('01920000-0000-7000-8000-0000000000a1');
  IF n <> 2 THEN RAISE EXCEPTION 'alice now has % memberships, expected 2', n; END IF;
  RAISE NOTICE '   ok: an authenticated user may create a second tenant for themselves';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- No context at all means no provisioning subject: an anonymous caller can
-- still sign up (that is what signup is), but cannot name a user.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
BEGIN
  BEGIN
    PERFORM auth.provision_tenant('india-club', 'India Club', 'club', NULL, NULL,
                                  '01920000-0000-7000-8000-0000000000a1');
    RAISE EXCEPTION 'provision_tenant named a user with no session to match it';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: naming a user with no user context is rejected';
  END;
END
$t$;
ROLLBACK;
