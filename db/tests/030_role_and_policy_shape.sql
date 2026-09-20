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
       AND c.relname IN ('tenants', 'users', 'memberships', 'invites')
       AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  LOOP
    RAISE EXCEPTION '%: RLS is not both ENABLEd and FORCEd', r.relname;
  END LOOP;
  RAISE NOTICE '   ok: RLS enabled and forced on all four tables';

  -- Every policy the application is subject to must carry BOTH clauses. A
  -- policy with USING alone reads correctly and writes wherever it likes.
  -- users is global (§3.1), so its policy is membership-shaped rather than
  -- tenant_id-shaped; it still resolves through app.tenant_id and it still
  -- needs a WITH CHECK.
  FOR r IN
    SELECT tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname IN ('tenant_isolation', 'tenant_visibility')
  LOOP
    IF r.qual IS NULL THEN
      RAISE EXCEPTION '%.% has no USING clause', r.tablename, r.policyname;
    END IF;
    IF r.with_check IS NULL THEN
      RAISE EXCEPTION '%.% has no WITH CHECK clause', r.tablename, r.policyname;
    END IF;
    -- One idiom: every app-facing policy resolves the tenant through
    -- app.current_tenant_id(), never by reading the GUC by hand.
    IF r.qual NOT LIKE '%current_tenant_id%'
       OR r.with_check NOT LIKE '%current_tenant_id%' THEN
      RAISE EXCEPTION '%.% does not resolve tenant via app.current_tenant_id()',
        r.tablename, r.policyname;
    END IF;
  END LOOP;

  IF (SELECT array_agg(tablename || '.' || policyname ORDER BY tablename)
        FROM pg_policies
       WHERE schemaname = 'public'
         AND policyname IN ('tenant_isolation', 'tenant_visibility'))
     IS DISTINCT FROM ARRAY['invites.tenant_isolation',
                            'memberships.tenant_isolation',
                            'tenants.tenant_isolation',
                            'users.tenant_visibility']::text[] THEN
    RAISE EXCEPTION 'the set of app-facing policies is not what 0001 installed';
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
       'find_user_by_email',
       'list_memberships_for_user',
       'provision_tenant',
       'resolve_invite_token',
       'resolve_tenant_by_host',
       'resolve_tenant_by_slug',
       'tenant_for_billing_customer']::text[] THEN
    RAISE EXCEPTION 'auth schema holds % — §2.1 is a closed list of seven', names;
  END IF;
  RAISE NOTICE '   ok: auth schema holds exactly the seven §2.1 functions';

  -- Exactly one of them writes. "Did anything else in here learn to write?"
  -- should stay a one-line catalog query.
  SELECT array_agg(p.proname ORDER BY p.proname) INTO names
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'auth' AND p.provolatile <> 's';
  IF names IS DISTINCT FROM ARRAY['provision_tenant']::text[] THEN
    RAISE EXCEPTION 'the non-STABLE functions in auth are % — expected only provision_tenant', names;
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
  RAISE NOTICE '   ok: one writer, and it cannot address an existing tenant';

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
  RAISE NOTICE '   ok: six SECURITY DEFINER, search_path pinned, PUBLIC revoked, app_role granted';
END
$t$;

-- ---------------------------------------------------------------------------
-- §7.2: the control plane reads metadata and nothing else, and writes nothing.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'users', 'memberships'] LOOP
    IF NOT has_table_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role cannot read %', t;
    END IF;
  END LOOP;

  FOREACH t IN ARRAY ARRAY['tenants', 'users', 'memberships', 'invites'] LOOP
    IF has_table_privilege('admin_role', 'public.' || t, 'INSERT')
       OR has_table_privilege('admin_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('admin_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'admin_role can write % — writes are separately granted (§7.1)', t;
    END IF;
  END LOOP;

  IF has_table_privilege('admin_role', 'public.invites', 'SELECT') THEN
    RAISE EXCEPTION 'admin_role can read invites — not in the §7.2 metadata tier';
  END IF;
  RAISE NOTICE '   ok: admin_role reads the metadata tier only, and writes nothing';
END
$t$;
