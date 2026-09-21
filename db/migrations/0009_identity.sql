-- ===========================================================================
-- 0009_identity.sql — M1: the people, and the ways they arrive
--
-- v1 needs a club, not an account: an admin who can invite four pilots, see
-- who is in, change what they may do, and take them out again without losing
-- the flights they flew. Plus the three emails that make any of it reachable
-- — verify, invite, reset.
--
-- Table classes (§2.2):
--   auth_tokens   platform / control plane — global, keyed to a user
--   outbox        platform — the queue a sender drains; no tenant column
--   (invites, memberships, tenants, users all already exist)
--
-- Two new §2.1 functions, and **no third**. Accepting an invite is
-- deliberately not a door: `auth.resolve_invite_token` already says in its own
-- comment that consuming it "happens afterwards with SET LOCAL app.tenant_id
-- on the tenant_id this returned, under ordinary policy" — and §2.1's own
-- admission test is whether the caller could have set tenant context and
-- simply didn't. Here it can, from the invite it just resolved.
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
-- People have names
-- ===========================================================================

ALTER TABLE public.users
  ADD COLUMN name              text,
  ADD COLUMN phone             text,
  /** NULL until they follow the link. Nothing is gated on it in v1. */
  ADD COLUMN email_verified_at timestamptz;

COMMENT ON COLUMN public.users.email_verified_at IS
  'Set by auth.consume_auth_token. v1 verifies and records; it does not lock '
  'anyone out of an unverified account, because the first thing a new tenant '
  'does is add an aircraft and the second is log a flight.';

-- Settings, per M1: name, timezone, archetype. The first two are editable;
-- archetype already exists and stays descriptive only (§3.1).
ALTER TABLE public.tenants
  ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';

COMMENT ON COLUMN public.tenants.timezone IS
  'An IANA zone. Every timestamp is stored as timestamptz (§6); this is how a '
  'club wants them rendered — a Saturday booking is Saturday at the field, '
  'not in UTC.';

-- ---------------------------------------------------------------------------
-- Who may write a user row
--
-- `tenant_visibility` was FOR ALL: see yourself, or anyone who shares the
-- tenant you are in. That is the right *read*, and the wrong write — it would
-- let a club admin edit a member's global name, phone or password, and the
-- same human is an Admin here and a Pilot at the field next door (§3.1).
--
-- No grant made that reachable, so nothing changes today. It is narrowed now
-- because the profile grants below are the first UPDATE app_role has ever had
-- on this table, and a permissive policy plus a new grant is how a hole opens
-- without anybody editing the policy.
-- ---------------------------------------------------------------------------
DROP POLICY tenant_visibility ON public.users;

CREATE POLICY tenant_visibility ON public.users
  FOR SELECT TO app_role, flightsquare_owner
  USING (deleted_at IS NULL
         AND (id = app.current_user_id()
              OR EXISTS (SELECT 1 FROM public.memberships m
                          WHERE m.user_id = users.id
                            AND m.tenant_id = app.current_tenant_id()
                            AND m.deleted_at IS NULL)));

CREATE POLICY user_self_write ON public.users
  FOR UPDATE TO app_role, flightsquare_owner
  USING      (id = app.current_user_id() AND deleted_at IS NULL)
  WITH CHECK (id = app.current_user_id() AND deleted_at IS NULL);

-- Your own name, your own phone, your own password. Not `email` — changing
-- the address you sign in with is a re-verification flow, and v1 does not
-- have one. Not `status`: that is the control plane's (§7.3).
GRANT UPDATE (name, phone, password_hash, email_verified_at)
  ON public.users TO app_role;

-- §7.2 metadata tier already grants admin_role SELECT on users; the new
-- columns are identity, which is exactly what that tier is for.

-- Settings are a tenant-admin action, gated by `settings: write` at the API.
GRANT UPDATE (name, timezone) ON public.tenants TO app_role;

-- ---------------------------------------------------------------------------
-- How a person who has never used FlightSquare becomes a user
--
-- Accepting an invite has to create a global `users` row, and until now the
-- only way in was `definer_provision` — signup, which also creates a tenant.
-- The obvious move is a third §2.1 door for "register a user". §2.1 says to
-- ask first whether the caller could have set tenant context and simply
-- didn't, and here it can: `auth.resolve_invite_token` hands back the tenant,
-- and its own comment says consuming the invite happens under that context.
--
-- So the rule goes in a policy instead. A user row may be created only while
-- standing in a tenant that has a live, unaccepted invite to that exact
-- address — which is the business rule, written where §1.1 wants it, and
-- checked by the database rather than promised by a route.
-- ---------------------------------------------------------------------------
CREATE POLICY invited_signup ON public.users
  FOR INSERT TO app_role
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.invites i
     WHERE i.tenant_id = app.current_tenant_id()
       AND lower(i.email) = lower(users.email)
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND i.expires_at > now()
       AND i.deleted_at IS NULL));

GRANT INSERT ON public.users TO app_role;

-- ===========================================================================
-- invites — an invitation carries the role it is an invitation to
-- ===========================================================================

