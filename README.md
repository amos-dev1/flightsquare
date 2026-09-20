# FlightSquare

Multi-tenant SaaS for aircraft and flight management (FAA Part 91). See
[CLAUDE.md](CLAUDE.md) for the architecture and domain model — it is the
constitution, and this file only covers how to run what exists.

**Status: foundation, and authentication.**
Three roles, three migrations, and a Fastify + Kysely service where signup
works end to end and every tenant-scoped route fails closed until there is a
session model. No domain tables yet. `web/`, `mobile/` and `infra/` are
deliberately empty workspaces — each has a README saying what it will hold.

## Requirements

Docker, and Node 22 or newer. psql runs inside the container, so there is no
host Postgres to install and no version to match.

PostgreSQL 18 is required, not merely preferred: `uuidv7()` is built in there,
and §6 wants time-sortable keys with no sequence leakage across tenants.
Migration 0001 refuses to run on anything older.

## Commands

The §9 entry points, which is what you should use:

```sh
npm install
npm run db:up             # start Postgres (creates the three roles on first run)
npm run migrate           # apply pending migrations, as the owner role
npm test                  # database suite, then the API suite
npm run dev               # the API on http://127.0.0.1:3000
npm run db:reset          # destroy the database and start clean
```

`npm test` needs the database up and migrated.

They call the scripts in `scripts/`, which can also be run directly and take
arguments:

```sh
./scripts/psql.sh                      # interactive psql as app_role
./scripts/psql.sh flightsquare_owner   # ... or as any other role
```

Local credentials default to the values in `.env.example`; copy it to `.env`
to change them. They are development-only and the container is bound to
loopback.

## Roles

| Role | Used by | Holds |
|---|---|---|
| `flightsquare_owner` | migrations | Owns every object. Not a superuser. Subject to its own RLS policies, because `FORCE ROW LEVEL SECURITY` closes the owner loophole. |
| `app_role` | the application | Owns nothing. Reads unscoped data only through the six `auth.*` functions. |
| `admin_role` | the control plane (§7) | Reads the §7.2 metadata tier. Writes nothing yet. |

None of them has `BYPASSRLS` or superuser, and `scripts/test.sh` asserts it on
every run. §1.2 has no admin exception and no staging exception.

## Layout

```
tsconfig.base.json              compiler options every TS workspace extends
vitest.config.ts                root test runner; projects: api, packages/*
db/                             not an npm workspace — SQL and psql only
  roles.sql                     three roles, run once at initdb
  init/01-create-roles.sh       docker entrypoint hook that runs it
  migrations/
    0001_foundation.sql         tenants, users, memberships, invites + RLS
    0002_auth_functions.sql     the auth schema and the six §2.1 lookups
    0003_session_context_and_provisioning.sql
                                app.user_id, the context accessors, and
                                auth.provision_tenant (§2.1 entry 7)
    0004_sessions_and_audit.sql sessions, refresh tokens, audit log, and
                                §2.1 entries 8 and 9
    0005_entitlements_and_roles.sql
                                plans, quotas, usage counting, role bundles
    0006_fleet.sql              aircraft, meters, and the reference tables
  tests/
    000_fixtures.sql            loaded as superuser (see below)
    010_tenant_isolation_select.sql        §6.1 item 5
    020_cross_tenant_insert_rejected.sql   §6.1 item 6
    030_role_and_policy_shape.sql          role attributes, policy shape, §2
    040_auth_bootstrap.sql                 the lookups, and the door's width
    050_session_context_and_provisioning.sql
                                           user context and signup
    060_sessions.sql                       sessions, rotation, audit log
    070_entitlements_and_roles.sql         quotas, bundles, the §2.3 helpers
    080_fleet.sql                          aircraft, leaseback, meter totals
api/
  src/
    config.ts                   env, client version floors, rate limits
    password.ts                 scrypt from node:crypto, no native build step
    tokens.ts                   session token generation and hashing
    permissions.ts              §1.5's twelve resources and three levels
    entitlements/
      registry.ts               every key, with a global default
      resolver.ts               §1.4's chain: override -> plan -> default
      values.ts                 Unlimited | Limit(n), never a sentinel
    db/
      schema.ts                 Kysely types for the four tables
      pool.ts                   pg pool, Kysely, and the boot-time role check
      context.ts                withSession / withTenant / withUser
      auth.ts                   the nine §2.1 functions, typed
      sessions.ts               creating, rotating and revoking sessions
      entitlements.ts           loading the layers, and the quota gate
    http/
      session.ts                resolveSession — the one place a request
                                becomes a session
      plugins/request-context.ts  binds context to the request
      errors.ts                 the §1.6 gates: 404 / 403 / 402, and 429
      server.ts                 Fastify, error handler, version handshake
      routes/                   health, signup, auth, me, tenant,
                                entitlements, aircraft, reference
  test/                         Vitest, against the real database
packages/shared/                the API contract — types only, no build step
infra/                          AWS CDK. Empty: §9 defers hosting.
web/                            Next.js. Empty.
mobile/                         Expo. Empty.
scripts/
```

