-- ===========================================================================
-- The invariants that no individual query can demonstrate: role attributes,
-- object ownership, and the shape of the policies themselves.
--
-- These are cheap and they catch the failure mode §1.2 warns about — a
-- BYPASSRLS grant that nothing in the test suite notices, because every query
-- keeps returning rows, just more of them than it should.
-- ===========================================================================

DO $t$
DECLARE r record;
BEGIN
  -- ---- §1.2: no bypass, no superuser, on any of the three ----------------
  FOR r IN
    SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb
      FROM pg_roles
     WHERE rolname IN ('app_role', 'admin_role', 'flightsquare_owner')
  LOOP
    IF r.rolsuper THEN
      RAISE EXCEPTION '% is a superuser', r.rolname;
    END IF;
    IF r.rolbypassrls THEN
      RAISE EXCEPTION '% has BYPASSRLS', r.rolname;
    END IF;
    IF r.rolcreaterole OR r.rolcreatedb THEN
      RAISE EXCEPTION '% can create roles or databases', r.rolname;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_roles
       WHERE rolname IN ('app_role', 'admin_role', 'flightsquare_owner')) <> 3 THEN
    RAISE EXCEPTION 'expected all three roles to exist';
  END IF;
  RAISE NOTICE '   ok: no role holds BYPASSRLS or superuser';

  -- ---- app_role owns nothing --------------------------------------------
  IF EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_roles o ON o.oid = c.relowner
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE o.rolname IN ('app_role', 'admin_role')
       AND n.nspname IN ('public', 'auth')
  ) THEN
    RAISE EXCEPTION 'app_role or admin_role owns an object — FORCE RLS assumes it does not';
  END IF;
  RAISE NOTICE '   ok: app_role and admin_role own nothing';

  -- ---- §6.1 items 2 and 3, checked structurally --------------------------
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname IN ('tenants', 'users', 'memberships', 'invites',
                         'sessions', 'refresh_tokens', 'device_registrations',
                         'audit_log')
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  LOOP
    RAISE EXCEPTION '%: RLS is not both ENABLEd and FORCEd', r.relname;
  END LOOP;

  -- And nothing else has escaped it. A table added without RLS is the failure
  -- this whole design exists to prevent, and it is silent.
  --
  -- Global reference tables (§2.2) legitimately have none: shared, read-only
  -- to the application, no tenant_id, never customer data. They are named
  -- here rather than inferred, so a table escapes RLS only by someone writing
  -- it down — and the check below makes sure nobody puts a tenant table on
  -- the list to quiet a failure.
  FOR r IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname NOT IN ('schema_migrations',          -- DDL bookkeeping
                             'aircraft_types', 'aerodromes',  -- §2.2 reference
                             'maintenance_interval_templates')
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  LOOP
    RAISE EXCEPTION '%: a table in public without ENABLE + FORCE RLS', r.relname;
  END LOOP;

  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public'
       AND c.relname IN ('aircraft_types', 'aerodromes',
                         'maintenance_interval_templates')
       AND a.attname = 'tenant_id' AND NOT a.attisdropped
  LOOP
    RAISE EXCEPTION '%: on the no-RLS allowlist but carries tenant_id', r.relname;
  END LOOP;

  -- And they really are read-only to the application.
  FOR r IN SELECT unnest(ARRAY['aircraft_types', 'aerodromes',
                               'maintenance_interval_templates']) AS relname LOOP
    IF has_table_privilege('app_role', 'public.' || r.relname, 'INSERT')
       OR has_table_privilege('app_role', 'public.' || r.relname, 'UPDATE')
       OR has_table_privilege('app_role', 'public.' || r.relname, 'DELETE') THEN
      RAISE EXCEPTION '%: reference data is writable by the application', r.relname;
    END IF;
  END LOOP;

  RAISE NOTICE '   ok: RLS forced everywhere but the named reference tables';

  -- Every policy the application is subject to must carry BOTH clauses. A
  -- policy with USING alone reads correctly and writes wherever it likes.
  -- users is global (§3.1), so its policy is membership-shaped rather than
  -- tenant_id-shaped; it still resolves through app.tenant_id.
  --
  -- The exception is a policy that cannot write at all: FOR SELECT takes no
  -- WITH CHECK, and demanding one would mean never being able to split read
  -- from write. users does exactly that split — see everyone in your tenant,
  -- write only yourself — so the rule is "a policy that can write carries a
  -- WITH CHECK", which is what the original one was reaching for.
  FOR r IN
    SELECT tablename, policyname, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname IN ('tenant_isolation', 'tenant_visibility',
                          'user_isolation', 'user_self_write')
  LOOP
    IF r.qual IS NULL THEN
      RAISE EXCEPTION '%.% has no USING clause', r.tablename, r.policyname;
    END IF;
    IF r.cmd IN ('ALL', 'INSERT', 'UPDATE') AND r.with_check IS NULL THEN
      RAISE EXCEPTION '%.% can write and has no WITH CHECK clause',
        r.tablename, r.policyname;
    END IF;
    IF r.cmd = 'SELECT' AND r.with_check IS NOT NULL THEN
      RAISE EXCEPTION '%.% is SELECT-only but carries a WITH CHECK',
        r.tablename, r.policyname;
    END IF;
    -- One idiom: every app-facing policy resolves identity through the
    -- accessors, never by reading a GUC by hand. Tenant-scoped tables scope
    -- by tenant; sessions and devices belong to a user and scope by user,
    -- because one human has one login and many memberships (§3.1).
    IF r.policyname IN ('user_isolation', 'user_self_write') THEN
      IF r.qual NOT LIKE '%current_user_id%'
         OR coalesce(r.with_check, r.qual) NOT LIKE '%current_user_id%' THEN
        RAISE EXCEPTION '%.% does not resolve the user via app.current_user_id()',
          r.tablename, r.policyname;
      END IF;
    ELSIF r.qual NOT LIKE '%current_tenant_id%'
          OR r.with_check NOT LIKE '%current_tenant_id%' THEN
      RAISE EXCEPTION '%.% does not resolve tenant via app.current_tenant_id()',
        r.tablename, r.policyname;
    END IF;
  END LOOP;

  IF (SELECT array_agg(tablename || '.' || policyname ORDER BY tablename, policyname)
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname IN ('tenant_isolation', 'tenant_visibility',
                            'user_isolation', 'user_self_write'))
     IS DISTINCT FROM ARRAY['aircraft.tenant_isolation',
                            'aircraft_config.tenant_isolation',
                            'aircraft_rates.tenant_isolation',
                            'audit_log.tenant_isolation',
                            'blackouts.tenant_isolation',
                            'compliance_records.tenant_isolation',
                            'device_registrations.user_isolation',
                            'flight_charges.tenant_isolation',
                            'flight_fuel.tenant_isolation',
                            'flight_meters.tenant_isolation',
                            'flights.tenant_isolation',
                            'fuel_credits.tenant_isolation',
                            'idempotency_keys.tenant_isolation',
                            'invites.tenant_isolation',
                            'ledger_adjustments.tenant_isolation',
                            'maintenance_items.tenant_isolation',
                            'member_aircraft_authorizations.tenant_isolation',
                            'member_aircraft_rates.tenant_isolation',
                            'memberships.tenant_isolation',
                            'meter_readings.tenant_isolation',
                            'refresh_tokens.user_isolation',
                            'reservation_resources.tenant_isolation',
                            'reservations.tenant_isolation',
                            'role_bundle_permissions.tenant_isolation',
                            'role_bundles.tenant_isolation',
                            'sessions.user_isolation',
                            'squawk_deferrals.tenant_isolation',
                            'squawks.tenant_isolation',
                            'tenant_entitlement_overrides.tenant_isolation',
                            'tenant_usage.tenant_isolation',
                            'tenants.tenant_isolation',
                            'users.tenant_visibility',
                            'users.user_self_write',
                            'work_orders.tenant_isolation']::text[] THEN
    RAISE EXCEPTION 'the set of app-facing policies is not what the migrations installed';
  END IF;
  RAISE NOTICE '   ok: every app-facing policy carries USING and WITH CHECK';

  -- Every table with a tenant_id column is tenant-scoped, and the reverse
  -- must not silently happen: a new table lands here the day it is created.
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND a.attname = 'tenant_id' AND NOT a.attisdropped
       AND NOT EXISTS (
         SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = c.relname
            AND p.policyname = 'tenant_isolation')
  LOOP
    RAISE EXCEPTION '%: has tenant_id but no tenant_isolation policy (§6.1)', r.relname;
  END LOOP;
  RAISE NOTICE '   ok: no table carries tenant_id without an isolation policy';
