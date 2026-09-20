-- ===========================================================================
-- 0005_entitlements_and_roles.sql — what a tenant may do, and who may do it
--
-- Lands before any domain table. aircraft.active is 1 on free, so the quota
-- bites the moment aircraft exist; §1.3 forbids reaching for a plan
-- conditional as a shortcut; and §1.5 wants an explicit permission check per
-- endpoint, which is far cheaper to establish before there are endpoints.
--
-- Table classes (§2.2):
--   plans, plan_entitlements       platform / control plane
--   tenant_entitlement_overrides   tenant-scoped
--   tenant_usage                   tenant-scoped
--   role_bundles                   tenant-scoped
--   role_bundle_permissions        tenant-scoped
--
-- Run as flightsquare_owner.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'flightsquare_owner' THEN
    RAISE EXCEPTION 'migrations run as flightsquare_owner, not %', current_user;
  END IF;
END
$guard$;

-- ===========================================================================
-- The catalogue
--
-- plans and plan_entitlements are the price list. They are not customer data
-- and every tenant needs to read them to resolve anything, so they carry a
-- read-all policy for app_role. That is narrow, greppable and per-table — the
-- shape §7.1 argues for — rather than a capability handed to the role.
-- ===========================================================================

CREATE TABLE public.plans (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT plans_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$')
);

CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- value is jsonb because the three kinds of entitlement (§1.3) have three
-- different shapes: a flag is a boolean, a quota is a number or the string
-- "unlimited", a config value is whatever it is. The registry in the
-- application declares which is which, and resolution is total because every
-- key there has a global default.
CREATE TABLE public.plan_entitlements (
  plan_code  text NOT NULL REFERENCES public.plans(code) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (plan_code, key)
);

CREATE TRIGGER plan_entitlements_set_updated_at
  BEFORE UPDATE ON public.plan_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.plans (code, name, description, sort_order) VALUES
  ('free',       'Free',
   'One pilot, one aircraft, full maintenance tracking and unlimited flight logging.', 1),
  ('pro',        'Pro',
   'Up to five members, member billing, scheduling for a partnership or small club.',  2),
  ('enterprise', 'Enterprise',
   'Unlimited aircraft and members, SSO, API access.',                                 3);

-- ---------------------------------------------------------------------------
-- The tiers as they stand today (§4.3), seeded here — before RLS is enabled
-- on these tables — because reference data belongs with the table that holds
-- it. Later migrations that add a plan write through the owner policy below.
--
-- Rows, not code. Adding a "Club" plan at three aircraft and twenty-five
-- members is an INSERT: no deploy, no migration, no conditional. The moment a
-- plan code appears in an `if`, that property is gone.
--
-- Keys absent here fall through to the registry's global default, which is
-- what makes resolution total (§1.4). Two deliberate absences:
--
--   flights — there is no flight quota key at all, on any tier. A tenant that
--   hits a cap stops logging, the meters go stale, and every maintenance
--   number in the product quietly becomes wrong (§4.2). A key that does not
--   exist cannot be set by mistake.
--
--   scheduling — not a flag. Scheduling is unused in the solo case, never
--   unavailable: one pilot means the reservations table is empty, not that a
--   feature is switched off. The moment a second pilot is invited it is
--   already there and already correct.
-- ---------------------------------------------------------------------------