Migrations are forward-only. Each one runs once inside a single transaction
and its checksum is recorded; editing an applied migration is an error rather
than a silent no-op.

## How the tests are run, and why it matters

Fixtures load as the container superuser. Every assertion file then runs on a
connection opened **as `app_role`** — not as a superuser with `SET ROLE`, so
what the suite exercises is exactly what the application gets.

Seeding is superuser work on purpose: there is no legitimate in-application
path that writes rows for two different tenants, and that is the property
under test. Building the fixture through the app role would mean weakening the
thing being tested.

The suite was checked against five deliberate mutations, and every file
detected the ones it should: a policy with its `WITH CHECK` removed, a policy
rewritten to `USING (true)`, `BYPASSRLS` granted to `app_role`, the
provisioning insert policy dropped, and `auth.provision_tenant` stripped of
its authenticated-user check.

## Four things worth knowing before writing the next migration

**1. `deleted_at` is a control-plane marker, not an application verb.**

§6 asks for a `deleted_at IS NULL` predicate in the RLS policy *and* for soft
deletion. Postgres will not give you both: on UPDATE it re-checks the new row
against the policies that apply to SELECT, so a row that sets `deleted_at`
stops satisfying the policy that made it visible and the write is refused.
This holds for `FOR ALL` and `FOR UPDATE` policies alike; the only way to
permit the write is to stop hiding deleted rows.

Resolved in favour of the invariant, because the application does not need the
verb. `deleted_at` means account closure and purge (§7.3), written by the
admin plane. Removal and archival are domain states — a removed member is
`status = 'removed'`, an archived aircraft will be an aircraft status. §5.5
requires archived records to keep their history and to return on re-upgrade,
so hiding them at the database level would have been wrong anyway.

**Carry this into every future table: an application-facing "delete" is a
status column.** Raised here rather than worked around silently — if you would
rather have app-writable soft deletes, the cost is that deleted rows stop
being hidden by the policy and the filter moves into a view or the query
layer.

**2. Every transaction sets two GUCs, and policies read them through one pair
of accessors.**

`SET LOCAL app.tenant_id` and `SET LOCAL app.user_id`, both from the
authenticated session, resolved server-side — never from a header, query
parameter, path segment or JSON body. Policies call `app.current_tenant_id()`
and `app.current_user_id()` rather than reading the GUCs by hand; both are
deliberately inlinable (no pinned `search_path`, bodies naming
`pg_catalog.current_setting` explicitly), so an RLS predicate still compiles
down to an index condition rather than a function call per row.

§9 requires the data layer to expose transaction boundaries for exactly this
reason. Both GUCs are set once, at the top of the transaction that does the
work, through a single helper that every request body goes through — nothing
else should call `pool.connect()`. `set_config(key, value, true)` is the
`SET LOCAL` of §1.1; the third argument is what makes transaction pooling
safe.

User context is why `auth.provision_tenant` can refuse to attach an account
other than the session's own, and why §4.4's row scoping will be a policy
rather than a `WHERE` clause someone has to remember.

**3. Gates are declared on the route, not written in the handler.**

