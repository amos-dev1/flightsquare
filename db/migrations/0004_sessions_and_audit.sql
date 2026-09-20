-- ===========================================================================
-- 0004_sessions_and_audit.sql — authentication state
--
-- Until now resolveSession() threw and every session-scoped route answered
-- 401. This is what it resolves against.
--
-- Table classes (§2.2):
--   sessions              platform / control plane — belongs to a USER
--   refresh_tokens        platform / control plane
--   device_registrations  platform / control plane
--   audit_log             tenant-scoped
--
-- A session is NOT tenant-scoped. One human has one login and many
-- memberships (§3.1), so a session belongs to a user and *selects* a tenant.
-- The column is named selected_tenant_id rather than tenant_id deliberately:
-- it is not the tenant that owns the row, and the §6.1 structural test in
-- db/tests/030 correctly expects anything called tenant_id to be
-- tenant-scoped.
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
-- sessions
-- ===========================================================================
CREATE TABLE public.sessions (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id              uuid NOT NULL REFERENCES public.users(id),

  -- §10, and §7.5. Only 'user' is ever written today. The discriminator ships
  -- now because retrofitting a second session type is the part of
  -- impersonation that cannot be deferred — everything that reads a session
  -- would have to learn about it at once.
  session_type         text NOT NULL DEFAULT 'user',
  acting_admin_user_id uuid REFERENCES public.users(id),

  -- Which tenant this session has picked. NULL between authenticating and
  -- choosing one, which is a real state rather than an edge case.
  selected_tenant_id   uuid REFERENCES public.tenants(id),

  -- Short-lived, rotated on every refresh. Opaque and stored hashed: a
  -- database dump must not be a set of live sessions.
  access_token_hash    text NOT NULL,
  access_expires_at    timestamptz NOT NULL,

  -- Absolute ceiling. Refreshing extends the access token, never this.
  expires_at           timestamptz NOT NULL,
  revoked_at           timestamptz,
  last_used_at         timestamptz,

  -- From the §8.1 client header, for showing someone their active sessions.
  client               text,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT sessions_type_check
    CHECK (session_type IN ('user', 'impersonation')),
  -- An impersonation session names the admin behind it; a user session must
  -- not. §7.5: every request is tagged with both the impersonating admin and
  -- the target, and that is only possible if the pair cannot come apart.
  CONSTRAINT sessions_impersonation_check
    CHECK ((session_type = 'impersonation') = (acting_admin_user_id IS NOT NULL))
);

CREATE UNIQUE INDEX sessions_access_token_hash_key
  ON public.sessions (access_token_hash);
CREATE INDEX sessions_user_idx
  ON public.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- refresh_tokens — one row per issued token, rotated rather than reused.
--
-- Kept separate from sessions so a rotated token survives as a row. That is
-- what makes reuse detection possible: presenting a token that has already
-- been exchanged means it was captured, and the correct response is to revoke
-- the whole session rather than to issue another one.
-- ===========================================================================
CREATE TABLE public.refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  /** Set when exchanged. A second presentation after this is theft. */
  used_at    timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX refresh_tokens_token_hash_key
  ON public.refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_session_idx ON public.refresh_tokens (session_id);

-- ===========================================================================
-- device_registrations — APNs (§8.4). No push yet; the placeholder is cheap
-- and the alternative is a migration on the critical path later.
-- ===========================================================================
CREATE TABLE public.device_registrations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES public.users(id),
  platform     text NOT NULL,
  push_token   text NOT NULL,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT device_registrations_platform_check
    CHECK (platform IN ('ios', 'android', 'web'))
);

CREATE UNIQUE INDEX device_registrations_push_token_key
  ON public.device_registrations (push_token);
CREATE INDEX device_registrations_user_idx
  ON public.device_registrations (user_id);

CREATE TRIGGER device_registrations_set_updated_at
  BEFORE UPDATE ON public.device_registrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- audit_log (§3.8) — tenant-scoped, append-only.