ALTER TABLE public.invites
  ADD COLUMN role_bundle_id uuid,
  ADD COLUMN name           text,
  ADD CONSTRAINT invites_role_bundle_fkey
    FOREIGN KEY (tenant_id, role_bundle_id)
    REFERENCES public.role_bundles (tenant_id, id);

COMMENT ON COLUMN public.invites.role_bundle_id IS
  'Chosen when the invite is sent, not when it is accepted. An admin decides '
  'what somebody may do; the person accepting does not get to pick.';

-- Accepting sets accepted_at/accepted_by; revoking sets revoked_at. Both are
-- ordinary tenant-scoped writes under the existing isolation policy.
GRANT UPDATE (accepted_at, accepted_by, revoked_at, role_bundle_id, expires_at)
  ON public.invites TO app_role;

CREATE INDEX invites_tenant_pending_idx
  ON public.invites (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL;

-- ===========================================================================
-- auth_tokens — the single-use secrets that arrive by email
--
-- Global and keyed to a user, like sessions: verifying an address and
-- resetting a password both happen with no tenant in sight, and the second
-- happens with no session at all.
--
-- **app_role holds no grant on this table.** Every path in and out is one of
-- the two §2.1 functions below, which is what makes the door countable: a
-- token cannot be read back, listed, or issued except through them.
-- ===========================================================================

-- The doors below read `users` with no tenant and no session, which is the
-- whole reason they exist. `definer_bootstrap` is how 0003 lets a definer
-- function see that table at all, and it names the levels one at a time on
-- purpose — a policy that trusted any value of app.auth_bootstrap would be
-- trusting a GUC rather than a reviewed list.
ALTER POLICY definer_bootstrap ON public.users
  USING (current_setting('app.auth_bootstrap', true)
         IN ('on', 'provision', 'session', 'token'));

CREATE TABLE public.auth_tokens (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES public.users(id),
  kind       text NOT NULL,
  /** The hash, never the token — a table dump must not be live links. */
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT auth_tokens_kind_check
    CHECK (kind IN ('email_verification', 'password_reset'))
);

CREATE UNIQUE INDEX auth_tokens_hash_key ON public.auth_tokens (token_hash);
CREATE INDEX auth_tokens_user_idx ON public.auth_tokens (user_id, kind);

ALTER TABLE public.auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_tokens FORCE  ROW LEVEL SECURITY;

-- Only the definer functions, and only while they are running.
CREATE POLICY definer_tokens ON public.auth_tokens
  FOR ALL TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'token')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'token');

-- ===========================================================================
-- outbox — what a sender will drain
--
-- No tenant column, because half of what goes in it is addressed to somebody
-- who is not a member yet and the other half to somebody with no tenant in
-- context at all. It is infrastructure, not tenant data.
--
-- **Append-only, and unreadable to the application.** The bodies contain live
-- token links, so an app_role that could SELECT here could read every reset
-- link in flight. It can add to the queue and nothing else.
-- ===========================================================================

CREATE TABLE public.outbox (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  to_email     text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,
  /** What it is, for the digest and retry rules a sender will want. */
  kind         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,

  CONSTRAINT outbox_kind_check CHECK (kind IN (
    'email_verification', 'password_reset', 'invite',
    'booking_confirmed', 'booking_cancelled', 'squawk_filed',
    'maintenance_due', 'over_quota'))
);

CREATE INDEX outbox_unsent_idx ON public.outbox (created_at) WHERE sent_at IS NULL;

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE  ROW LEVEL SECURITY;

CREATE POLICY outbox_append ON public.outbox
  FOR INSERT TO app_role, flightsquare_owner
  WITH CHECK (true);

CREATE POLICY definer_outbox ON public.outbox
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'token');

-- Somebody has to be able to drain it, and FORCE row-level security applies
-- to the owner too — without this the queue is write-only to everyone,
-- including whoever is meant to send from it.
--
-- The owner holds that for now because the sender does not exist yet (M8).
-- When it does it gets a role of its own with exactly this policy and no
-- DDL, and this one goes away: a mail sender has no business owning tables.
CREATE POLICY outbox_drain ON public.outbox
  FOR ALL TO flightsquare_owner
  USING (true) WITH CHECK (true);

GRANT INSERT ON public.outbox TO app_role;

COMMENT ON TABLE public.outbox IS
  'The sender is not built (M8). Until it is, this is the whole of email: '
  'scripts/outbox.sh prints what would have gone out, links and all, which is '
  'enough to walk every flow end to end in development.';

-- ===========================================================================
-- §2.1, entries ten and eleven
--
-- Both pass the admission test the section sets: they run when there is
-- provably no tenant context and, for the reset path, no session either —
-- somebody typing their address into a form because they cannot get in is
-- the definition of unauthenticated.
--
-- Both take scalars matched on equality, pin search_path, are revoked from
-- PUBLIC and granted to app_role alone (§2 rules 1-4).
-- ===========================================================================

