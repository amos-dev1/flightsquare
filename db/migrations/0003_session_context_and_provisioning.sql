-- ===========================================================================
-- 0003_session_context_and_provisioning.sql
--
-- Two decisions, taken together because each needs the other.
--
-- (1) The database session carries user identity. `SET LOCAL app.user_id`
--     accompanies `SET LOCAL app.tenant_id` on every transaction, so §4.4's
--     row scoping ("a pilot's charges: read means their own ledger") can be a
--     policy rather than a remembered WHERE clause. Nothing in this migration
--     needs row scoping yet; what it needs is the context to exist before the
--     session model hardens, and one place where the two GUCs are read.
--
-- (2) auth.provision_tenant — the seventh function, and the first WRITE on
--     the §2.1 list. Creating a tenant and its first user provably cannot
--     have tenant context: the tenant does not exist yet. That is §2.1's own
--     admission test, and it is the only operation that passes it.
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
-- Session context
--
-- These two functions are the only place the request GUCs are read. Both are
-- deliberately inlinable — no pinned search_path, because an RLS policy
-- evaluates them once per row and a non-inlinable function there is a real
-- cost on every scan. Safe without the pin because the body names
-- pg_catalog.current_setting explicitly and NULLIF is SQL syntax rather than
-- a function, so neither can be shadowed by anything on the search_path.
--
-- NULLIF is what makes unset context mean zero rows: current_setting(..., true)
-- returns NULL when the GUC was never set but '' when it was set empty, and
-- ''::uuid raises. An exception mid-request on a pooled connection is a far
-- worse failure mode than an empty result.
-- ===========================================================================

CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO app_role, admin_role;

COMMENT ON SCHEMA app IS
  'Request context. Not a home for business logic — two accessors live here '
  'and nothing else should.';

CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid
$$;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_role, admin_role;
GRANT EXECUTE ON FUNCTION app.current_user_id()   TO app_role, admin_role;

COMMENT ON FUNCTION app.current_user_id() IS
  'The authenticated user, resolved server-side and set with SET LOCAL on the '
  'same transaction as app.tenant_id. Like the tenant id it never comes from '
  'a header, query parameter, path segment or JSON body (§1.1).';

-- ---------------------------------------------------------------------------
-- Restate the existing policies in terms of the accessors. Same predicates,
-- one idiom — worth doing now, while there are four tables rather than forty.
-- ---------------------------------------------------------------------------
ALTER POLICY tenant_isolation ON public.tenants
  USING      (id = app.current_tenant_id() AND deleted_at IS NULL)
  WITH CHECK (id = app.current_tenant_id());

ALTER POLICY tenant_isolation ON public.memberships
  USING      (tenant_id = app.current_tenant_id() AND deleted_at IS NULL)
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER POLICY tenant_isolation ON public.invites
  USING      (tenant_id = app.current_tenant_id() AND deleted_at IS NULL)
  WITH CHECK (tenant_id = app.current_tenant_id());

-- A user is visible inside a tenant when they are a member of it — and now
-- also to themselves. §3.1 says a user with no memberships is valid (just
-- invited, or removed from their last org); without the second arm such a
-- user cannot read their own row, which is the state every session is in
-- between authenticating and picking a tenant.
ALTER POLICY tenant_visibility ON public.users
  USING (
    deleted_at IS NULL
    AND (
      id = app.current_user_id()
      OR EXISTS (
        SELECT 1 FROM public.memberships m
         WHERE m.user_id = users.id
           AND m.tenant_id = app.current_tenant_id()
           AND m.deleted_at IS NULL
      )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = app.current_tenant_id()
         AND m.deleted_at IS NULL
    )
  );

-- ===========================================================================
-- The provisioning door
--
-- 0001's definer_bootstrap policies are SELECT-only, which is right for six
-- read functions and not enough for one that writes. Rather than a second
-- parameter — which would need a superuser GRANT SET ON PARAMETER and so an
-- extra step in every environment — app.auth_bootstrap becomes a level:
--
--   'on'         read. What the six §2.1 lookups set.
--   'provision'  read and insert. What auth.provision_tenant sets, and
--                nothing else. The six read functions cannot write even by
--                accident, because they never set this value.
--
-- Both remain scoped to the function call that sets them, and both remain
-- useless to app_role: these policies are TO flightsquare_owner and app_role
-- is not a member of that role.
-- ===========================================================================

