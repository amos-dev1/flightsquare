-- ===========================================================================
-- §6.1 item 6 — in tenant A's context, attempt to write a row carrying
-- tenant B's id, and assert it fails.
--
-- This is the WITH CHECK half of §1.1. A policy with USING alone passes every
-- test that only reads, and lets a tenant plant rows in someone else's data.
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

-- ---------------------------------------------------------------------------
-- INSERT carrying tenant B's id.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE msg text;
BEGIN
  BEGIN
    INSERT INTO public.memberships (tenant_id, user_id, status)
    VALUES ('01920000-0000-7000-8000-00000000000b',
            '01920000-0000-7000-8000-0000000000a1', 'active');
    RAISE EXCEPTION 'WITH CHECK did not reject an insert into tenant B';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'rejected, but not by RLS: %', msg;
    END IF;
    RAISE NOTICE '   ok: cross-tenant membership insert rejected by policy';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- Same for invites, so the rule is a property of the table class and not of
-- one hand-checked table.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    INSERT INTO public.invites (tenant_id, email, token_hash, expires_at)
    VALUES ('01920000-0000-7000-8000-00000000000b', 'mallory@example.test',
            'sha256:planted', now() + interval '7 days');
    RAISE EXCEPTION 'WITH CHECK did not reject an invite into tenant B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cross-tenant invite insert rejected by policy';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- UPDATE that moves one of our own rows into tenant B. USING lets us see the
-- row; WITH CHECK is what stops the new version of it from leaving.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  BEGIN
    UPDATE public.memberships
       SET tenant_id = '01920000-0000-7000-8000-00000000000b'
     WHERE id = '01920000-0000-7000-8000-0000000000a2';
    RAISE EXCEPTION 'WITH CHECK did not reject moving a row to tenant B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cross-tenant membership UPDATE rejected by policy';
  END;

  -- An UPDATE aimed at tenant B's rows is not an error, it is a no-op: they
  -- are simply not there.
  UPDATE public.memberships SET status = 'suspended'
   WHERE id = '01920000-0000-7000-8000-0000000000b2';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'updated % of tenant B''s rows', n; END IF;
  RAISE NOTICE '   ok: UPDATE targeting tenant B touched 0 rows';

  -- DELETE is not a no-op here, it is not available at all: §6 soft-deletes,
  -- so app_role holds no DELETE grant on any of these tables.
  BEGIN
    DELETE FROM public.memberships
     WHERE id = '01920000-0000-7000-8000-0000000000a2';
    RAISE EXCEPTION 'app_role holds DELETE on memberships';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot hard-DELETE (soft delete only)';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- Positive control. If writes in our own tenant did not work, everything
-- above would pass for the wrong reason.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  INSERT INTO public.memberships (tenant_id, user_id, status)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000b1', 'invited');
  SELECT count(*) INTO n FROM public.memberships;
  IF n <> 3 THEN RAISE EXCEPTION 'own-tenant insert did not land (% rows)', n; END IF;
  RAISE NOTICE '   ok: in-tenant insert succeeds (positive control)';
END
$t$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- deleted_at is not an application verb.
--
-- §6 wants deleted rows hidden by the policy itself. Postgres re-checks the
-- NEW row of an UPDATE against the policies that apply to SELECT, so a row
-- that sets deleted_at stops satisfying the policy that made it visible and
-- the write is refused. Rather than stop hiding deleted rows, app_role simply
-- holds no grant on the column: removal is a domain status (see below), and
-- deleted_at belongs to the control plane. 0001 documents the reasoning.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE n bigint;
BEGIN
  BEGIN
    UPDATE public.memberships SET deleted_at = now()
     WHERE id = '01920000-0000-7000-8000-0000000000a3';
    RAISE EXCEPTION 'app_role wrote deleted_at';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot write deleted_at (control-plane marker)';
  END;

  -- The verb it does have: removal as a domain state, which keeps the row
  -- readable for audit and keeps §5.5's reversibility possible.
  UPDATE public.memberships SET status = 'removed'
   WHERE id = '01920000-0000-7000-8000-0000000000a3';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'could not remove a member'; END IF;

  SELECT count(*) INTO n FROM public.memberships WHERE status = 'removed';
  IF n <> 1 THEN RAISE EXCEPTION 'removed membership is no longer readable'; END IF;
  RAISE NOTICE '   ok: removal is a status change, and stays readable';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- With no context at all, a write has nowhere to go.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
BEGIN
  BEGIN
    INSERT INTO public.memberships (tenant_id, user_id, status)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000a1', 'active');
    RAISE EXCEPTION 'insert succeeded with no tenant context';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: insert with no tenant context rejected';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- A tenant may rename itself. It may not promote itself: plan_code, status
-- and legal_hold are withheld by column-level grant, so §1.4's chain cannot
-- be short-circuited with an UPDATE.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE n bigint;
BEGIN
  UPDATE public.tenants SET name = 'Alpha Flying Club (renamed)'
   WHERE id = '01920000-0000-7000-8000-00000000000a';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant could not rename itself'; END IF;

  BEGIN
    UPDATE public.tenants SET plan_code = 'enterprise'
     WHERE id = '01920000-0000-7000-8000-00000000000a';
    RAISE EXCEPTION 'app_role self-upgraded its own plan_code';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot write plan_code';
  END;

  BEGIN
    UPDATE public.tenants SET legal_hold = false
     WHERE id = '01920000-0000-7000-8000-00000000000a';
    RAISE EXCEPTION 'app_role cleared its own legal_hold';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: app_role cannot write legal_hold';
  END;
END
$t$;
ROLLBACK;