/**
 * Issue a token, and enqueue the email that carries it — or do neither.
 *
 * The API renders the subject and body and hands them in already containing
 * the raw link; this function decides whether that email happens, which is
 * the only way the answer to "is this address registered?" never leaves the
 * database. The caller gets `void` back and therefore cannot tell, so its
 * reply is identical either way and the endpoint is not an account oracle.
 *
 * Writes, and so carries §2.1's extra rules: it takes no tenant id and can
 * reach no tenant; it only inserts; and the user it attaches to is derived
 * from the address rather than handed in, so there is no id for a caller to
 * point somewhere else.
 */
CREATE FUNCTION auth.request_email_token(
  p_email      text,
  p_kind       text,
  p_token_hash text,
  p_expires_at timestamptz,
  p_subject    text,
  p_body       text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'token'
AS $$
DECLARE v_user_id uuid;
BEGIN
  SELECT u.id INTO v_user_id
    FROM public.users u
   WHERE lower(u.email) = lower(p_email)
     AND u.status = 'active'
     AND u.deleted_at IS NULL;

  -- No such address. Nothing is written, nothing is sent, and the caller is
  -- told the same thing it would have been told otherwise.
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.auth_tokens (user_id, kind, token_hash, expires_at)
  VALUES (v_user_id, p_kind, p_token_hash, p_expires_at);

  INSERT INTO public.outbox (to_email, subject, body, kind)
  VALUES (p_email, p_subject, p_body, p_kind);
END
$$;

REVOKE ALL ON FUNCTION auth.request_email_token(text, text, text, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.request_email_token(text, text, text, timestamptz, text, text) TO app_role;

/**
 * Spend one, once.
 *
 * Single use is enforced by the UPDATE's own WHERE rather than by a read
 * followed by a write: two tabs racing the same link both run this, and only
 * the one that actually changed a row gets an id back.
 */
CREATE FUNCTION auth.consume_auth_token(p_kind text, p_token_hash text)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'token'
AS $$
DECLARE v_user_id uuid;
BEGIN
  UPDATE public.auth_tokens t
     SET used_at = now()
   WHERE t.token_hash = p_token_hash
     AND t.kind = p_kind
     AND t.used_at IS NULL
     AND t.expires_at > now()
  RETURNING t.user_id INTO v_user_id;

  RETURN v_user_id;
END
$$;

REVOKE ALL ON FUNCTION auth.consume_auth_token(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.consume_auth_token(text, text) TO app_role;

-- ===========================================================================
-- §4.4: "A tenant must always have at least one member holding
-- `members: write` — enforced on removal, on role change, and on downgrade
-- auto-archive."
--
-- In the database, because it has to survive a code path nobody has written
-- yet — the same argument §7.4 makes for legal_hold. The API will check too,
-- so the message is a sentence rather than a constraint violation, but the
-- API is not what makes it true.
--
-- SECURITY INVOKER: it reads rows the caller can already read, under the
-- caller's own context. It refuses something app_role may otherwise do, which
-- is the opposite shape from a §2.3 helper and needs none of its privileges.
-- ===========================================================================

CREATE FUNCTION public.assert_tenant_keeps_an_admin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant    uuid;
  v_remaining integer;
BEGIN
  FOR v_tenant IN SELECT DISTINCT c.tenant_id FROM changed c LOOP
    -- No memberships left at all is a tenant being taken apart, not one
    -- being stranded: there is nobody in it to leave without an admin. That
    -- is the control plane's path (§7.3) and the fixtures', and neither is
    -- what this rule is about.
    IF NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = v_tenant) THEN
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_remaining
      FROM public.memberships m
      JOIN public.role_bundle_permissions p
        ON p.tenant_id = m.tenant_id AND p.role_bundle_id = m.role_bundle_id
     WHERE m.tenant_id = v_tenant
       AND m.status = 'active'
       AND m.deleted_at IS NULL
       AND p.resource = 'members'
       AND p.level = 'write';

    IF v_remaining = 0 THEN
      RAISE EXCEPTION 'a tenant must keep at least one member who can manage members'
        USING ERRCODE = 'FS409',
              HINT = 'Promote somebody else to Admin first.';
    END IF;
  END LOOP;

  RETURN NULL;
END
$$;

-- Per statement, not per row, and this is the whole reason it works.
--
-- A club with an Admin and a Pilot, removed in one DELETE: a row trigger
-- fires after the Admin goes, sees the Pilot still there with nobody able to
-- manage members, and refuses a statement that was about to remove the Pilot
-- too. The end state is what the rule is about, and only a statement trigger
-- can see it.
--
-- Two triggers because PostgreSQL will not attach a transition table to a
-- trigger with more than one event. They share the function, and the
-- transition table is named the same in both so it can.
CREATE TRIGGER memberships_keep_an_admin_update
  AFTER UPDATE ON public.memberships
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION public.assert_tenant_keeps_an_admin();

CREATE TRIGGER memberships_keep_an_admin_delete
  AFTER DELETE ON public.memberships
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION public.assert_tenant_keeps_an_admin();

-- Changing what a membership *is* — its role, or whether it is active — is a
-- tenant-admin action gated by `members: write` at the API. The role bundle
-- column was already granted in 0005.
GRANT UPDATE (status, joined_at) ON public.memberships TO app_role;
