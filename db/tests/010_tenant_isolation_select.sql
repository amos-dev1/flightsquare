-- ===========================================================================
-- §6.1 item 5 — set context to tenant A, query, assert zero rows from
-- tenant B's fixtures.
--
-- Runs on a connection opened as app_role. Nothing here uses SET ROLE: the
-- point is to exercise the same principal the API connects as.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
  IF (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'app_role can bypass RLS — the rest of this suite proves nothing';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Unset context means zero rows, never all rows.
-- ---------------------------------------------------------------------------
BEGIN;
DO $t$
DECLARE n bigint;
BEGIN
  IF current_setting('app.tenant_id', true) IS NOT NULL THEN
    RAISE EXCEPTION 'tenant context leaked into a fresh connection: %',
      current_setting('app.tenant_id', true);
  END IF;

  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 0 THEN RAISE EXCEPTION 'tenants: % rows with no context', n; END IF;

  SELECT count(*) INTO n FROM public.users;
  IF n <> 0 THEN RAISE EXCEPTION 'users: % rows with no context', n; END IF;

  SELECT count(*) INTO n FROM public.memberships;
  IF n <> 0 THEN RAISE EXCEPTION 'memberships: % rows with no context', n; END IF;

  SELECT count(*) INTO n FROM public.invites;
  IF n <> 0 THEN RAISE EXCEPTION 'invites: % rows with no context', n; END IF;

  RAISE NOTICE '   ok: no tenant context -> zero rows on all four tables';
END
$t$;
COMMIT;

-- ---------------------------------------------------------------------------
-- Empty-string context is unset context, not a cast error. This is why the
-- policies wrap current_setting in NULLIF: ''::uuid raises, and an exception
-- is a much worse failure mode than an empty result when it happens on a
-- pooled connection mid-request.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '';
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.memberships;
  IF n <> 0 THEN RAISE EXCEPTION 'empty context returned % rows', n; END IF;
  RAISE NOTICE '   ok: empty-string tenant context -> zero rows, no error';
END
$t$;
COMMIT;

-- ---------------------------------------------------------------------------
-- Tenant A sees exactly tenant A.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE
  n bigint;
  ids uuid[];
BEGIN
  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 1 THEN RAISE EXCEPTION 'tenants: expected exactly 1 row, got %', n; END IF;

  SELECT count(*) INTO n FROM public.tenants
   WHERE id <> '01920000-0000-7000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'tenants: % foreign rows visible', n; END IF;

  -- Memberships: alice and carol, and nothing of Bravo's.
  SELECT count(*) INTO n FROM public.memberships;
  IF n <> 2 THEN RAISE EXCEPTION 'memberships: expected 2, got %', n; END IF;

  SELECT count(*) INTO n FROM public.memberships
   WHERE tenant_id <> '01920000-0000-7000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'memberships: % rows leaked from tenant B', n; END IF;

  -- Naming tenant B's row explicitly must be indistinguishable from it not
  -- existing (§6: errors do not leak cross-tenant existence).
  SELECT count(*) INTO n FROM public.memberships
   WHERE id = '01920000-0000-7000-8000-0000000000b2';
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B membership fetched by id'; END IF;

  SELECT count(*) INTO n FROM public.tenants
   WHERE id = '01920000-0000-7000-8000-00000000000b';
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B fetched by id'; END IF;

  -- Users are global rows, visible only through a membership in context.
  SELECT array_agg(id ORDER BY id) INTO ids FROM public.users;
  IF ids IS DISTINCT FROM ARRAY['01920000-0000-7000-8000-0000000000a1',
                                '01920000-0000-7000-8000-0000000000c1']::uuid[] THEN
    RAISE EXCEPTION 'users visible in tenant A were %, expected alice + carol', ids;
  END IF;

  -- Both of Alpha's invites; none of Bravo's.
  SELECT count(*) INTO n FROM public.invites;
  IF n <> 2 THEN RAISE EXCEPTION 'invites: expected 2, got %', n; END IF;

  RAISE NOTICE '   ok: tenant A sees 1 tenant, 2 memberships, 2 users, 2 invites';
  RAISE NOTICE '   ok: zero rows from tenant B fixtures, by scan or by id';
END
$t$;
COMMIT;

-- ---------------------------------------------------------------------------
-- And symmetrically for B — carol is in both, alice is in neither but A.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
DO $t$
DECLARE ids uuid[];
BEGIN
  SELECT array_agg(id ORDER BY id) INTO ids FROM public.users;
  IF ids IS DISTINCT FROM ARRAY['01920000-0000-7000-8000-0000000000b1',
                                '01920000-0000-7000-8000-0000000000c1']::uuid[] THEN
    RAISE EXCEPTION 'users visible in tenant B were %, expected bob + carol', ids;
  END IF;
  RAISE NOTICE '   ok: tenant B sees bob + carol; carol spans both, alice crosses nothing';
END
$t$;
COMMIT;

-- ---------------------------------------------------------------------------
-- Context does not survive the transaction. SET LOCAL is the whole reason
-- transaction pooling is safe here (§1.1).
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.memberships;
  IF n <> 0 THEN
    RAISE EXCEPTION 'context survived COMMIT: % rows still visible', n;
  END IF;
  RAISE NOTICE '   ok: tenant context did not outlive its transaction';
END
$t$;