ALTER POLICY definer_bootstrap ON public.tenants
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision'));
ALTER POLICY definer_bootstrap ON public.users
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision'));
ALTER POLICY definer_bootstrap ON public.memberships
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision'));
ALTER POLICY definer_bootstrap ON public.invites
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision'));

CREATE POLICY definer_provision ON public.tenants
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'provision');

CREATE POLICY definer_provision ON public.users
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'provision');

CREATE POLICY definer_provision ON public.memberships
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'provision');

-- Deliberately no definer_provision on invites: inviting happens inside a
-- tenant, under tenant context, through ordinary policy.

-- ===========================================================================
-- auth.provision_tenant — §2.1 entry 7
--
-- §2's rules were written for lookups and mostly transfer unchanged: pinned
-- search_path, revoked from PUBLIC, granted to app_role only, minimum
-- columns out. Rule 3 ("scalar arguments matched on equality") is about not
-- turning a lookup into an enumeration oracle; a write function's arguments
-- are values to store, not predicates, so the equivalent rules for writes are:
--
--   a. It takes no tenant_id. It can only ever create a NEW tenant, never
--      reach into an existing one. This is the property that keeps a write
--      definer function as narrow as a read one, and test 050 asserts it
--      from the catalog rather than trusting the body.
--   b. It inserts and never updates or deletes. Nothing existing changes.
--   c. Any user id it is handed must match the authenticated session. The
--      caller cannot attach somebody else's account to a tenant it just
--      made, and that is checked here rather than promised by the API.
--   d. It is the only VOLATILE function in the schema, which makes "did
--      anything else in here learn to write?" a one-line catalog query.
--
-- Abuse is the API's problem, not the policy's: nothing stops app_role
-- calling this in a loop, so signup gets rate limiting at the boundary (429,
-- and §1.6 is explicit that 429 is not a quota).
-- ===========================================================================

CREATE FUNCTION auth.provision_tenant(
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
BEGIN
  IF p_user_id IS NULL THEN
    IF p_email IS NULL OR p_password_hash IS NULL THEN
      RAISE EXCEPTION 'provision_tenant needs an authenticated user id, or an email and password hash'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_user_id IS DISTINCT FROM app.current_user_id() THEN
    -- Rule (c). An authenticated user may create a second tenant for
    -- themselves — one human, one login, many memberships (§3.1) — and for
    -- nobody else.
    RAISE EXCEPTION 'provision_tenant may only attach the authenticated user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.tenants (slug, name, archetype)
  VALUES (p_slug, p_name, coalesce(p_archetype, 'solo'))
  RETURNING id INTO v_tenant_id;

  IF p_user_id IS NULL THEN
    -- The hash is computed by the caller. This function never sees a password.
    INSERT INTO public.users (email, password_hash)
    VALUES (p_email, p_password_hash)
    RETURNING id INTO v_user_id;
  ELSE
    v_user_id := p_user_id;
  END IF;

  -- The account creator is Admin (§4.4). Which role bundle that is becomes a
  -- column here when role_bundles lands; today a membership is the grant.
  INSERT INTO public.memberships (tenant_id, user_id, status, joined_at)
  VALUES (v_tenant_id, v_user_id, 'active', now())
  RETURNING id INTO v_membership_id;

  RETURN QUERY SELECT v_tenant_id, v_user_id, v_membership_id;
END
$$;

REVOKE ALL ON FUNCTION auth.provision_tenant(text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.provision_tenant(text, text, text, text, text, uuid) TO app_role;

COMMENT ON FUNCTION auth.provision_tenant(text, text, text, text, text, uuid) IS
  '§2.1 entry 7, and the only write on the list. Creates a tenant, optionally '
  'a user, and the creator''s membership, atomically. Takes no tenant_id and '
  'can only create a new tenant. A duplicate slug or email surfaces as a '
  'unique violation — the caller must answer both with the same generic '
  'message, or signup becomes an account-existence oracle.';