END
$t$;

-- ---------------------------------------------------------------------------
-- §2: the permitted list is closed, and every entry on it is pinned down.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  r     record;
  names text[];
BEGIN
  SELECT array_agg(p.proname ORDER BY p.proname) INTO names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth';

  IF names IS DISTINCT FROM ARRAY[
       'consume_auth_token',
       'consume_refresh_token',
       'find_user_by_email',
       'list_memberships_for_user',
       'provision_tenant',
       'request_email_token',
       'resolve_invite_token',
       'resolve_session_token',
       'resolve_tenant_by_host',
       'resolve_tenant_by_slug',
       'tenant_for_billing_customer']::text[] THEN
    RAISE EXCEPTION 'auth schema holds % — §2.1 is a closed list of eleven', names;
  END IF;
  RAISE NOTICE '   ok: auth schema holds exactly the eleven §2.1 functions';

  -- Two of them write, and the list of which is short enough to read. "Did
  -- anything else in here learn to write?" stays a one-line catalog query.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth' AND p.provolatile <> 's';
  IF names IS DISTINCT FROM ARRAY['consume_auth_token',
                                  'consume_refresh_token',
                                  'provision_tenant',
                                  'request_email_token']::text[] THEN
    RAISE EXCEPTION 'the writing functions in auth are % — expected exactly four', names;
  END IF;

  -- And the writer cannot reach an existing tenant: it takes no tenant id,
  -- checked from the catalog rather than by reading the body.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'auth' AND p.proname = 'provision_tenant'
       AND pg_get_function_arguments(p.oid) LIKE '%tenant_id%'
  ) THEN
    RAISE EXCEPTION 'provision_tenant takes a tenant id — it must only ever create a new one';
  END IF;
  RAISE NOTICE '   ok: two writers, and provisioning cannot address an existing tenant';

  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, o.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE n.nspname = 'auth'
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION 'auth.% is not SECURITY DEFINER', r.proname;
    END IF;
    IF r.owner <> 'flightsquare_owner' THEN
      RAISE EXCEPTION 'auth.% is owned by %, not the DDL role', r.proname, r.owner;
    END IF;
    -- An unpinned search_path on a definer function is a privilege-escalation
    -- vector, not a style question.
    IF r.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'auth.% has no pinned search_path', r.proname;
    END IF;
    IF has_function_privilege('public', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'auth.% is executable by PUBLIC', r.proname;
    END IF;
    IF NOT has_function_privilege('app_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'app_role cannot execute auth.%', r.proname;
    END IF;
    IF has_function_privilege('admin_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'admin_role can execute auth.% (§7.1: its own door)', r.proname;
    END IF;
  END LOOP;
  RAISE NOTICE '   ok: all eleven SECURITY DEFINER, search_path pinned, PUBLIC revoked, app_role granted';
END
$t$;

-- ---------------------------------------------------------------------------
-- §2.3: the other kind of definer function.
--
-- These hold a privilege app_role must not have, and the rule that keeps them
-- safe is that they take no tenant argument — a helper that can be pointed at
-- a tenant is a bypass wearing a different hat.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  r     record;
  names text[];
BEGIN
  SELECT array_agg(p.proname ORDER BY p.proname) INTO names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosecdef;

  IF names IS DISTINCT FROM ARRAY['assert_quota',
                                  'charge_for_flight',
                                  'credit_fuel_for_flight',
                                  'refresh_aircraft_active_usage',
                                  'refresh_aircraft_meter_totals',
                                  'refresh_members_active_usage',
                                  'sync_blackout_resource_window',
                                  'sync_reservation_resource_window']::text[] THEN
    RAISE EXCEPTION 'public holds SECURITY DEFINER functions % — §2.3 is a closed list', names;
  END IF;

  FOR r IN
    SELECT p.oid, p.proname, p.proconfig, o.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles o ON o.oid = p.proowner
     WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    IF r.owner <> 'flightsquare_owner' THEN
      RAISE EXCEPTION 'public.% is owned by %, not the DDL role', r.proname, r.owner;
    END IF;
    IF r.proconfig IS NULL
       OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) c WHERE c LIKE 'search_path=%') THEN
      RAISE EXCEPTION 'public.% has no pinned search_path', r.proname;
    END IF;
    IF has_function_privilege('public', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'public.% is executable by PUBLIC', r.proname;
    END IF;
    -- Rule 2, the absolute one.
    IF pg_get_function_arguments(r.oid) LIKE '%tenant_id%' THEN
      RAISE EXCEPTION 'public.% takes a tenant id — it could be aimed elsewhere', r.proname;
    END IF;
  END LOOP;

  -- A trigger function nothing can call is a door that does not open.
  FOR r IN
    SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef AND p.prorettype = 'trigger'::regtype
  LOOP
    IF has_function_privilege('app_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'app_role can call the trigger function public.% directly', r.proname;
    END IF;
  END LOOP;

  RAISE NOTICE '   ok: §2.3 helpers take no tenant argument and are not public';
END
$t$;

-- ---------------------------------------------------------------------------
-- §7.2: the control plane reads metadata and nothing else, and writes nothing.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'users', 'memberships', 'sessions', 'audit_log'] LOOP
    IF NOT has_table_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role cannot read %', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['tenants', 'users', 'memberships', 'invites',
                           'sessions', 'refresh_tokens', 'device_registrations',
                           'audit_log'] LOOP
    IF has_table_privilege('admin_role', 'public.' || t, 'INSERT')
       OR has_table_privilege('admin_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('admin_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'admin_role can write % — writes are separately granted (§7.1)', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['invites', 'refresh_tokens', 'device_registrations'] LOOP
    IF has_table_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role can read % — not in the §7.2 metadata tier', t;
    END IF;
  END LOOP;
  -- §3.8: audit rows are written and read, never edited or removed. The
  -- plane that records what happened cannot rewrite its own record.
  IF has_table_privilege('app_role', 'public.audit_log', 'UPDATE')
     OR has_table_privilege('app_role', 'public.audit_log', 'DELETE') THEN
    RAISE EXCEPTION 'audit_log is not append-only for app_role';
  END IF;

  -- §4.5: a role that can update its own counters can set one to zero and
  -- walk past every quota. The lock it needs comes from assert_quota instead.
  IF has_table_privilege('app_role', 'public.tenant_usage', 'INSERT')
     OR has_table_privilege('app_role', 'public.tenant_usage', 'UPDATE')
     OR has_table_privilege('app_role', 'public.tenant_usage', 'DELETE') THEN
    RAISE EXCEPTION 'app_role can write its own usage counters';
  END IF;

  -- An override is a support action, not something a tenant grants itself.
  IF has_table_privilege('app_role', 'public.tenant_entitlement_overrides', 'INSERT')
     OR has_table_privilege('app_role', 'public.tenant_entitlement_overrides', 'UPDATE') THEN
    RAISE EXCEPTION 'app_role can grant itself entitlement overrides';
  END IF;

  -- §7.2 draws its line *within* a table for aircraft: registration, type
  -- and status, but not operating detail. A row policy cannot express that;
  -- a column grant can, and this proves the difference is real rather than
  -- documented.
  IF has_table_privilege('admin_role', 'public.aircraft', 'SELECT') THEN
    RAISE EXCEPTION 'admin_role holds table-wide SELECT on aircraft, not the §7.2 column subset';
  END IF;
  IF NOT has_column_privilege('admin_role', 'public.aircraft', 'registration', 'SELECT') THEN
    RAISE EXCEPTION 'admin_role cannot read a registration, which §7.2 says it may';
  END IF;

  -- Content tier: a maintenance discrepancy history is litigation-grade and
  -- needs a time-boxed, logged, tenant-consented grant, which does not exist.
  FOREACH t IN ARRAY ARRAY['meter_readings', 'aircraft_config'] LOOP
    IF has_any_column_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role can read % — that is content, not metadata (§7.2)', t;
    END IF;
  END LOOP;

  -- §3.4: the totals are derived from an append-only log. An application that
  -- can write them directly makes the log optional and the audit trail a
  -- suggestion.
  FOREACH t IN ARRAY ARRAY['hobbs', 'tach', 'airframe_hours', 'cycles',
                           'totals_updated_at'] LOOP
    IF has_column_privilege('app_role', 'public.aircraft', t, 'UPDATE') THEN
      RAISE EXCEPTION 'app_role can write aircraft.%, a derived total', t;
    END IF;
  END LOOP;

  IF has_table_privilege('app_role', 'public.meter_readings', 'UPDATE')
     OR has_table_privilege('app_role', 'public.meter_readings', 'DELETE') THEN
    RAISE EXCEPTION 'meter_readings is not append-only';
  END IF;

  RAISE NOTICE '   ok: admin_role reads the metadata tier only, and writes nothing';
  RAISE NOTICE '   ok: audit_log is append-only, and usage is not app-writable';
  RAISE NOTICE '   ok: meters are append-only and their totals are not app-writable';
END
$t$;
