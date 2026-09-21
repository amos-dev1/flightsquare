-- ===========================================================================
-- 0010_permission_scope.sql — the third dimension §4.4 asked for
--
-- CLAUDE.md §4.4 names this as the first place the permission model genuinely
-- does not stretch:
--
--   "`charges: read` cannot mean 'every pilot sees everyone's ledger' — in a
--    club that is plainly wrong... Resource + level has no way to say 'own
--    rows only', so the permission model needs a third dimension
--    (`scope: own | all`) or `charges` needs a bespoke rule. This is the
--    first place the model genuinely does not stretch, and it should be
--    designed deliberately before the ledger is built rather than patched in
--    afterward."
--
-- So: a dimension, not a bespoke rule. A permission becomes a triple —
-- resource, level, scope — and `charges: read, own` says exactly what a club
-- means. A bespoke rule for `charges` would have to be written again for the
-- next resource that needs it, and there will be one.
--
-- **Where it is enforced is already decided.** §10: "The database session
-- carries user identity... Row scoping will therefore be enforced in RLS
-- rather than by a remembered WHERE clause, consistent with §1.1 — the
-- database is the thing standing between people and data, not the
-- application." The accessors below are what a policy consults to do that.
--
-- Nothing is scoped yet, because the only table that needs it does not exist
-- until M6. That is the point: the dimension is settled and proved before the
-- ledger is built, which is what §4.4 asked for.
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

ALTER TABLE public.role_bundle_permissions
  ADD COLUMN scope text NOT NULL DEFAULT 'all',
  ADD CONSTRAINT role_bundle_permissions_scope_check CHECK (scope IN ('own', 'all'));

COMMENT ON COLUMN public.role_bundle_permissions.scope IS
  'Which rows the level applies to: every row in the tenant, or only those '
  'belonging to this member. Defaults to ''all'' because that is what every '
  'resource meant before this column existed, and a default that silently '
  'narrowed an existing grant would be a migration that broke a tenant.';

-- ===========================================================================
-- What a policy asks
--
-- Both SECURITY INVOKER and both STABLE: they read rows the caller can
-- already read, under the caller's own context and policies, and the planner
-- is free to evaluate them once per query rather than once per row.
--
-- Not §2.3 helpers — they hold no privilege app_role lacks. A §2.3 helper
-- exists because the application *must not* be able to do something
-- directly; these do exactly what a hand-written join would do, in one place
-- so that every policy asks the question the same way.
-- ===========================================================================

/**
 * The caller's own membership in the tenant they are standing in.
 *
 * This is the anchor for every "own rows" test. It is a membership rather
 * than a user because §3.1 makes that distinction load-bearing: the same
 * human has a different membership — and a different set of charges — in
 * each club they fly with.
 */
CREATE FUNCTION app.current_membership_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT m.id
    FROM public.memberships m
   WHERE m.user_id = app.current_user_id()
     AND m.tenant_id = app.current_tenant_id()
     AND m.status = 'active'
     AND m.deleted_at IS NULL
$$;

COMMENT ON FUNCTION app.current_membership_id() IS
  'NULL when the session has no tenant, no user, or no live membership in '
  'that tenant — and a policy comparing against NULL matches nothing, which '
  'is the §1.1 failure mode: unset context means zero rows, never all rows.';

/**
 * How far a level reaches for this member on this resource.
 *
 * Returns 'none' when they hold nothing at all, so a policy can tell "you
 * may see your own" apart from "you may see none of it" without a second
 * lookup.
 */
CREATE FUNCTION app.permission_scope(p_resource text) RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    (SELECT p.scope
       FROM public.memberships m
       JOIN public.role_bundle_permissions p
         ON p.tenant_id = m.tenant_id AND p.role_bundle_id = m.role_bundle_id
      WHERE m.user_id = app.current_user_id()
        AND m.tenant_id = app.current_tenant_id()
        AND m.status = 'active'
        AND m.deleted_at IS NULL
        AND p.resource = p_resource
        AND p.level <> 'none'),
    'none')
$$;

/**
 * The shape a scoped policy is meant to take, so every one of them reads the
 * same and none of them has to remember the NULL cases.
 *
 * A policy on a member-owned table becomes:
 *
 *   USING (tenant_id = app.current_tenant_id()
 *          AND app.owns_row('charges', member_id))
 *
 * and that is the whole of row scoping at the call site.
 */
