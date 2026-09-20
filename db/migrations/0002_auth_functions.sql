-- ===========================================================================
-- 0002_auth_functions.sql — the bootstrap door (CLAUDE.md §2)
--
-- With RLS on tenants, the application cannot look up a tenant at the start of
-- a request, because looking up the tenant IS how it obtains the context the
-- policy requires. The fix is not BYPASSRLS and not a decorative policy; it is
-- this small, closed, enumerable set of SECURITY DEFINER functions.
--
-- Every function here obeys §2's rules without exception:
--   1. search_path pinned explicitly.
--   2. REVOKE ALL FROM PUBLIC, then GRANT EXECUTE to app_role only.
--   3. Scalar arguments matched on equality. No LIKE, no arrays, no caller
--      -supplied predicates, ORDER BY or LIMIT — those turn a lookup into an
--      enumeration oracle.
--   4. Minimum columns. Never SELECT *, never a row set spanning tenants
--      (auth.list_memberships_for_user spans tenants for ONE user, which is
--      the point of it).
--   5. Lives in the auth schema and appears in the §2.1 table.
--
-- Each also carries `SET app.auth_bootstrap = 'on'`. These functions run as
-- flightsquare_owner, which FORCE ROW LEVEL SECURITY subjects to policy like
-- anyone else; that flag is what the definer_bootstrap policies in 0001 match.
-- Postgres scopes a function SET clause to the call and restores it on exit,
-- including on error — so the opening is exactly as wide as the function body
-- and no wider.
--
-- This requires `GRANT SET ON PARAMETER app.auth_bootstrap TO
-- flightsquare_owner` (db/roles.sql): Postgres 15+ will not let a function
-- pin a custom parameter without it. Provisioning a new environment without
-- that grant fails here, loudly, at CREATE FUNCTION.
--
-- Adding a seventh function is an architectural decision requiring review, not
-- routine work. The first question is always whether the caller could have set
-- tenant context and simply didn't.
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

CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA auth REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMENT ON SCHEMA auth IS
  'The §2.1 permitted list. Six functions, each a lookup that provably cannot '
  'have tenant context yet. Nothing else belongs in here.';

-- ---------------------------------------------------------------------------
-- 1. Request routing, before session.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.resolve_tenant_by_host(p_host text)
RETURNS TABLE (tenant_id uuid, status text, plan_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT t.id, t.status, t.plan_code
    FROM public.tenants t
   WHERE t.host = p_host
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.resolve_tenant_by_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_tenant_by_host(text) TO app_role;

COMMENT ON FUNCTION auth.resolve_tenant_by_host(text) IS
  '§2.1. Returns status on every request, which is what makes §7.3''s disable '
  'switch free: rejecting a suspended tenant at bootstrap reaches every entry '
  'point at once.';

-- ---------------------------------------------------------------------------
-- 2. Login page, invite acceptance.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.resolve_tenant_by_slug(p_slug text)
RETURNS TABLE (tenant_id uuid, status text, name text, branding jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT t.id, t.status, t.name, t.branding
    FROM public.tenants t
   WHERE t.slug = p_slug
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.resolve_tenant_by_slug(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_tenant_by_slug(text) TO app_role;

COMMENT ON FUNCTION auth.resolve_tenant_by_slug(text) IS
  '§2.1. name and branding are what the login page renders; no other tenant '
  'columns are returned.';

-- ---------------------------------------------------------------------------
-- 3. Credential check.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.find_user_by_email(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, mfa_enabled boolean, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT u.id, u.password_hash, u.mfa_enabled, u.status
    FROM public.users u
   WHERE lower(u.email) = lower(p_email)
     AND u.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.find_user_by_email(text) TO app_role;

COMMENT ON FUNCTION auth.find_user_by_email(text) IS
  '§2.1. Equality on lower(email), matching the unique index. The caller '
  'compares the hash and must take the same time whether or not a row came '
  'back — this function is an existence oracle if the caller lets it be.';

-- ---------------------------------------------------------------------------
-- 4. Post-auth tenant picker. Spans tenants, for one user, by design.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.list_memberships_for_user(p_user_id uuid)
RETURNS TABLE (tenant_id uuid, tenant_name text, tenant_status text,
               membership_status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT t.id, t.name, t.status, m.status
    FROM public.memberships m
    JOIN public.tenants t ON t.id = m.tenant_id
   WHERE m.user_id = p_user_id
     AND m.status <> 'removed'
     AND m.deleted_at IS NULL
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.list_memberships_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.list_memberships_for_user(uuid) TO app_role;

COMMENT ON FUNCTION auth.list_memberships_for_user(uuid) IS
  '§2.1. (tenant id, name) for that user only. The caller passes the user id '
  'from the authenticated session — never from a request parameter.';

-- ---------------------------------------------------------------------------
-- 5. Invite acceptance, pre-membership. Single use.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.resolve_invite_token(p_token_hash text)
RETURNS TABLE (invite_id uuid, tenant_id uuid, email text,
               expires_at timestamptz, tenant_name text, tenant_slug text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT i.id, i.tenant_id, i.email, i.expires_at, t.name, t.slug
    FROM public.invites i
    JOIN public.tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL
     AND i.expires_at > now()
     AND i.deleted_at IS NULL
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.resolve_invite_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_invite_token(text) TO app_role;

COMMENT ON FUNCTION auth.resolve_invite_token(text) IS
  '§2.1. Single use: an accepted, revoked or expired invite resolves to zero '
  'rows. This function only reads. Consuming the invite — setting accepted_at '
  'and creating the membership — happens afterwards with SET LOCAL '
  'app.tenant_id on the tenant_id this returned, under ordinary policy.';

-- ---------------------------------------------------------------------------
-- 6. Billing-provider webhooks.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.tenant_for_billing_customer(p_billing_customer_id text)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'on'
AS $$
  SELECT t.id
    FROM public.tenants t
   WHERE t.billing_customer_id = p_billing_customer_id
     AND t.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.tenant_for_billing_customer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.tenant_for_billing_customer(text) TO app_role;

COMMENT ON FUNCTION auth.tenant_for_billing_customer(text) IS
  '§2.1. Platform billing only (§3.7): the tenant paying FlightSquare, never '
  'a pilot paying their club. Verify the webhook signature before calling.';