--
-- Nothing writes to it yet; it lands here because §10 binds the acting-admin
-- column to the migration that creates the table, and because §5.9 requires
-- every plan change to be reconstructable from it six months later.
-- ===========================================================================
CREATE TABLE public.audit_log (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES public.tenants(id),
  actor_user_id        uuid REFERENCES public.users(id),
  /** §7.5: who was behind the actor, when the actor was being impersonated. */
  acting_admin_user_id uuid REFERENCES public.users(id),
  resource             text NOT NULL,
  resource_id          uuid,
  action               text NOT NULL,
  before               jsonb,
  after                jsonb,
  occurred_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_tenant_idx
  ON public.audit_log (tenant_id, occurred_at DESC);

-- ===========================================================================
-- Row-level security
--
-- sessions, refresh_tokens and device_registrations are user-scoped rather
-- than tenant-scoped, so their policy reads app.current_user_id() where a
-- tenant table would read app.current_tenant_id().
--
-- The bootstrap flag gains a third level. It is a level, not a switch:
--
--   'on'         read      the six §2.1 lookups
--   'provision'  read+insert  signup
--   'session'    read+update  session resolution and refresh rotation
--
-- Each level is granted per table, so the level that can write a session
-- cannot touch invites and the level that can create a tenant cannot rotate
-- a token. All three remain useless to app_role: the policies are TO
-- flightsquare_owner and app_role is not a member of that role.
-- ===========================================================================

ALTER TABLE public.sessions              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions              FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.device_registrations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.device_registrations  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.audit_log             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log             FORCE  ROW LEVEL SECURITY;

-- Once the password has been checked, the API knows who the user is and sets
-- app.user_id. Creating and revoking sessions happens under that context
-- through ordinary policy — no definer function is needed for the write path,
-- only for the two lookups that genuinely precede any context at all.
CREATE POLICY user_isolation ON public.sessions
  FOR ALL TO app_role, flightsquare_owner
  USING      (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY user_isolation ON public.refresh_tokens
  FOR ALL TO app_role, flightsquare_owner
  USING (
    EXISTS (SELECT 1 FROM public.sessions s
             WHERE s.id = refresh_tokens.session_id
               AND s.user_id = app.current_user_id())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.sessions s
             WHERE s.id = refresh_tokens.session_id
               AND s.user_id = app.current_user_id())
  );

CREATE POLICY user_isolation ON public.device_registrations
  FOR ALL TO app_role, flightsquare_owner
  USING      (user_id = app.current_user_id())
  WITH CHECK (user_id = app.current_user_id());

CREATE POLICY tenant_isolation ON public.audit_log
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The 'session' level: read and update, on these two tables only.
CREATE POLICY definer_session_read ON public.sessions
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'session');
CREATE POLICY definer_session_write ON public.sessions
  FOR UPDATE TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'session')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'session');

CREATE POLICY definer_session_read ON public.refresh_tokens
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'session');
CREATE POLICY definer_session_write ON public.refresh_tokens
  FOR UPDATE TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'session')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'session');

-- Resolving a session also has to know whether the user is still active,
-- whether the selected tenant is still live (§7.3), and whether the
-- membership still stands — a member removed from a club must not keep
-- reading its data until their access token expires.
ALTER POLICY definer_bootstrap ON public.tenants
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision', 'session'));
ALTER POLICY definer_bootstrap ON public.users
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision', 'session'));
ALTER POLICY definer_bootstrap ON public.memberships
  USING (current_setting('app.auth_bootstrap', true) IN ('on', 'provision', 'session'));
-- invites deliberately unchanged: session resolution has no business there.

-- §7.2 metadata tier. Session rows are metadata about access, not operational
-- content; the tokens themselves are hashes and are never selected by name.
CREATE POLICY admin_read ON public.sessions
  FOR SELECT TO admin_role USING (true);
CREATE POLICY admin_read ON public.audit_log
  FOR SELECT TO admin_role USING (true);

-- ===========================================================================
-- Privileges
-- ===========================================================================
GRANT SELECT, INSERT         ON public.sessions             TO app_role;
GRANT UPDATE (selected_tenant_id, access_token_hash, access_expires_at,
              revoked_at, last_used_at, client)
                             ON public.sessions             TO app_role;
GRANT SELECT, INSERT         ON public.refresh_tokens       TO app_role;
GRANT UPDATE (used_at, revoked_at)
                             ON public.refresh_tokens       TO app_role;
GRANT SELECT, INSERT         ON public.device_registrations TO app_role;
GRANT UPDATE (push_token, last_seen_at)
                             ON public.device_registrations TO app_role;

-- Append-only: insert and read, never update, never delete (§3.8).
GRANT SELECT, INSERT         ON public.audit_log            TO app_role;

GRANT SELECT ON public.sessions, public.audit_log TO admin_role;

