-- ===========================================================================
-- Entitlements, usage counting, and role bundles.
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

-- ---------------------------------------------------------------------------
-- The catalogue is readable by anyone and writable by nobody here.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  -- Deliberately with no tenant context: resolving a plan is not tenant data.
  SELECT count(*) INTO n FROM public.plans;
  IF n <> 3 THEN RAISE EXCEPTION 'expected 3 plans, got %', n; END IF;

  SELECT count(*) INTO n FROM public.plan_entitlements WHERE plan_code = 'free';
  IF n = 0 THEN RAISE EXCEPTION 'the free plan has no entitlements'; END IF;

  BEGIN
    INSERT INTO public.plans (code, name) VALUES ('freebie', 'Freebie');
    RAISE EXCEPTION 'app_role invented a plan';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: the catalogue is readable, and not writable by the app';
  END;

  -- §4.2: there is no flight quota on any tier, and the surest way to keep it
  -- that way is for the key not to exist.
  SELECT count(*) INTO n FROM public.plan_entitlements WHERE key LIKE 'flights%';
  IF n <> 0 THEN RAISE EXCEPTION 'a flights quota has appeared'; END IF;

  -- Scheduling is unused, never unavailable — so it is not a flag either.
  SELECT count(*) INTO n FROM public.plan_entitlements WHERE key LIKE '%scheduling%';
  IF n <> 0 THEN RAISE EXCEPTION 'scheduling has become a feature flag'; END IF;
  RAISE NOTICE '   ok: no flights quota and no scheduling flag exist to be set';
END
$t$;

-- ---------------------------------------------------------------------------
-- §6.1 for the new tenant-scoped tables.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.role_bundles;
  IF n <> 2 THEN RAISE EXCEPTION 'tenant A has % role bundles, expected 2', n; END IF;

  SELECT count(*) INTO n FROM public.role_bundles
   WHERE tenant_id <> '01920000-0000-7000-8000-00000000000a';
  IF n <> 0 THEN RAISE EXCEPTION 'role bundles leaked from another tenant'; END IF;

  SELECT count(*) INTO n FROM public.role_bundle_permissions;
  IF n <> 24 THEN RAISE EXCEPTION 'expected 24 permission rows, got %', n; END IF;

  -- §1.5's two load-bearing distinctions, as data.
  IF (SELECT level FROM public.role_bundle_permissions p
       JOIN public.role_bundles b ON b.id = p.role_bundle_id
      WHERE b.code = 'pilot' AND p.resource = 'squawks') <> 'write' THEN
    RAISE EXCEPTION 'a pilot cannot report a defect';
  END IF;
  IF (SELECT level FROM public.role_bundle_permissions p
       JOIN public.role_bundles b ON b.id = p.role_bundle_id
      WHERE b.code = 'pilot' AND p.resource = 'maintenance') <> 'read' THEN
    RAISE EXCEPTION 'a pilot can sign off maintenance';
  END IF;
  RAISE NOTICE '   ok: bundles are tenant-scoped, and squawks is not maintenance';

  BEGIN
    INSERT INTO public.role_bundles (tenant_id, code, name)
    VALUES ('01920000-0000-7000-8000-00000000000b', 'sneaky', 'Sneaky');
    RAISE EXCEPTION 'WITH CHECK did not reject a bundle for tenant B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cannot create a role bundle in another tenant';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- The composite foreign key: a permission row and its bundle cannot belong to
-- different tenants. This is what makes carrying tenant_id safe rather than
-- merely convenient.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE v_other uuid;
BEGIN
  -- A bundle id from tenant B, obtained the only way a test can: out of band.
  -- Under tenant A's policy the row is invisible, which is the point.
  SELECT id INTO v_other FROM public.role_bundles
   WHERE tenant_id = '01920000-0000-7000-8000-00000000000b';
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'tenant B''s bundle was visible from tenant A';
  END IF;

  -- Claiming our own tenant while pointing at a bundle that is not ours.
  BEGIN
    INSERT INTO public.role_bundle_permissions
      (tenant_id, role_bundle_id, resource, level)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000ff', 'aircraft', 'write');
    RAISE EXCEPTION 'a permission row attached to a foreign bundle was accepted';
  EXCEPTION
    WHEN foreign_key_violation THEN
      RAISE NOTICE '   ok: a permission row cannot point at another tenant''s bundle';
    WHEN insufficient_privilege THEN
      RAISE NOTICE '   ok: a permission row cannot point at another tenant''s bundle';
  END;
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Usage counting, maintained by the trigger rather than by callers.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE
  v_usage  bigint;
  v_bundle uuid;
