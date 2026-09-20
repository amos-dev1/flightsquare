-- ===========================================================================
-- 0001_foundation.sql — platform identity
--
-- Creates the three tables of CLAUDE.md §3.1 (tenants, users, memberships)
-- plus invites, which §2.1's auth.resolve_invite_token requires in order to
-- exist at all. No domain tables.
--
-- Table classes (§2.2):
--   tenants      platform / control plane
--   users        platform / control plane (global identity, §3.1)
--   memberships  tenant-scoped
--   invites      tenant-scoped
--
-- Run as flightsquare_owner.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_setting('server_version_num')::int < 180000 THEN
    RAISE EXCEPTION 'PostgreSQL 18+ required for uuidv7(); found %',
      current_setting('server_version');
  END IF;
  IF current_user <> 'flightsquare_owner' THEN
    RAISE EXCEPTION 'migrations run as flightsquare_owner, not %', current_user;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at honest without trusting every caller.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ===========================================================================
-- tenants
-- ===========================================================================
CREATE TABLE public.tenants (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  slug                text NOT NULL,
  name                text NOT NULL,
  host                text,
  status              text NOT NULL DEFAULT 'trial',
  archetype           text NOT NULL DEFAULT 'solo',
  plan_code           text NOT NULL DEFAULT 'free',
  billing_customer_id text,
  branding            jsonb NOT NULL DEFAULT '{}'::jsonb,
  legal_hold          boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  -- §7.3: define all five up front. Accreting them later as independent
  -- booleans produces the permanent "is it disabled or is_active = false or
  -- closed_at IS NOT NULL" tax.
  CONSTRAINT tenants_status_check
    CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'closed')),
  CONSTRAINT tenants_archetype_check
    CHECK (archetype IN ('solo', 'partnership', 'club')),
  CONSTRAINT tenants_slug_format_check
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

CREATE UNIQUE INDEX tenants_slug_key
  ON public.tenants (slug) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX tenants_host_key
  ON public.tenants (host) WHERE host IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX tenants_billing_customer_id_key
  ON public.tenants (billing_customer_id) WHERE billing_customer_id IS NOT NULL;

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON COLUMN public.tenants.archetype IS
  '§3.1: descriptive label for onboarding copy, provisioning defaults and '
  'reading the control plane at a glance. NEVER read at runtime to decide '
  'behaviour — if (tenant.archetype = ''solo'') is §1.3 in a better disguise. '
  'Behaviour comes from flags, quotas and permissions.';
COMMENT ON COLUMN public.tenants.plan_code IS
  'Becomes a FK to plans(code) when the entitlement tables land (§1.4/§4.3). '
  'Not writable by app_role: a tenant does not upgrade itself by UPDATE.';
COMMENT ON COLUMN public.tenants.legal_hold IS
  '§7.4: when true, hard-blocks every destructive or hiding path — retention '
  'expiry, downgrade auto-archive (§5.4), window-quota hiding (§5.7), purge '
  'and deletion. Checked in the database so it survives code nobody has '
  'written yet.';
