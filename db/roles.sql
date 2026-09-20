-- Database roles. Run once at initdb as the container superuser.
--
-- Production provisions the same three roles with real secrets; nothing about
-- the shape below is dev-only. The attributes matter more than the passwords:
-- NOSUPERUSER and NOBYPASSRLS are the whole point (CLAUDE.md §1.2).

-- ---------------------------------------------------------------------------
-- flightsquare_owner — DDL / migration role.
--
-- Owns the schema and every object in it. Migrations connect as this role.
-- It is deliberately NOT a superuser: FORCE ROW LEVEL SECURITY (0001) closes
-- the owner loophole, so even this role is inside the policies. A migration
-- that needs to touch tenant rows sets tenant context and loops, per §1.1.
-- ---------------------------------------------------------------------------
CREATE ROLE flightsquare_owner
  LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- app_role — the application.
--
-- The only role the API ever connects as. Owns nothing, creates nothing, and
-- reaches unscoped data only through the enumerated auth.* functions in §2.1.
-- No BYPASSRLS: not in production, not in staging, not to debug the seeder.
-- ---------------------------------------------------------------------------
CREATE ROLE app_role
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
CREATE ROLE admin_role
  LOGIN PASSWORD :'admin_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT NOREPLICATION;

-- ---------------------------------------------------------------------------
-- Database and schema ownership.
-- ---------------------------------------------------------------------------
ALTER DATABASE :"db" OWNER TO flightsquare_owner;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO flightsquare_owner, app_role, admin_role;

ALTER SCHEMA public OWNER TO flightsquare_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app_role, admin_role;

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