BEGIN
  SELECT current_value INTO v_usage FROM public.tenant_usage
   WHERE quota_key = 'members.active';
  IF v_usage <> 2 THEN
    RAISE EXCEPTION 'tenant A has 2 active members, usage says %', v_usage;
  END IF;

  SELECT id INTO v_bundle FROM public.role_bundles WHERE code = 'pilot';

  INSERT INTO public.memberships (tenant_id, user_id, status, role_bundle_id)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000b1', 'active', v_bundle);

  SELECT current_value INTO v_usage FROM public.tenant_usage
   WHERE quota_key = 'members.active';
  IF v_usage <> 3 THEN RAISE EXCEPTION 'usage did not follow the insert: %', v_usage; END IF;

  -- §4.5: removed members do not count, and decrementing is the trigger's job.
  UPDATE public.memberships SET status = 'removed'
   WHERE user_id = '01920000-0000-7000-8000-0000000000b1';

  SELECT current_value INTO v_usage FROM public.tenant_usage
   WHERE quota_key = 'members.active';
  IF v_usage <> 2 THEN RAISE EXCEPTION 'removal did not decrement: %', v_usage; END IF;
  RAISE NOTICE '   ok: usage tracks active members up and down';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- assert_quota (§2.3, §4.5).
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE
  v_current bigint;
  v_detail  text;
BEGIN
  -- Two active members, so a limit of five has room and a limit of two does not.
  v_current := public.assert_quota('members.active', 5);
  IF v_current <> 2 THEN RAISE EXCEPTION 'expected usage 2, got %', v_current; END IF;

  BEGIN
    PERFORM public.assert_quota('members.active', 2);
    RAISE EXCEPTION 'assert_quota allowed a create at the limit';
  EXCEPTION WHEN SQLSTATE 'FS402' THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF v_detail <> '2' THEN
      RAISE EXCEPTION 'expected the current count in DETAIL, got %', v_detail;
    END IF;
    RAISE NOTICE '   ok: assert_quota raises FS402 with the count in DETAIL';
  END;

  -- NULL is Unlimited. The caller must never encode that as a large number.
  v_current := public.assert_quota('members.active', NULL);
  IF v_current <> 0 THEN RAISE EXCEPTION 'unlimited should short-circuit'; END IF;

  -- A key with no usage row yet starts at zero rather than failing.
  v_current := public.assert_quota('aircraft.active', 1);
  IF v_current <> 0 THEN RAISE EXCEPTION 'a fresh quota key should be 0, got %', v_current; END IF;
  RAISE NOTICE '   ok: unlimited short-circuits and an unused key starts at zero';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- §2.3 rule 1: it requires tenant context and fails closed without it.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    PERFORM public.assert_quota('members.active', 1);
    RAISE EXCEPTION 'assert_quota ran with no tenant context';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: assert_quota refuses to run without tenant context';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- Overrides are readable by the tenant and grantable only by the control
-- plane — otherwise §1.4's chain would have a layer tenants write themselves.
-- ---------------------------------------------------------------------------
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.tenant_entitlement_overrides;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant A starts with no overrides, found %', n; END IF;

  BEGIN
    INSERT INTO public.tenant_entitlement_overrides (tenant_id, key, value)
    VALUES ('01920000-0000-7000-8000-00000000000a', 'aircraft.active', '999'::jsonb);
    RAISE EXCEPTION 'a tenant granted itself an override';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a tenant cannot grant itself an entitlement override';
  END;
END
$t$;
ROLLBACK;