COMMENT ON COLUMN public.tenants.deleted_at IS
  '§2''s example filters tenants on status <> ''deleted''. Reconciled here '
  'with §7.3''s five-state lifecycle and §6''s soft-delete convention: '
  '''deleted'' is not a status, deleted_at is the predicate. The auth.* '
  'functions filter on deleted_at IS NULL.';

-- ===========================================================================
-- users — global identity (§3.1). One human, one login, many memberships.
-- ===========================================================================
CREATE TABLE public.users (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         text NOT NULL,
  -- Nullable: a user who only ever signs in with Apple (§8.4) has no password.
  password_hash text,
  mfa_enabled   boolean NOT NULL DEFAULT false,
  mfa_secret    text,
  status        text NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,

  CONSTRAINT users_status_check CHECK (status IN ('active', 'locked', 'closed')),
  CONSTRAINT users_email_format_check CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);

CREATE UNIQUE INDEX users_email_key
  ON public.users (lower(email)) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.users IS
  '§3.1: users are global, memberships are tenant-scoped. A club member '
  'frequently also owns an aircraft of their own and belongs to two clubs at '
  'the field. A user with no memberships is valid.';

-- ===========================================================================
-- memberships — the only thing that grants a user visibility into a tenant.
-- ===========================================================================
CREATE TABLE public.memberships (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL REFERENCES public.tenants(id),
  user_id    uuid NOT NULL REFERENCES public.users(id),
  status     text NOT NULL DEFAULT 'invited',
  invited_at timestamptz,
  joined_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  CONSTRAINT memberships_status_check
    CHECK (status IN ('invited', 'active', 'suspended', 'removed'))
);

-- §6.1 item 4: index leads with tenant_id.
CREATE UNIQUE INDEX memberships_tenant_user_key
  ON public.memberships (tenant_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX memberships_tenant_status_idx
  ON public.memberships (tenant_id, status) WHERE deleted_at IS NULL;
-- Drives auth.list_memberships_for_user, which looks up by user across tenants.
CREATE INDEX memberships_user_idx
  ON public.memberships (user_id) WHERE deleted_at IS NULL;

CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON public.memberships
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMENT ON TABLE public.memberships IS
  '§3.1. The role bundle column (§1.5, §4.4) lands with the role_bundles '
  'table; it is deliberately absent rather than a FK to nothing. Permission '
  'resources are domain vocabulary and this migration has no domain in it.';

-- ===========================================================================
-- invites — required by auth.resolve_invite_token (§2.1).
--
-- Not named in §3.1, but the permitted-function list mandates a single-use
-- invite lookup that runs pre-membership, and that lookup needs a table.
-- ===========================================================================
CREATE TABLE public.invites (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),
  email       text NOT NULL,
  -- The hash, never the token. A leaked table dump must not be a set of live
  -- invite links.
  token_hash  text NOT NULL,
  invited_by  uuid REFERENCES public.users(id),
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid REFERENCES public.users(id),
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,

  CONSTRAINT invites_accepted_consistency_check
    CHECK ((accepted_at IS NULL) = (accepted_by IS NULL))
);

CREATE UNIQUE INDEX invites_token_hash_key ON public.invites (token_hash);
CREATE INDEX invites_tenant_email_idx
  ON public.invites (tenant_id, email) WHERE deleted_at IS NULL;

CREATE TRIGGER invites_set_updated_at BEFORE UPDATE ON public.invites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- Row-level security
--
-- Three policy families, and it is worth being explicit about why there are
-- three rather than one:
--
--   tenant_isolation   app_role and flightsquare_owner. The §1.1 policy:
--                      USING + WITH CHECK, both required. WITH CHECK alone is
--                      what stops a tenant writing a row carrying someone
--                      else's tenant_id. The owner is included because §1.1
--                      says migrations and background jobs set context per
--                      tenant and loop — they do not get a free pass.
--
--   definer_bootstrap  flightsquare_owner, SELECT only, and only while the
--                      app.auth_bootstrap flag is on. FORCE ROW LEVEL
--                      SECURITY applies to the table owner, and the §2
--                      SECURITY DEFINER functions run AS the owner with no
--                      tenant context — so without this they would fail
--                      closed and the bootstrap trap would be unsolved. The
--                      flag is not settable in any useful way from outside:
--                      each function turns it on via its own SET clause for
--                      the duration of the call and Postgres restores it on
--                      exit. app_role can set the GUC all it likes; these
--                      policies are TO flightsquare_owner and app_role is not
--                      a member of that role, so it matches nothing.
--                      (Test 040 asserts exactly that.)
--
--   admin_read         admin_role, SELECT only, §7.2 metadata tier. Writes
--                      are rarer than reads and separately granted; none are
--                      granted yet.
-- ===========================================================================

ALTER TABLE public.tenants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants     FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users       FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.invites     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites     FORCE  ROW LEVEL SECURITY;

-- NULLIF(..., '') guards the cast: current_setting(..., true) returns NULL
-- when the GUC was never set, but '' when it was set to the empty string, and
-- ''::uuid raises rather than matching nothing. Both must mean zero rows.
-- Unset context is zero rows, never all rows.

CREATE POLICY tenant_isolation ON public.tenants
  FOR ALL TO app_role, flightsquare_owner
  USING      (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND deleted_at IS NULL)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY definer_bootstrap ON public.tenants
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'on');

CREATE POLICY admin_read ON public.tenants
  FOR SELECT TO admin_role USING (true);

-- A user is visible inside a tenant when they are a member of it. The EXISTS
-- reads memberships under the reader's own policies, so it cannot be used to
-- probe another tenant's roster.
CREATE POLICY tenant_visibility ON public.users
  FOR ALL TO app_role, flightsquare_owner
  USING (
    deleted_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND m.deleted_at IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.memberships m
       WHERE m.user_id = users.id
         AND m.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
         AND m.deleted_at IS NULL
    )
  );

CREATE POLICY definer_bootstrap ON public.users
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'on');

CREATE POLICY admin_read ON public.users
  FOR SELECT TO admin_role USING (true);

CREATE POLICY tenant_isolation ON public.memberships
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND deleted_at IS NULL)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY definer_bootstrap ON public.memberships
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'on');

CREATE POLICY admin_read ON public.memberships
  FOR SELECT TO admin_role USING (true);

CREATE POLICY tenant_isolation ON public.invites
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
              AND deleted_at IS NULL)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY definer_bootstrap ON public.invites
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'on');

-- No admin_read on invites: it is not in §7.2's metadata list, and the
-- default posture is deny.

-- ===========================================================================
-- Privileges
--
-- Policies decide which rows; grants decide which verbs. Both are load-bearing
-- and neither substitutes for the other.
-- ===========================================================================

-- A tenant may rename itself and change its branding. It may not touch
-- plan_code, status, legal_hold or billing_customer_id — self-service upgrade
-- by UPDATE would make §1.4's entitlement chain a suggestion.
GRANT SELECT                     ON public.tenants     TO app_role;
GRANT UPDATE (name, branding)    ON public.tenants     TO app_role;

-- Read only. Creating a user is a signup/provisioning concern with no tenant
-- context and no §2.1 function covering it yet — see README, open items.
GRANT SELECT                     ON public.users       TO app_role;

-- Invite acceptance and role changes write here. No DELETE anywhere: §6
-- soft-deletes, and see the note on deleted_at below.
GRANT SELECT, INSERT             ON public.memberships TO app_role;
GRANT UPDATE (tenant_id, user_id, status, joined_at)
                                 ON public.memberships TO app_role;
GRANT SELECT, INSERT             ON public.invites     TO app_role;
GRANT UPDATE (accepted_at, accepted_by, revoked_at)
                                 ON public.invites     TO app_role;

-- ---------------------------------------------------------------------------
-- Why deleted_at is absent from every one of those column lists.
--
-- §6 asks for two things that Postgres will not give you together: a
-- `deleted_at IS NULL` predicate in the RLS policy, and an application that
-- soft-deletes its own rows. On UPDATE, Postgres re-checks the NEW row
-- against the policies that apply to SELECT — not only against WITH CHECK —
-- so the moment a row sets deleted_at it stops satisfying the policy that let
-- the updater see it, and the write is refused. This is not a quirk of how
-- the policy is written: it holds for FOR ALL and for FOR UPDATE policies
-- alike, and the only way to permit the write is to stop hiding deleted rows.
--
-- Resolved in favour of the invariant, because the application does not
-- actually need the verb:
--
--   deleted_at is a control-plane lifecycle marker — account closure, purge,
--   §7.3's `closed` state — written by the admin plane, never by a tenant.
--   Rows carrying it are invisible at the database level to everyone reading
--   under tenant context, which is exactly what §6 asks for.
--
--   Removal and archival are domain states, not deletions. A removed member
--   is memberships.status = 'removed'; an archived aircraft will be an
--   aircraft status. §5.5 requires archived records to keep their full
--   history and to come back on re-upgrade, so hiding them at the database
--   level would have been wrong regardless.
--
-- The consequence to carry into every future table: an application-facing
-- "delete" is a status column. deleted_at is not granted to app_role.
-- ---------------------------------------------------------------------------

-- §7.2 metadata tier, read only.
GRANT SELECT ON public.tenants, public.users, public.memberships TO admin_role;