INSERT INTO public.plan_entitlements (plan_code, key, value) VALUES
  -- Stock quotas. A count at a point in time, enforced at creation.
  ('free',       'aircraft.active',   '1'::jsonb),
  ('pro',        'aircraft.active',   '1'::jsonb),
  ('enterprise', 'aircraft.active',   '"unlimited"'::jsonb),

  ('free',       'members.active',    '1'::jsonb),
  ('pro',        'members.active',    '5'::jsonb),
  ('enterprise', 'members.active',    '"unlimited"'::jsonb),

  ('free',       'storage.bytes',     '1073741824'::jsonb),    -- 1 GiB
  ('pro',        'storage.bytes',     '26843545600'::jsonb),   -- 25 GiB
  ('enterprise', 'storage.bytes',     '"unlimited"'::jsonb),

  -- Flow quotas. A count within a period; the mechanism exists, nothing
  -- important uses it yet.
  ('free',       'exports.per_month', '2'::jsonb),
  ('pro',        'exports.per_month', '"unlimited"'::jsonb),
  ('enterprise', 'exports.per_month', '"unlimited"'::jsonb),

  ('free',       'api.calls_per_day', '0'::jsonb),
  ('pro',        'api.calls_per_day', '0'::jsonb),
  ('enterprise', 'api.calls_per_day', '10000'::jsonb),

  -- Feature flags.
  ('free',       'member_billing',    'false'::jsonb),
  ('pro',        'member_billing',    'true'::jsonb),
  ('enterprise', 'member_billing',    'true'::jsonb),

  ('free',       'custom_branding',   'false'::jsonb),
  ('pro',        'custom_branding',   'false'::jsonb),
  ('enterprise', 'custom_branding',   'true'::jsonb),

  ('free',       'api_access',        'false'::jsonb),
  ('pro',        'api_access',        'false'::jsonb),
  ('enterprise', 'api_access',        'true'::jsonb),

  ('free',       'sso_saml',          'false'::jsonb),
  ('pro',        'sso_saml',          'false'::jsonb),
  ('enterprise', 'sso_saml',          'true'::jsonb),

  ('free',       'webhooks',          'false'::jsonb),
  ('pro',        'webhooks',          'false'::jsonb),
  ('enterprise', 'webhooks',          'true'::jsonb),

  ('free',       'audit_export',      'false'::jsonb),
  ('pro',        'audit_export',      'false'::jsonb),
  ('enterprise', 'audit_export',      'true'::jsonb);

-- maintenance_module and history.retention_days are absent on purpose: both
-- are the same on every tier (§4.3 gives maintenance tracking to all three,
-- and §4.2 keeps retention unlimited everywhere because airframe hours and
-- compliance follow an aircraft for its entire life). They live as registry
-- defaults, so there is one place to change them rather than three.

-- The first layer of §1.4's chain. Readable by the tenant, writable only by
-- the control plane: an override is a support action, not something a tenant
-- grants itself.
CREATE TABLE public.tenant_entitlement_overrides (
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id),
  key        text NOT NULL,
  value      jsonb NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, key)
);

CREATE TRIGGER tenant_entitlement_overrides_set_updated_at
  BEFORE UPDATE ON public.tenant_entitlement_overrides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- tenants.plan_code has been a bare text column with a comment saying this is
-- where it lands.
--
-- No "fix up bad values first" step, deliberately. Such an UPDATE would be a
-- silent no-op here: the owner's own tenant_isolation policy hides every row
-- when no context is set, so it would report success having changed nothing.
-- Constraint validation is not subject to RLS, so the FK below checks every
-- row that actually exists, and a bad plan_code aborts the migration loudly —
-- which is what should happen to data nobody predicted.
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_plan_code_fkey FOREIGN KEY (plan_code) REFERENCES public.plans(code);

-- ===========================================================================
-- Usage and the quota gate (§4.5)
--
-- Counting belongs in the database for the same reason isolation does: it is
-- the only place that sees every write.
-- ===========================================================================

CREATE TABLE public.tenant_usage (
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  quota_key     text NOT NULL,
  current_value bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, quota_key),
  CONSTRAINT tenant_usage_non_negative CHECK (current_value >= 0)
);

