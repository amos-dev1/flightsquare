-- ===========================================================================
-- §4.4's third dimension, and CLAUDE.md §10 decision 3.
--
-- Nothing is row-scoped yet: the ledger arrives with M6. What is proved here
-- is that the question a scoped policy will ask already answers correctly,
-- which is the whole point of settling this before the table exists.
--
-- Runs as app_role.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice, Admin

DO $t$
BEGIN
  IF app.current_membership_id() <> '01920000-0000-7000-8000-0000000000a2' THEN
    RAISE EXCEPTION 'the admin''s own membership did not resolve: %',
      app.current_membership_id();
  END IF;

  -- An Admin reads the whole ledger, which is what a treasurer is for.
  IF app.permission_scope('charges') <> 'all' THEN
    RAISE EXCEPTION 'an admin is scoped to % on charges', app.permission_scope('charges');
  END IF;

  -- ... including rows belonging to somebody else.
  IF NOT app.owns_row('charges', '01920000-0000-7000-8000-0000000000a3') THEN
    RAISE EXCEPTION 'an admin cannot see another member''s charges';
  END IF;
  RAISE NOTICE '   ok: an admin reads the whole ledger';
END
$t$;

-- Carol is a Pilot in the same tenant.
SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';
DO $t$
BEGIN
  IF app.current_membership_id() <> '01920000-0000-7000-8000-0000000000a3' THEN
    RAISE EXCEPTION 'the pilot''s own membership did not resolve';
  END IF;

  IF app.permission_scope('charges') <> 'own' THEN
    RAISE EXCEPTION 'a pilot is scoped to % on charges', app.permission_scope('charges');
  END IF;

  -- Their own row: yes.
  IF NOT app.owns_row('charges', '01920000-0000-7000-8000-0000000000a3') THEN
    RAISE EXCEPTION 'a pilot cannot see their own charges';
  END IF;

  -- The admin's: no. This is the sentence the model could not say before.
  IF app.owns_row('charges', '01920000-0000-7000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'a pilot can see another member''s charges';
  END IF;

  -- A row belonging to nobody is nobody's to read either.
  IF app.owns_row('charges', NULL) THEN
    RAISE EXCEPTION 'an unowned row was readable by a scoped member';
  END IF;
  RAISE NOTICE '   ok: a pilot reads their own ledger and no further';

  -- The rest of the club is shared on purpose: the next pilot needs to know
  -- what the last one found.
  IF app.permission_scope('squawks') <> 'all'
     OR app.permission_scope('flights') <> 'all'
     OR app.permission_scope('maintenance') <> 'all' THEN
    RAISE EXCEPTION 'something other than charges was narrowed';
  END IF;
  RAISE NOTICE '   ok: flights, squawks and maintenance stay shared';

  -- A resource they hold nothing on is 'none', which a policy can tell apart
  -- from 'own' without a second lookup.
  IF app.permission_scope('members') <> 'none' THEN
    RAISE EXCEPTION 'a pilot reports % on members', app.permission_scope('members');
  END IF;
  IF app.owns_row('members', '01920000-0000-7000-8000-0000000000a3') THEN
    RAISE EXCEPTION 'holding nothing still matched a row';
  END IF;
  RAISE NOTICE '   ok: holding nothing matches nothing, even your own';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §1.1's failure mode, which a scoped policy must inherit rather than undo.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
BEGIN
  IF app.current_membership_id() IS NOT NULL THEN
    RAISE EXCEPTION 'a membership resolved with no context at all';
  END IF;
  IF app.permission_scope('charges') <> 'none' THEN
    RAISE EXCEPTION 'an unscoped session holds % on charges',
      app.permission_scope('charges');
  END IF;
  IF app.owns_row('charges', '01920000-0000-7000-8000-0000000000a3') THEN
    RAISE EXCEPTION 'no context still matched a row — unset must mean zero rows';
  END IF;
  RAISE NOTICE '   ok: no context is no rows, scoping included';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- A membership in the wrong tenant is not a membership here.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';   -- bravo
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice, of alpha
DO $t$
BEGIN
  -- §3.1: one human, many memberships, and the answer depends on which
  -- tenant the session is in. Alice belongs to alpha, not bravo.
  IF app.current_membership_id() IS NOT NULL THEN
    RAISE EXCEPTION 'a membership resolved in a tenant the user never joined';
  END IF;
  IF app.owns_row('charges', '01920000-0000-7000-8000-0000000000a2') THEN
    RAISE EXCEPTION 'a row matched across a tenant boundary';
  END IF;
  RAISE NOTICE '   ok: scoping is per membership, so it stops at the tenant';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- The shape of the column itself.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  -- Defaulting to 'all' is what keeps this migration from silently narrowing
  -- a grant somebody already had.
  IF EXISTS (SELECT 1 FROM public.role_bundle_permissions WHERE scope IS NULL) THEN
    RAISE EXCEPTION 'a permission carries no scope';
  END IF;

  BEGIN
    INSERT INTO public.role_bundle_permissions
      (tenant_id, role_bundle_id, resource, level, scope)
    VALUES ('01920000-0000-7000-8000-00000000000a', gen_random_uuid(),
            'charges', 'read', 'some');
    RAISE EXCEPTION 'an invented scope was accepted';
  EXCEPTION WHEN check_violation OR insufficient_privilege OR foreign_key_violation THEN
    RAISE NOTICE '   ok: scope is own or all, and nothing else';
  END;
END
$t$;
