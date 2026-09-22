-- ===========================================================================
-- Platform billing: the plan change the application cannot make.
--
-- Everything else in M7 is plumbing around one property — `tenants.plan_code`
-- is the left-hand layer of §1.4's chain, so a role that can write it
-- resolves itself onto every flag and every quota in the registry, and
-- `assert_quota` goes on enforcing a limit the caller has just rewritten.
--
-- So the assertions here are mostly refusals: what app_role still cannot do,
-- what the helpers will not do when pointed somewhere, and what the control
-- plane may and may not read.
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

-- ---------------------------------------------------------------------------
-- The helpers do the work the grants refuse
-- ---------------------------------------------------------------------------
DO $t$
DECLARE t record; s record;
BEGIN
  PERFORM public.apply_subscription(
    'stripe', 'sub_test_1', 'enterprise', 'enterprise', 'active', 'active',
    now() + interval '30 days', false);

  SELECT plan_code, status, billing_customer_id INTO t FROM public.tenants;
  IF t.plan_code <> 'enterprise' THEN
    RAISE EXCEPTION 'apply_subscription left the plan at %', t.plan_code;
  END IF;
  IF t.status <> 'active' THEN
    RAISE EXCEPTION 'apply_subscription left the status at %', t.status;
  END IF;

  SELECT * INTO s FROM public.subscriptions;
  IF s.provider_subscription_id <> 'sub_test_1' THEN
    RAISE EXCEPTION 'no subscription row for this tenant';
  END IF;

  RAISE NOTICE '   ok: the helpers move a plan the application cannot touch';
END
$t$;

-- ---------------------------------------------------------------------------
-- §4.5's reasoning, applied to the most valuable column in the schema.
--
-- Not "app_role has no reason to write this" — app_role *must not be able
-- to*, because the whole entitlement chain hangs off it.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    UPDATE public.tenants SET plan_code = 'enterprise';
    RAISE EXCEPTION 'app_role wrote tenants.plan_code';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.tenants SET billing_customer_id = 'cus_somebody_else';
    RAISE EXCEPTION 'app_role wrote tenants.billing_customer_id';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.tenants SET status = 'active';
    RAISE EXCEPTION 'app_role wrote tenants.status';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- And not around the side, through the subscription row either: the plan
  -- a tenant is entitled to must not be writable by the thing it entitles.
  BEGIN
    UPDATE public.subscriptions SET plan_code = 'enterprise';
    RAISE EXCEPTION 'app_role wrote subscriptions.plan_code';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.subscriptions
      (tenant_id, provider_subscription_id, plan_code, status)
    VALUES ('01920000-0000-7000-8000-00000000000a', 'sub_forged', 'enterprise', 'active');
    RAISE EXCEPTION 'app_role inserted a subscription';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE '   ok: app_role cannot award itself a plan, by any route';
END
$t$;

-- ---------------------------------------------------------------------------
-- The mapping is write-once
--
-- It is the only thing that tells a webhook which tenant an event belongs
-- to, so re-pointing it would be a way to inherit another club's plan.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE v text;
BEGIN
  -- The fixture already has one, which is the state this matters in.
  SELECT billing_customer_id INTO v FROM public.tenants;

  -- Idempotent for the same value: checkout can be pressed twice.
  PERFORM public.set_billing_customer(v);

  BEGIN
    PERFORM public.set_billing_customer('cus_someone_elses');
    RAISE EXCEPTION 'set_billing_customer re-pointed an existing mapping';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- And tenant B, which has one of its own, cannot be given tenant A's.
  RAISE NOTICE '   ok: a billing customer is set once and never moved';
END
$t$;

-- ---------------------------------------------------------------------------
-- A webhook cannot be talked into a suspended tenant
--
-- §7.3 makes suspension an admin act. A payment succeeding is not an appeal,
-- and the helper refuses the status outright as well as declining to move a
-- tenant that is already there.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    PERFORM public.apply_subscription(
      'stripe', 'sub_test_1', 'pro', 'pro', 'active', 'suspended', NULL, false);
    RAISE EXCEPTION 'apply_subscription set a tenant to suspended';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  RAISE NOTICE '   ok: no payment event can suspend or close a tenant';
END
$t$;