```ts
app.post('/aircraft', {
  config: {
    requiresTenant: true,
    feature: 'maintenance_module',
    permission: ['aircraft', 'write'],
  },
}, async (request) => request.withTenant(async (trx) => {
  await assertQuota(trx, 'aircraft.active', entitlements.quota('aircraft.active'));
  // ...
}));
```

A preHandler enforces §1.6's order — feature 404, then permission 403 — so it
cannot be typed in the wrong order, and **boot fails if a tenant-scoped route
declares no permission**. §1.5 has no "authenticated therefore allowed"
default, and a forgotten check fails *open*: the endpoint simply works for
everyone and nothing says so.

The quota stays in the handler because §4.5 needs its row lock inside the
write transaction. That lock is what closes the check-then-insert race that
lets two concurrent requests both slip past a limit of one.

**4. The bootstrap trap is solved with a flag scoped to a function call.**

`FORCE ROW LEVEL SECURITY` subjects the owner to policy, and the §2 functions
run *as* the owner with no tenant context — so without something they would
fail closed and the trap would be unsolved. Each function carries
`SET app.auth_bootstrap = 'on'`, and each affected table has a `SELECT`-only
`definer_bootstrap` policy `TO flightsquare_owner` keyed on that flag.
Postgres scopes a function's `SET` clause to the call and restores it on exit,
including on error, so the opening is exactly as wide as the function body.

The flag is a level, not a switch: `'on'` reads, and `'provision'` also
inserts — set only by `auth.provision_tenant`, so the six lookups cannot write
even by accident. Making it a second value rather than a second parameter
keeps migrations self-sufficient; a new parameter would need a superuser
`GRANT SET ON PARAMETER` in every environment.

`app_role` can set that flag itself, at either level, and gain nothing,
because the policies are `TO flightsquare_owner` and it is not a member of
that role. Test 040 asserts exactly this — if it ever stops holding, the
design is `BYPASSRLS` with extra steps.

This needs `GRANT SET ON PARAMETER app.auth_bootstrap TO flightsquare_owner`
(in `db/roles.sql`): PG 15+ will not let a function pin a custom parameter
without it. Provisioning an environment without that grant fails loudly at
`CREATE FUNCTION`.

## Open items

Five decisions are settled and recorded: four in CLAUDE.md §10 ("Decided") —
provisioning as a seventh `auth.*` function, user identity in the database
session, impersonation deferred with the session seam kept open, and
`deleted_at` as a control-plane marker — and the stack and layout in §9. What
is left:

- **No flights yet.** `flights`, `flight_meters` and `flight_fuel` are next,
  and with them the post-flight entry screen §3.4 says to optimise over
  everything else. The meter log they write into already exists.
- **`aircraft_documents` is absent** (§3.2). It is a table of pointers into
  object storage, and there is no object storage; it arrives with
  `attachments`.
- **The aerodrome and type tables are seeded thinly.** Twenty fields and
  thirty-four types, enough to fly on. The real lists are an import job
  (§2.2), not a migration anyone has to read.
- **Row scoping is still open** (CLAUDE.md §10, decision 3). A Pilot's
  `charges: read` currently means every charge in the tenant, which is wrong
  in a club. It has to be settled before the ledger is built — not before, and
  not after.
- **MFA is reported but not enforced.** `login` returns `mfa_required` from
  the user row; nothing acts on it yet.
- **Nothing writes to `audit_log`.** §5.9 wants every plan change recorded
  there with before/after resolved entitlements, which arrives with plan
  changes rather than with the plans themselves.
- **§5's downgrade machinery does not exist.** `over_quota`, the 14-day
  remediation window and the deterministic auto-archive are a later phase; the
  schema does not foreclose them.
- **`packages/shared` has no build step.** It is consumed only with
  `import type`, which erases, so nothing resolves it at runtime. A *value*
  import from it would compile and then fail at runtime. The moment it needs
  runtime values it gains a `tsc` build, and the root `build` script gains
  explicit ordering — `npm run build --workspaces` builds alphabetically,
  which puts `api` before `packages/shared`.
- **`web/`, `mobile/` and `infra/` are empty.** Their READMEs record what each
  already owes the design; `mobile/` in particular notes that Expo under npm
  workspaces needs Metro configured before it will resolve anything.
