-- ===========================================================================
-- §2, the bootstrap trap: the six functions must work with no tenant context,
-- and must be the ONLY thing that works with no tenant context.
--
-- Deliberately no SET LOCAL app.tenant_id anywhere in this file. That is the
-- state a request is in when it arrives.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

DO $t$
DECLARE
  r   record;
  n   bigint;
  tid uuid;
BEGIN
  -- ---- 1. resolve_tenant_by_host ----------------------------------------
  SELECT * INTO r FROM auth.resolve_tenant_by_host('alpha.flightsquare.test');
  IF r.tenant_id <> '01920000-0000-7000-8000-00000000000a' THEN
    RAISE EXCEPTION 'resolve_tenant_by_host returned %', r.tenant_id;
  END IF;
  IF r.status <> 'active' OR r.plan_code <> 'pro' THEN
    RAISE EXCEPTION 'resolve_tenant_by_host lost status/plan: %, %', r.status, r.plan_code;
  END IF;

  -- A soft-deleted tenant resolves to nothing, so §7.3's disable switch and
  -- the deletion path both land at the same place: the request never starts.
  SELECT count(*) INTO n
    FROM auth.resolve_tenant_by_host('charlie.flightsquare.test');
  IF n <> 0 THEN RAISE EXCEPTION 'deleted tenant resolved by host'; END IF;

  SELECT count(*) INTO n FROM auth.resolve_tenant_by_host('nope.example.test');
  IF n <> 0 THEN RAISE EXCEPTION 'unknown host resolved'; END IF;

  -- ---- 2. resolve_tenant_by_slug ----------------------------------------
  SELECT * INTO r FROM auth.resolve_tenant_by_slug('alpha');
  IF r.name <> 'Alpha Flying Club'
     OR r.branding ->> 'primary_color' <> '#123456' THEN
    RAISE EXCEPTION 'resolve_tenant_by_slug returned %, %', r.name, r.branding;
  END IF;

  -- ---- 3. find_user_by_email --------------------------------------------
  SELECT * INTO r FROM auth.find_user_by_email('ALICE@alpha.test');
  IF r.user_id <> '01920000-0000-7000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'find_user_by_email is case-sensitive or wrong: %', r.user_id;
  END IF;
  IF r.password_hash IS NULL OR r.mfa_enabled IS NULL THEN
    RAISE EXCEPTION 'find_user_by_email did not return credential state';
  END IF;

  -- ---- 4. list_memberships_for_user -------------------------------------
  -- Carol is in both tenants. One human, one login, many memberships (§3.1).
  SELECT count(*) INTO n
    FROM auth.list_memberships_for_user('01920000-0000-7000-8000-0000000000c1');
  IF n <> 2 THEN RAISE EXCEPTION 'carol has % memberships, expected 2', n; END IF;

  SELECT count(*) INTO n
    FROM auth.list_memberships_for_user('01920000-0000-7000-8000-0000000000a1');
  IF n <> 1 THEN RAISE EXCEPTION 'alice has % memberships, expected 1', n; END IF;

  -- ---- 5. resolve_invite_token ------------------------------------------
  SELECT * INTO r FROM auth.resolve_invite_token('sha256:alpha-pending');
  IF r.tenant_id <> '01920000-0000-7000-8000-00000000000a'
     OR r.email <> 'dave@example.test' THEN
    RAISE EXCEPTION 'resolve_invite_token returned %, %', r.tenant_id, r.email;
  END IF;

  SELECT count(*) INTO n FROM auth.resolve_invite_token('sha256:alpha-expired');
  IF n <> 0 THEN RAISE EXCEPTION 'expired invite resolved'; END IF;

  SELECT count(*) INTO n FROM auth.resolve_invite_token('sha256:bravo-accepted');
  IF n <> 0 THEN RAISE EXCEPTION 'already-accepted invite resolved — not single use'; END IF;

  -- ---- 6. tenant_for_billing_customer -----------------------------------
  SELECT t.tenant_id INTO tid
    FROM auth.tenant_for_billing_customer('cus_bravo') t;
  IF tid <> '01920000-0000-7000-8000-00000000000b' THEN
    RAISE EXCEPTION 'tenant_for_billing_customer returned %', tid;
  END IF;

  RAISE NOTICE '   ok: all six §2.1 functions resolve with no tenant context';
END
$t$;

-- ---------------------------------------------------------------------------
-- The door is exactly as wide as the six functions.
--
-- The definer_bootstrap policies are keyed on a GUC that the functions set
-- for the duration of their own call. If that GUC were a general-purpose
-- unlock, this whole design would be BYPASSRLS with extra steps — so assert
-- that app_role setting it by hand changes nothing.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 0 THEN RAISE EXCEPTION 'tenants readable with no context (% rows)', n; END IF;

  PERFORM set_config('app.auth_bootstrap', 'on', true);
  IF current_setting('app.auth_bootstrap', true) <> 'on' THEN
    RAISE EXCEPTION 'test did not manage to set the flag, so it proves nothing';
  END IF;

  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap is a backdoor: % tenant rows visible to app_role', n;
  END IF;

  SELECT count(*) INTO n FROM public.users;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap is a backdoor: % user rows visible to app_role', n;
  END IF;

  SELECT count(*) INTO n FROM public.memberships;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap is a backdoor: % membership rows visible', n;
  END IF;

  -- And the write level is no better. 0003 turned the flag into a level
  -- ('on' reads, 'provision' also inserts); if either one were reachable by
  -- app_role this design would be BYPASSRLS with extra steps.
  PERFORM set_config('app.auth_bootstrap', 'provision', true);

  SELECT count(*) INTO n FROM public.tenants;
  IF n <> 0 THEN
    RAISE EXCEPTION 'app.auth_bootstrap=provision leaked % tenant rows to app_role', n;
  END IF;

  BEGIN
    INSERT INTO public.memberships (tenant_id, user_id, status)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000b1', 'active');
    RAISE EXCEPTION 'app.auth_bootstrap=provision let app_role write';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  RAISE NOTICE '   ok: setting app.auth_bootstrap by hand, at either level, grants app_role nothing';
END
$t$;

-- ---------------------------------------------------------------------------
-- And the flag does not survive the call that set it.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  PERFORM auth.resolve_tenant_by_host('alpha.flightsquare.test');
  IF current_setting('app.auth_bootstrap', true) = 'on' THEN
    RAISE EXCEPTION 'app.auth_bootstrap leaked out of the function call';
  END IF;
  RAISE NOTICE '   ok: the flag is scoped to the function call that sets it';
END
$t$;
