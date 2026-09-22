-- Database roles. Run at initdb as the container superuser, and re-runnable
-- against an existing database with scripts/roles.sh.
--
-- Production provisions the same five roles with real secrets; nothing about
-- the shape below is dev-only. The attributes matter more than the passwords:
-- NOSUPERUSER and NOBYPASSRLS are the whole point (CLAUDE.md §1.2).
--
-- Every statement here is idempotent, because a role added later has to reach
-- databases that already exist — initdb only ever runs on an empty one. The
-- password lives in an ALTER outside the guard rather than inside it: psql
-- does not substitute :'variables' within a dollar-quoted body, and §6 does
-- not hand setup scripts an exception for building SQL by interpolation.

-- ---------------------------------------------------------------------------
-- flightsquare_owner — DDL / migration role.
--
-- Owns the schema and every object in it. Migrations connect as this role.
-- It is deliberately NOT a superuser: FORCE ROW LEVEL SECURITY (0001) closes
-- the owner loophole, so even this role is inside the policies. A migration
-- that needs to touch tenant rows sets tenant context and loops, per §1.1.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flightsquare_owner') THEN
    CREATE ROLE flightsquare_owner NOLOGIN;
  END IF;
END
$role$;

ALTER ROLE flightsquare_owner
  LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- app_role — the application.
--
-- The only role the API ever connects as. Owns nothing, creates nothing, and
-- reaches unscoped data only through the enumerated auth.* functions in §2.1.
-- No BYPASSRLS: not in production, not in staging, not to debug the seeder.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role NOLOGIN;
  END IF;
END
$role$;

ALTER ROLE app_role
  LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- admin_role — control plane (§7).
--
-- Cross-tenant visibility is granted as per-table POLICY, never as a bypass,
-- so it stays auditable, revocable and greppable. Default posture is deny: a
-- new table grants admin_role nothing until someone writes a policy for it
-- and classifies it under §7.2.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_role') THEN
    CREATE ROLE admin_role NOLOGIN;
  END IF;
END
$role$;

ALTER ROLE admin_role
  LOGIN PASSWORD :'admin_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- mail_role — the sender, and nothing else.
--
-- 0009 left this note against the outbox: "When it does it gets a role of its
-- own with exactly this policy and no DDL, and this one goes away: a mail
-- sender has no business owning tables." This is that role.
--
-- It reads and updates one table. The bodies it reads contain live
-- verification and password-reset links, which is exactly why app_role must
-- not be able to read them and why this role can do nothing else: no tenant
-- data, no users, no sessions. A stolen mail credential can send the queue
-- and read what is in it, which is bad, and cannot touch a single flight,
-- squawk or ledger row, which is the point of it being a separate role.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mail_role') THEN
    CREATE ROLE mail_role NOLOGIN;
  END IF;
END
$role$;

ALTER ROLE mail_role
  LOGIN PASSWORD :'mail_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- scheduler_role — the only role that may ask which tenants exist.
--
-- A background job has no request to inherit context from, so §1.1 has it set
-- context explicitly per tenant and loop. That needs a list, and producing
-- one is cross-tenant by definition — the single thing the rest of this
-- design is built to prevent.
--
-- Rather than borrow a credential that can already do it (the owner, which
-- holds DDL on everything; admin_role, which §7.7 keeps on a separate
-- surface), the capability is named here and made as small as it goes: a
-- policy on `tenants` limited to accounts that are actually running, and a
-- column grant on `id` alone. It cannot read a tenant's name, its plan or a
-- single row belonging to it. Everything past the list is done as app_role
-- under ordinary tenant context.
-- ---------------------------------------------------------------------------
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'scheduler_role') THEN
    CREATE ROLE scheduler_role NOLOGIN;
  END IF;
END
$role$;

ALTER ROLE scheduler_role
  LOGIN PASSWORD :'scheduler_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- Database and schema ownership.
-- ---------------------------------------------------------------------------
ALTER DATABASE :"db" OWNER TO flightsquare_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db"
  TO flightsquare_owner, app_role, admin_role, mail_role, scheduler_role;

ALTER SCHEMA public OWNER TO flightsquare_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_role, admin_role, mail_role, scheduler_role;

-- ---------------------------------------------------------------------------
-- The bootstrap flag (see 0002_auth_functions.sql).
--
-- Each §2 function carries `SET app.auth_bootstrap = 'on'` so that its body —
-- and nothing else — matches the definer_bootstrap policies. Postgres 15+
-- requires an explicit privilege to name a custom parameter in a function's
-- SET clause, even though any role may set one for its own session, so the
-- owner needs this grant before 0002 will install.
--
-- This grant is not what makes the flag safe. The policies keyed on it are
-- TO flightsquare_owner, and app_role is not a member of that role, so
-- app_role setting the flag by hand matches nothing (test 040 asserts it).
-- Holding an owner connection is already enough to disable RLS outright, so
-- the flag adds no capability to a role that has one.
-- ---------------------------------------------------------------------------
GRANT SET ON PARAMETER app.auth_bootstrap TO flightsquare_owner;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Every §2
-- function also revokes it explicitly, but the default is worth turning off
-- at the root so a forgotten REVOKE is not a silently public definer function.
ALTER DEFAULT PRIVILEGES FOR ROLE flightsquare_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE flightsquare_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