-- ---------------------------------------------------------------------------
-- §2.3 privileged helper, entry 1.
--
-- The lock is the whole point: it closes the check-then-insert race that lets
-- two concurrent requests both slip past a limit of one. Two members hitting
-- a create at the same moment is the normal case, not an exotic one.
--
-- SECURITY DEFINER because SELECT … FOR UPDATE requires UPDATE privilege, and
-- an app_role that can update its own usage counters can set one to zero and
-- walk past every quota. Per §2.3 it takes no tenant argument — the tenant
-- comes from context — so it cannot be aimed at anyone else, and it refuses
-- to run without context rather than defaulting to permissive.
--
-- The app resolves the limit (that needs plan config, which is §1.4's job)
-- and passes it in; the database does the counting and the locking.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.assert_quota(p_key text, p_limit int)
RETURNS bigint
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant  uuid := app.current_tenant_id();
  v_current bigint;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'assert_quota requires tenant context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- NULL is Unlimited. Nothing to lock and nothing to compare, and the
  -- caller must not be encouraged to encode unlimited as a large number.
  IF p_limit IS NULL THEN
    RETURN 0;
  END IF;

  -- Materialise the row so there is something to lock even before the first
  -- write of this kind, then take the lock.
  INSERT INTO public.tenant_usage AS u (tenant_id, quota_key, current_value)
  VALUES (v_tenant, p_key, 0)
  ON CONFLICT (tenant_id, quota_key) DO NOTHING;

  SELECT u.current_value INTO v_current
    FROM public.tenant_usage u
   WHERE u.tenant_id = v_tenant AND u.quota_key = p_key
     FOR UPDATE;

  IF v_current >= p_limit THEN
    RAISE EXCEPTION 'quota % exhausted', p_key
      USING ERRCODE = 'FS402', DETAIL = v_current::text;
  END IF;

  RETURN v_current;
END
$$;

REVOKE ALL ON FUNCTION public.assert_quota(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_quota(text, int) TO app_role;

COMMENT ON FUNCTION public.assert_quota(text, int) IS
  '§2.3 privileged helper. Locks this tenant''s usage row for the duration of '
  'the caller''s transaction and raises SQLSTATE FS402 with the current count '
  'in DETAIL when the limit would be exceeded. Takes no tenant argument by '
  'design: the tenant comes from context, so it cannot be pointed elsewhere.';

-- ---------------------------------------------------------------------------
-- §2.3 privileged helper, entry 2 — a trigger, so nothing can call it.
--
-- Recomputes rather than applying a delta. A delta is faster and drifts; a
-- recount over a handful of memberships cannot. If a counted set ever gets
-- large this is the line to revisit, and it will be obvious which one.
--
-- Archived and soft-deleted rows do not count (§4.5), and decrementing is
-- this function's job rather than the caller's.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.refresh_members_active_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'usage'
AS $$
DECLARE v_tenant uuid := coalesce(NEW.tenant_id, OLD.tenant_id);
BEGIN
  INSERT INTO public.tenant_usage AS u (tenant_id, quota_key, current_value)
  VALUES (v_tenant, 'members.active',
          (SELECT count(*) FROM public.memberships m
            WHERE m.tenant_id = v_tenant
              AND m.status = 'active'
              AND m.deleted_at IS NULL))
  ON CONFLICT (tenant_id, quota_key)
  DO UPDATE SET current_value = EXCLUDED.current_value, updated_at = now();
  RETURN NULL;
END
$$;

-- No GRANT: a trigger function nothing can call is a door that does not open.
REVOKE ALL ON FUNCTION public.refresh_members_active_usage() FROM PUBLIC;

CREATE TRIGGER memberships_refresh_usage
  AFTER INSERT OR UPDATE OR DELETE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.refresh_members_active_usage();

-- ===========================================================================
-- Role bundles (§1.5, §4.4)
--
-- A permission is a pair: a resource and a level from none | read | write,
-- ordered, with write implying read. A role is a named set of those pairs,
-- and it is data — adding "Chief Pilot" is an INSERT. Nothing branches on a
-- role name, ever.
-- ===========================================================================

CREATE TABLE public.role_bundles (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id),
  code       text NOT NULL,
  name       text NOT NULL,
  /** Seeded bundles cannot be deleted out from under their members. */
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  CONSTRAINT role_bundles_code_format_check CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  -- The composite target that lets role_bundle_permissions carry tenant_id
  -- without the two being able to disagree.
  CONSTRAINT role_bundles_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX role_bundles_tenant_code_key
  ON public.role_bundles (tenant_id, code) WHERE deleted_at IS NULL;

CREATE TRIGGER role_bundles_set_updated_at BEFORE UPDATE ON public.role_bundles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- tenant_id is carried rather than reached for through the bundle, so §1.1
-- holds literally and the index leads with it. The composite foreign key is
-- what makes the denormalisation safe: a permission row belonging to one
-- tenant and a bundle belonging to another is unrepresentable.
CREATE TABLE public.role_bundle_permissions (
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),
  role_bundle_id uuid NOT NULL,
  resource       text NOT NULL,
  level          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, role_bundle_id, resource),

  FOREIGN KEY (tenant_id, role_bundle_id)
    REFERENCES public.role_bundles (tenant_id, id) ON DELETE CASCADE,

  -- §1.5's resources, spelled out so a typo is a constraint violation rather
  -- than a permission that silently never matches. squawks is separate from
  -- maintenance on purpose: a pilot reports a defect but does not sign off
  -- work. subscription (what the tenant pays FlightSquare) is separate from
  -- rates and charges (what pilots pay their club) for the same reason.
  CONSTRAINT role_bundle_permissions_resource_check CHECK (resource IN (
    'aircraft', 'reservations', 'flights', 'squawks', 'maintenance',
    'rates', 'charges', 'qualifications', 'documents', 'members',
    'subscription', 'settings')),
  CONSTRAINT role_bundle_permissions_level_check
    CHECK (level IN ('none', 'read', 'write'))
);