CREATE FUNCTION app.owns_row(p_resource text, p_member_id uuid) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT CASE app.permission_scope(p_resource)
           WHEN 'all'  THEN true
           WHEN 'own'  THEN p_member_id IS NOT NULL
                            AND p_member_id = app.current_membership_id()
           ELSE false
         END
$$;

COMMENT ON FUNCTION app.owns_row(text, uuid) IS
  'False for a member who holds nothing on the resource, and false for a '
  '''own'' member looking at somebody else''s row — including a row that '
  'belongs to nobody, which is a row nobody scoped should see either.';

GRANT EXECUTE ON FUNCTION app.current_membership_id() TO app_role, admin_role;
GRANT EXECUTE ON FUNCTION app.permission_scope(text)  TO app_role, admin_role;
GRANT EXECUTE ON FUNCTION app.owns_row(text, uuid)    TO app_role, admin_role;

-- ===========================================================================
-- The one bundle that needs it today
--
-- §4.4's Pilot row reads `charges: read — own only, see below`, and this is
-- the "below". Every other pair keeps 'all': a club's flights, squawks and
-- maintenance are shared by design — the next pilot needs to know what the
-- last one found — and narrowing them would be a different product.
-- ===========================================================================

SET LOCAL app.auth_bootstrap = 'on';

DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    UPDATE public.role_bundle_permissions p
       SET scope = 'own'
      FROM public.role_bundles b
     WHERE b.tenant_id = p.tenant_id
       AND b.id = p.role_bundle_id
       AND p.tenant_id = t.id
       AND p.resource = 'charges'
       AND b.code = 'pilot'
       AND b.is_default;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;

RESET app.auth_bootstrap;

-- ===========================================================================
-- And every tenant created from here on
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.seed_default_role_bundles(p_tenant_id uuid)
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

  INSERT INTO public.role_bundle_permissions
    (tenant_id, role_bundle_id, resource, level, scope)
  VALUES
    (p_tenant_id, v_admin_id, 'aircraft',       'write', 'all'),
    (p_tenant_id, v_admin_id, 'reservations',   'write', 'all'),
    (p_tenant_id, v_admin_id, 'flights',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'squawks',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'maintenance',    'write', 'all'),
    (p_tenant_id, v_admin_id, 'rates',          'write', 'all'),
    (p_tenant_id, v_admin_id, 'charges',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'qualifications', 'write', 'all'),
    (p_tenant_id, v_admin_id, 'documents',      'write', 'all'),
    (p_tenant_id, v_admin_id, 'members',        'write', 'all'),
    (p_tenant_id, v_admin_id, 'subscription',   'write', 'all'),
    (p_tenant_id, v_admin_id, 'settings',       'write', 'all'),

    -- A pilot reports defects but does not close them, books and flies but
    -- does not set rates, and sees the fleet without editing it.
    (p_tenant_id, v_pilot_id, 'aircraft',       'read',  'all'),
    (p_tenant_id, v_pilot_id, 'reservations',   'write', 'all'),
    (p_tenant_id, v_pilot_id, 'flights',        'write', 'all'),
    (p_tenant_id, v_pilot_id, 'squawks',        'write', 'all'),
    (p_tenant_id, v_pilot_id, 'maintenance',    'read',  'all'),
    (p_tenant_id, v_pilot_id, 'rates',          'read',  'all'),
    -- The one that needed a third dimension to be sayable at all. A club
    -- where every pilot reads everyone's ledger is plainly wrong, and a
    -- four-way partnership may not want it either.
    (p_tenant_id, v_pilot_id, 'charges',        'read',  'own'),
    (p_tenant_id, v_pilot_id, 'qualifications', 'read',  'all'),
    (p_tenant_id, v_pilot_id, 'documents',      'read',  'all'),
    (p_tenant_id, v_pilot_id, 'members',        'none',  'all'),
    (p_tenant_id, v_pilot_id, 'subscription',   'none',  'all'),
    (p_tenant_id, v_pilot_id, 'settings',       'none',  'all');

  RETURN v_admin_id;
END
$$;

COMMENT ON FUNCTION public.seed_default_role_bundles(uuid) IS
  '§4.4''s two bundles. Not a §2.3 helper: SECURITY INVOKER, so it runs with '
  'whatever rights and context its caller already had. `charges: read, own` '
  'is CLAUDE.md §10 decision 3, settled — a pilot sees their own ledger, and '
  'a policy on the ledger enforces it rather than a WHERE clause somebody '
  'has to remember.';