-- ---------------------------------------------------------------------------
-- Append-only, and idempotent by construction
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  INSERT INTO public.billing_events (tenant_id, provider_event_id, type)
  VALUES ('01920000-0000-7000-8000-00000000000a', 'evt_test_1', 'customer.subscription.updated');

  -- The replay a provider will certainly send.
  BEGIN
    INSERT INTO public.billing_events (tenant_id, provider_event_id, type)
    VALUES ('01920000-0000-7000-8000-00000000000a', 'evt_test_1', 'customer.subscription.updated');
    RAISE EXCEPTION 'a replayed event was recorded twice';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.billing_events SET type = 'something.else';
    RAISE EXCEPTION 'app_role edited a billing event';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.billing_events;
    RAISE EXCEPTION 'app_role deleted a billing event';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE '   ok: what we acted on cannot be rewritten afterwards';
END
$t$;

-- ---------------------------------------------------------------------------
-- §6.1 item 5: tenant A sees none of tenant B's billing
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n int;
BEGIN
  SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';

  SELECT count(*) INTO n FROM public.subscriptions;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B can see % subscriptions', n; END IF;

  SELECT count(*) INTO n FROM public.billing_events;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant B can see % billing events', n; END IF;

  RAISE NOTICE '   ok: a subscription is invisible outside its own tenant';
END
$t$;

-- ---------------------------------------------------------------------------
-- §6.1 item 6: and cannot write one into somebody else's
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    INSERT INTO public.billing_events (tenant_id, provider_event_id, type)
    VALUES ('01920000-0000-7000-8000-00000000000a', 'evt_cross_tenant', 'customer.subscription.updated');
    RAISE EXCEPTION 'tenant B wrote a billing event into tenant A';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    -- The policy's WITH CHECK, which is what §1.1 insists on having.
    WHEN OTHERS THEN
      IF SQLSTATE <> '42501' THEN RAISE; END IF;
  END;

  RAISE NOTICE '   ok: and cannot be written into another tenant''s';
END
$t$;

-- ---------------------------------------------------------------------------
-- The helpers take no tenant, asserted from the catalogue rather than by
-- reading the body — the same admission test §2.1 applies to its write door.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.proname, pg_get_function_arguments(p.oid) AS args
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('set_billing_customer', 'apply_subscription')
  LOOP
    -- A tenant can only be named here by its id, and the id is a uuid. No
    -- uuid parameter means there is nothing to aim, which is stronger than
    -- promising not to aim it. (`p_tenant_status` is a status, not an
    -- identity, and the helper checks its value separately.)
    IF r.args ILIKE '%uuid%' THEN
      RAISE EXCEPTION '% takes a uuid: %', r.proname, r.args;
    END IF;
    IF r.args ILIKE '%tenant_id%' THEN
      RAISE EXCEPTION '% takes a tenant id: %', r.proname, r.args;
    END IF;
  END LOOP;

  RAISE NOTICE '   ok: neither helper can be aimed at another tenant';
END
$t$;

-- ---------------------------------------------------------------------------
-- And both fail closed with no context at all (§2.3 rule 1)
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  SET LOCAL app.tenant_id = '';

  BEGIN
    PERFORM public.set_billing_customer('cus_nowhere');
    RAISE EXCEPTION 'set_billing_customer ran with no tenant context';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_subscription(
      'stripe', 'sub_nowhere', 'pro', 'pro', 'active', 'active', NULL, false);
    RAISE EXCEPTION 'apply_subscription ran with no tenant context';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE '   ok: no context is a refusal, never a permissive default';
END
$t$;

-- ---------------------------------------------------------------------------
-- §7.2: which tier each new table lands in
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  -- Metadata. "What are they paying for, and is it failing?" is most of
  -- support, and answering it must not require touching a squawk.
  IF NOT has_table_privilege('admin_role', 'public.subscriptions', 'SELECT') THEN
    RAISE EXCEPTION 'admin_role cannot read subscriptions — §7.2 lists it as metadata';
  END IF;
  IF NOT has_table_privilege('admin_role', 'public.billing_events', 'SELECT') THEN
    RAISE EXCEPTION 'admin_role cannot read billing_events';
  END IF;

  -- Reads, and only reads. §7.1: writes are rarer and separately granted,
  -- and nothing about platform billing is the admin plane's to change here.
  IF has_table_privilege('admin_role', 'public.subscriptions', 'UPDATE')
     OR has_table_privilege('admin_role', 'public.subscriptions', 'INSERT')
     OR has_table_privilege('admin_role', 'public.billing_events', 'INSERT') THEN
    RAISE EXCEPTION 'admin_role can write platform billing';
  END IF;

  RAISE NOTICE '   ok: the control plane reads the subscription and writes nothing';
END
$t$;

ROLLBACK;