CREATE INDEX role_bundle_permissions_bundle_idx
  ON public.role_bundle_permissions (tenant_id, role_bundle_id);

-- A membership without a bundle holds no permissions, which fails closed.
-- Made NOT NULL below, after the backfill, so every future insert path has to
-- choose deliberately rather than inherit a default.
ALTER TABLE public.memberships
  ADD COLUMN role_bundle_id uuid,
  ADD CONSTRAINT memberships_role_bundle_fkey
    FOREIGN KEY (tenant_id, role_bundle_id)
    REFERENCES public.role_bundles (tenant_id, id);

-- ---------------------------------------------------------------------------
-- The default bundles of §4.4. Called from auth.provision_tenant and from the
-- backfill below, so a tenant is never without them.
--
-- SECURITY INVOKER: it inherits whatever context its caller established,
-- which is the point — it is a helper, not a door.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.seed_default_role_bundles(p_tenant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin_id uuid;
  v_pilot_id uuid;
BEGIN
  INSERT INTO public.role_bundles (tenant_id, code, name, is_default)
  VALUES (p_tenant_id, 'admin', 'Admin', true)
  RETURNING id INTO v_admin_id;

  INSERT INTO public.role_bundles (tenant_id, code, name, is_default)
  VALUES (p_tenant_id, 'pilot', 'Pilot', true)
  RETURNING id INTO v_pilot_id;

  INSERT INTO public.role_bundle_permissions (tenant_id, role_bundle_id, resource, level)
  VALUES
    (p_tenant_id, v_admin_id, 'aircraft',       'write'),
    (p_tenant_id, v_admin_id, 'reservations',   'write'),
    (p_tenant_id, v_admin_id, 'flights',        'write'),
    (p_tenant_id, v_admin_id, 'squawks',        'write'),
    (p_tenant_id, v_admin_id, 'maintenance',    'write'),
    (p_tenant_id, v_admin_id, 'rates',          'write'),
    (p_tenant_id, v_admin_id, 'charges',        'write'),
    (p_tenant_id, v_admin_id, 'qualifications', 'write'),
    (p_tenant_id, v_admin_id, 'documents',      'write'),
    (p_tenant_id, v_admin_id, 'members',        'write'),
    (p_tenant_id, v_admin_id, 'subscription',   'write'),
    (p_tenant_id, v_admin_id, 'settings',       'write'),

    -- A pilot reports defects but does not close them, books and flies but
    -- does not set rates, and sees the fleet without editing it.
    (p_tenant_id, v_pilot_id, 'aircraft',       'read'),
    (p_tenant_id, v_pilot_id, 'reservations',   'write'),
    (p_tenant_id, v_pilot_id, 'flights',        'write'),
    (p_tenant_id, v_pilot_id, 'squawks',        'write'),
    (p_tenant_id, v_pilot_id, 'maintenance',    'read'),
    (p_tenant_id, v_pilot_id, 'rates',          'read'),
    (p_tenant_id, v_pilot_id, 'charges',        'read'),
    (p_tenant_id, v_pilot_id, 'qualifications', 'read'),
    (p_tenant_id, v_pilot_id, 'documents',      'read'),
    (p_tenant_id, v_pilot_id, 'members',        'none'),
    (p_tenant_id, v_pilot_id, 'subscription',   'none'),
    (p_tenant_id, v_pilot_id, 'settings',       'none');

  RETURN v_admin_id;
END
$$;

COMMENT ON FUNCTION public.seed_default_role_bundles(uuid) IS
  '§4.4''s two bundles. Not a §2.3 helper: SECURITY INVOKER, so it runs with '
  'whatever rights and context its caller already had. charges: read is the '
  'row-scoping question of open decision 3 — today it means every charge in '
  'the tenant, which is why the ledger must not be built before that is '
  'settled.';

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE public.plans                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans                        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_entitlements            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.tenant_entitlement_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_entitlement_overrides FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.tenant_usage                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_usage                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.role_bundles                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_bundles                 FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.role_bundle_permissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_bundle_permissions      FORCE  ROW LEVEL SECURITY;

-- The catalogue is readable by everyone who can connect. It is the price
-- list, not customer data, and resolution cannot happen without it.
CREATE POLICY catalogue_read ON public.plans
  FOR SELECT TO app_role, admin_role USING (true);
CREATE POLICY catalogue_read ON public.plan_entitlements
  FOR SELECT TO app_role, admin_role USING (true);

-- Migrations own the catalogue, so the DDL role can maintain it. Nothing at
-- runtime connects as this role.
CREATE POLICY catalogue_maintain ON public.plans
  FOR ALL TO flightsquare_owner USING (true) WITH CHECK (true);
CREATE POLICY catalogue_maintain ON public.plan_entitlements
  FOR ALL TO flightsquare_owner USING (true) WITH CHECK (true);

CREATE POLICY tenant_isolation ON public.tenant_entitlement_overrides
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.tenant_usage
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.role_bundles
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id() AND deleted_at IS NULL)
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.role_bundle_permissions
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The 'usage' level: what the trigger and assert_quota need, and nothing else.
CREATE POLICY definer_usage ON public.tenant_usage
  FOR ALL TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'usage')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'usage');