-- ===========================================================================
-- §2.1 entries 8 and 9
--
-- Both pass §2.1's admission test, which is the only thing that gets a
-- function onto the list: resolving a session provably cannot have tenant
-- context, because it *is* how context is obtained. The caller could not have
-- set it and simply failed to — there is nothing to set it from.
--
-- The second one writes, so it carries the write rules §2.1 states:
--   - it takes no tenant_id and cannot reach an arbitrary tenant;
--   - it touches only the row matching the presented token and that row's own
--     session — never an arbitrary row;
--   - it is VOLATILE, and remains the only kind of function here that is.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 8. Every authenticated request, before any context exists.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.resolve_session_token(p_token_hash text)
RETURNS TABLE (
  session_id           uuid,
  user_id              uuid,
  user_status          text,
  session_type         text,
  acting_admin_user_id uuid,
  selected_tenant_id   uuid,
  tenant_status        text,
  membership_status    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'session'
AS $$
  SELECT s.id,
         s.user_id,
         u.status,
         s.session_type,
         s.acting_admin_user_id,
         s.selected_tenant_id,
         t.status,
         m.status
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
    LEFT JOIN public.tenants t
           ON t.id = s.selected_tenant_id AND t.deleted_at IS NULL
    LEFT JOIN public.memberships m
           ON m.tenant_id = s.selected_tenant_id
          AND m.user_id = s.user_id
          AND m.deleted_at IS NULL
   WHERE s.access_token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.access_expires_at > now()
     AND s.expires_at > now()
     AND u.deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION auth.resolve_session_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_session_token(text) TO app_role;

COMMENT ON FUNCTION auth.resolve_session_token(text) IS
  '§2.1 entry 8. Returns the state needed to decide whether the session still '
  'stands — not just who it is. The tenant and membership arms are LEFT JOINs '
  'so the caller can tell "no tenant selected" from "the tenant is gone" and '
  'from "they were removed from it", which are three different answers. The '
  'caller rejects a non-active user, a suspended or closed tenant (§7.3), and '
  'a membership that no longer stands.';

-- ---------------------------------------------------------------------------
-- 9. Refresh, which also cannot have context: the access token it would have
--    come from is the thing that has expired.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auth.consume_refresh_token(p_token_hash text)
RETURNS TABLE (
  session_id         uuid,
  user_id            uuid,
  selected_tenant_id uuid,
  reuse_detected     boolean
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'session'
AS $$
DECLARE
  v_token   public.refresh_tokens%ROWTYPE;
  v_session public.sessions%ROWTYPE;
BEGIN
  -- FOR UPDATE, so two devices refreshing the same token at the same instant
  -- cannot both be handed a rotation. Without the lock the loser looks
  -- exactly like a theft and would revoke a legitimate session.
  SELECT * INTO v_token
    FROM public.refresh_tokens r
   WHERE r.token_hash = p_token_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;  -- unknown token: zero rows, and the caller says nothing more
  END IF;

  SELECT * INTO v_session
    FROM public.sessions s
   WHERE s.id = v_token.session_id;

  -- Already exchanged. The legitimate holder rotated it, so whoever is
  -- presenting it now captured it. Burn the whole session rather than issue
  -- another token, and tell the caller so it can be recorded.
  IF v_token.used_at IS NOT NULL THEN
    -- Aliased throughout: session_id and user_id are also OUT parameters of
    -- this function, and an unqualified reference to one is ambiguous.
    UPDATE public.refresh_tokens r
       SET revoked_at = now()
     WHERE r.session_id = v_token.session_id
       AND r.revoked_at IS NULL;
    UPDATE public.sessions s
       SET revoked_at = now()
     WHERE s.id = v_token.session_id
       AND s.revoked_at IS NULL;

    RETURN QUERY SELECT v_token.session_id, v_session.user_id,
                        v_session.selected_tenant_id, true;
    RETURN;
  END IF;

  IF v_token.revoked_at IS NOT NULL
     OR v_token.expires_at <= now()
     OR v_session.revoked_at IS NOT NULL
     OR v_session.expires_at <= now() THEN
    RETURN;  -- expired or revoked: indistinguishable from unknown
  END IF;

  UPDATE public.refresh_tokens r SET used_at = now() WHERE r.id = v_token.id;

  RETURN QUERY SELECT v_session.id, v_session.user_id,
                      v_session.selected_tenant_id, false;
END
$$;

REVOKE ALL ON FUNCTION auth.consume_refresh_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.consume_refresh_token(text) TO app_role;

COMMENT ON FUNCTION auth.consume_refresh_token(text) IS
  '§2.1 entry 9, and the second write on the list. Marks the presented token '
  'used and returns its session, atomically, so the check and the rotation '
  'cannot come apart. Presenting an already-exchanged token revokes the whole '
  'session: rotation is what makes a captured refresh token detectable, and '
  'issuing a fresh one instead would hand the thief a live session. Issuing '
  'the replacement pair is the caller''s job, under user context.';