-- The counting query inside the trigger reads memberships as the owner.
ALTER POLICY definer_bootstrap ON public.memberships
  USING (current_setting('app.auth_bootstrap', true)
         IN ('on', 'provision', 'session', 'usage'));

-- Provisioning creates a tenant's bundles in the same breath as the tenant.
CREATE POLICY definer_provision ON public.role_bundles
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'provision');
CREATE POLICY definer_provision ON public.role_bundle_permissions
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'provision');
CREATE POLICY definer_provision_read ON public.role_bundles
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'provision');

-- §7.2 metadata tier: entitlements and usage are exactly what support needs
-- to answer "the customer says they cannot do X" without touching content.
CREATE POLICY admin_read ON public.tenant_entitlement_overrides
  FOR SELECT TO admin_role USING (true);
CREATE POLICY admin_read ON public.tenant_usage
  FOR SELECT TO admin_role USING (true);
CREATE POLICY admin_read ON public.role_bundles
  FOR SELECT TO admin_role USING (true);
CREATE POLICY admin_read ON public.role_bundle_permissions
  FOR SELECT TO admin_role USING (true);

-- ===========================================================================
-- Privileges
--
-- tenant_usage is deliberately read-only to app_role. A role that can update
-- its own counters can set one to zero and walk past every quota; the lock it
-- needs comes from assert_quota instead (§2.3).
-- ===========================================================================
GRANT SELECT ON public.plans                        TO app_role, admin_role;
GRANT SELECT ON public.plan_entitlements            TO app_role, admin_role;
GRANT SELECT ON public.tenant_entitlement_overrides TO app_role, admin_role;
GRANT SELECT ON public.tenant_usage                 TO app_role, admin_role;
GRANT SELECT ON public.role_bundles                 TO app_role, admin_role;
GRANT SELECT ON public.role_bundle_permissions      TO app_role, admin_role;

-- Managing roles is a tenant-admin action, gated by members: write.
GRANT INSERT, UPDATE ON public.role_bundles            TO app_role;
GRANT INSERT, UPDATE, DELETE ON public.role_bundle_permissions TO app_role;
GRANT UPDATE (role_bundle_id) ON public.memberships    TO app_role;

-- maintenance_module and history.retention_days are absent on purpose: both
-- are the same on every tier (§4.3 gives maintenance tracking to all three,
-- and §4.2 keeps retention unlimited everywhere because airframe hours and
-- compliance follow an aircraft for its entire life). They live as registry
-- defaults, so there is one place to change them rather than three.

-- ===========================================================================
-- Backfill
--
-- §1.1: background jobs, schedulers and data migrations have no request to
-- inherit context from, so they set context explicitly per tenant and loop.
-- They do not run unscoped.
--
-- Enumerating the tenants to loop over is itself a cross-tenant read, which
-- the owner's own policy refuses. app.auth_bootstrap = 'on' is the sanctioned
-- opening: it is owner-only, app_role is not a member of that role, and this
-- is reviewed migration code rather than a request path. This is the pattern
-- every later backfill should copy.
-- ===========================================================================

SET LOCAL app.auth_bootstrap = 'on';

DO $backfill$
DECLARE
  t        record;
  v_admin  uuid;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    v_admin := public.seed_default_role_bundles(t.id);

    -- Everyone who exists today created their tenant or was put there by the
    -- creator, so Admin is the honest backfill. There is no other bundle a
    -- pre-existing membership could truthfully have held.
    UPDATE public.memberships
       SET role_bundle_id = v_admin
     WHERE tenant_id = t.id
       AND role_bundle_id IS NULL;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;

RESET app.auth_bootstrap;

-- Now that every membership has one, require it.
ALTER TABLE public.memberships ALTER COLUMN role_bundle_id SET NOT NULL;

-- ===========================================================================
-- auth.provision_tenant, replaced
--
-- A tenant without role bundles is incoherent, and §4.4's "the account
-- creator is Admin" has to be true rather than aspirational. The §2.1 write
-- rules still hold unchanged: no tenant_id argument, inserts only, and any
-- user id handed in must equal app.current_user_id().
-- ===========================================================================

CREATE OR REPLACE FUNCTION auth.provision_tenant(
  p_slug          text,
  p_name          text,
  p_archetype     text,
  p_email         text,
  p_password_hash text,
  p_user_id       uuid DEFAULT NULL
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'provision'
AS $$
DECLARE
  v_tenant_id     uuid;
  v_user_id       uuid;
  v_membership_id uuid;
  v_admin_id      uuid;
BEGIN
  IF p_user_id IS NULL THEN
    IF p_email IS NULL OR p_password_hash IS NULL THEN
      RAISE EXCEPTION 'provision_tenant needs an authenticated user id, or an email and password hash'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_user_id IS DISTINCT FROM app.current_user_id() THEN
    RAISE EXCEPTION 'provision_tenant may only attach the authenticated user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.tenants (slug, name, archetype)
  VALUES (p_slug, p_name, coalesce(p_archetype, 'solo'))
  RETURNING id INTO v_tenant_id;

  IF p_user_id IS NULL THEN
    INSERT INTO public.users (email, password_hash)
    VALUES (p_email, p_password_hash)
    RETURNING id INTO v_user_id;
  ELSE
    v_user_id := p_user_id;
  END IF;

  -- §4.4: the account creator is Admin, and the bundles exist from the
  -- tenant's first moment rather than being created on demand later.
  v_admin_id := public.seed_default_role_bundles(v_tenant_id);

  INSERT INTO public.memberships (tenant_id, user_id, status, joined_at, role_bundle_id)
  VALUES (v_tenant_id, v_user_id, 'active', now(), v_admin_id)
  RETURNING id INTO v_membership_id;

  RETURN QUERY SELECT v_tenant_id, v_user_id, v_membership_id;
END
$$;
