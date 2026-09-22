# FlightSquare

Multi-tenant SaaS for aircraft and flight management (FAA Part 91). See
[CLAUDE.md](CLAUDE.md) for the architecture and domain model — it is the
constitution, and this file only covers how to run what exists.

**Status: the core loop closes.**
Eight migrations, three database roles, and a Fastify + Kysely service
carrying the domain model through flight logging, maintenance and squawks — a
flight advances the meters, the meters tick the intervals down, and an overdue
inspection or a grounding squawk reaches `aircraft_availability`, which is
what the scheduler will ask before it exists. Both clients are built: a
Next.js app on 3001 and an Expo app for iOS. `infra/` is still an empty
workspace with a README saying what it will hold, and §9 defers hosting until
there is something worth deploying.

Two honest gaps: **neither client has a signup screen** (§9 says the web app
will own it), so the first account comes from `./scripts/seed-demo.sh` below;
and **the Expo app has never run on a device** — it bundles and typechecks,
but treat its screens as unverified until someone opens the Simulator.

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
npm run seed              # create an account to sign in with
npm run dev:web           # the web app on http://127.0.0.1:3001
npm run dev:mobile        # the iOS app, in the Simulator
npm run db:reset          # destroy the database and start clean
```

Both clients call the API, so `npm run dev` stays running in its own terminal.

`npm run seed` exists because there is no signup screen yet: it is one call to
the API, and re-running it is not an error.

```sh
npm run seed                                 # demo@flightsquare.local
./scripts/seed-demo.sh me@example.test my-club
```

It does only what the UI cannot. Add the aircraft through the web app — its
standard maintenance intervals arrive with it — and the rest of the screens
have something to show from there. What it calls, if you would rather do it
by hand:

```sh
curl -s -X POST localhost:3000/auth/signup -H 'content-type: application/json' \
  -d '{"slug":"my-club","name":"My Club","email":"me@example.test",
       "password":"correct horse battery staple","archetype":"solo"}'
```

`archetype` matters more than it looks: it gives the user exactly one
membership, and the mobile sign-in screen has no tenant picker — it refuses
anyone who belongs to more than one organisation and says to choose on the
web.

`npm test` needs the database up and migrated.

They call the scripts in `scripts/`, which can also be run directly and take
arguments:

```sh
./scripts/psql.sh                      # interactive psql as app_role
./scripts/psql.sh flightsquare_owner   # ... or as any other role
./scripts/outbox.sh                    # what is queued, and what went
./scripts/roles.sh                     # after pulling a change that adds a role
```

**Email.** `npm run mail -w api` starts the sender, and `npm run sweep -w api
-- --once` runs the maintenance digest a single time (without `--once` it
runs daily). With no API key it logs
each message and marks it delivered — a real pass through the worker rather
than a skipped one — and `./scripts/outbox.sh` is where a verification or
reset link is actually read. It runs as `mail_role`, which can read and drain
one table and reach nothing else in the database; `app_role` still cannot read
the queue at all, because the bodies carry live single-use links.

The sweep is the only thing in the product that asks which tenants exist.
That is cross-tenant by definition, so it is a role of its own rather than a
borrowed credential: `scheduler_role` can read `tenants.id`, filtered by
policy to accounts that are actually running, and can read nothing else at
all. Everything after the list is done as `app_role` under ordinary tenant
context, which is what §1.1 asks a background job to do.

`scripts/roles.sh` exists because roles are created at initdb and initdb only
runs on an empty data directory — so a database from before M8 has neither
`mail_role` nor `scheduler_role` until it is run once. The migrations say so
by name rather than failing on a role that does not exist.

Local credentials default to the values in `.env.example`; copy it to `.env`
to change them. They are development-only and the container is bound to
loopback.

## Running the iOS app

`npm run dev:mobile` starts Metro and opens the Simulator. Once, before the
first run, point the toolchain at Xcode itself — a machine with only the
Command Line Tools installed has no `simctl`, so Expo has nothing to open:

```sh
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -license accept
xcodebuild -runFirstLaunch
xcrun simctl list devices available | grep iPhone   # must print something
```

If that last line prints nothing the toolchain is fine and the runtime is
missing: `xcodebuild -downloadPlatform iOS`.

**On the Simulator, no configuration is needed.** It shares the Mac's
loopback, so the app's default of `http://127.0.0.1:3000` reaches the API.

**On a physical device, two things change**, because `127.0.0.1` there is the
phone itself and the API binds loopback:

```sh
FS_API_HOST=0.0.0.0 npm run dev                          # reachable on the LAN
EXPO_PUBLIC_API_URL=http://192.168.1.x:3000 npm run dev:mobile
```

Anything installed into `mobile/` goes through `npx expo install`, never plain
`npm install` — see `mobile/README.md` for what breaks otherwise, and for why
the offline queue is the part of that workspace worth reading.

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
    0007_flights.sql            flights, fuel, and idempotent writes
    0008_maintenance.sql        items, squawks, work orders, compliance, and
                                the aircraft_availability view (§3.3)
    0009_identity.sql           invites, profiles, tokens and the outbox
    0010_permission_scope.sql   §4.4's third dimension: resource, level, scope
    0011_aircraft_config.sql    billing meter, wet/dry, rate, fuel, grounded
    0012_scheduling.sql         reservations, resource lines, blackouts, and
                                the exclusion constraint (§3.3)
    0013_member_billing.sql     effective-dated rates, charges that snapshot
                                them, fuel credits and adjustments (§3.7)
    0014_route_is_free_text.sql departure and arrival stop being keys into a
                                twenty-row reference table
    0015_platform_billing.sql   subscriptions, webhook idempotency, and the
                                two helpers that hold the plan change
    0016_outbox_drain.sql       the queue gets a sender, and the owner steps
                                back from it
    0017_scheduled_sweep.sql    the one role that may ask which tenants exist,
                                and the column that stops a digest repeating
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
    090_flights.sql                        the core loop, fuel, the gap flag
    100_maintenance.sql                    calendar months, grounding, and
                                           the append-only records
    110_identity.sql                       the token doors, and the one
                                           member a tenant cannot lose
    120_permission_scope.sql               own rows versus all of them
    130_scheduling.sql                     the race that cannot be lost, and
                                           who may book what
    140_member_billing.sql                 February keeps February's price
    150_platform_billing.sql               the plan change the app cannot make
api/
  src/
    config.ts                   env, client version floors, rate limits
    password.ts                 scrypt from node:crypto, no native build step
    tokens.ts                   session token generation and hashing
    permissions.ts              §1.5's twelve resources and three levels
    billing/                    the provider behind one interface: Stripe when
                                a key is set, a signing stub when not
    mail/                       the sender: its own role, its own process, and
                                who gets told about what
    scheduler/                  the sweep: §1.1's per-tenant loop, for the one
                                notice with no event behind it
    email.ts                    every message, rendered as plain text
    entitlements/
      registry.ts               every key, with a global default
      resolver.ts               §1.4's chain: override -> plan -> default
      values.ts                 Unlimited | Limit(n), never a sentinel
    db/
      schema.ts                 Kysely types for every table and both views
      pool.ts                   pg pool, Kysely, and the boot-time role check
      context.ts                withSession / withTenant / withUser
      auth.ts                   the eleven §2.1 functions, typed
      sessions.ts               creating, rotating and revoking sessions
      idempotency.ts            §8.2's replay-safe writes
      entitlements.ts           loading the layers, and the quota gate
    http/
      session.ts                resolveSession — the one place a request
                                becomes a session
      plugins/request-context.ts  binds context to the request
      errors.ts                 the §1.6 gates: 404 / 403 / 402, and 429
      server.ts                 Fastify, error handler, version handshake
      routes/                   health, signup, auth, account, me, tenant,
                                entitlements, members, aircraft, flights,
                                maintenance, squawks, scheduling, billing,
                                subscription, billing-webhook, reference
  test/                         Vitest, against the real database
packages/shared/                the API contract — types only, no build step
infra/                          AWS CDK. Empty: §9 defers hosting.
web/
  src/
    middleware.ts               rotates the access token before a render needs it
    lib/                        httpOnly session cookie, server-side API client
    lib/time.ts                 wall-clock time in the club's zone
    components/ui.tsx           copy-in components, owned outright
    app/                        signup, login, invitations, fleet, aircraft
                                detail, schedule, maintenance, squawks,
                                members, billing, settings
mobile/
  src/
    lib/queue.ts                expo-sqlite behind the shared QueueStore
    lib/sync.ts                 save-locally-first, flush when there is signal
    app/                        sign in, fleet, post-flight entry, squawk
scripts/
  lib.sh                        sourced by the rest; loads .env, finds docker
  roles.sh                      db/roles.sql against a database that exists
  migrate.sh                    forward-only, checksummed
  test.sh                       fixtures as superuser, assertions as app_role
  psql.sh                       interactive psql as any role
  outbox.sh                     what is queued, and what the sender did with it
  seed-demo.sh                  an account to sign in with, until signup exists
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

- **The Expo app has run in the Simulator, and on nothing else.** It boots,
  renders and signs in there; no physical device has seen it, and the offline
  queue has not been exercised against a real dropped connection.
- **Large parts of the web app are not built, rather than broken.** What
  exists is sign-up and sign-in, the roster and invitations, settings and
  profile, the fleet, an aircraft, the post-flight entry, maintenance,
  squawks, the calendar, member billing and the subscription. What does not,
  in rough order of how much it is missed:

  | Missing | Where it would go |
  |---|---|
  | Flight list and history | `GET /flights` has no caller at all; flights are write-only from the UI, and `?needs_review=true` has no screen |
  | Work orders | list, create and signoff — the API and its guard trigger are done |
  | Add or edit a maintenance item by hand | only seeding the whole library is wired, and only when an aircraft has none |
  | Compliance history | records can be written and never read back |
  | Meter correction | the API takes `supersedes_id`, so the "Corrected" badge can never appear from the web |
  | Switching organisation after sign-in | the picker is only shown at login |

  These are honest gaps, not bugs. The web app tells the truth about what it
  can do; it just cannot do much yet.
- **A seeded maintenance item is due *now*, and says it has no record.**
  Adding an aircraft tells the system nothing about when its last annual was,
  so dating one twelve months out would assert the aircraft is in annual —
  which §11 forbids in as many words. The consequence is a deliberate one
  day of grace: a seeded item reads as due today and goes overdue tomorrow,
  and a grounding one takes the aircraft out of service until somebody
  records the real date. `ever_complied` is what lets every screen say "not
  recorded" rather than "overdue".
- **Work orders have no UI.** The table, the signoff and the trigger that
  closes a signed record to edits are all there and tested; nothing in
  `web/` or `mobile/` writes one yet. It arrives with the screen that needs
  it, which is probably a shop-visit flow rather than a form of its own.
- **Nothing consumes `aircraft_availability` but the two clients.** It exists
  before the scheduler does on purpose (§3.3): retrofitting the signal means
  finding every booking path later. §6.2's checklist already says booking
  paths consult the view rather than querying squawks.
- **The preset library is thin, like the other reference tables.** Ten
  entries, enough for a piston single. Anything type-specific — a Cirrus
  parachute repack, a Mooney gear inspection — is a row someone adds.
- **`web/` still has its own API client.** §9 says both clients share the one
  in `packages/shared`; mobile uses it, web predates it and duplicates a
  little of it. Worth collapsing next time web's data layer is touched.
- **`exports.per_month` is declared but not enforced.** Flow quotas need
  period-aware counting, and `tenant_usage` is a plain counter. §4.2 already
  says the mechanism exists and nothing important uses it.
- **`aircraft_documents` is absent** (§3.2). It is a table of pointers into
  object storage, and there is no object storage; it arrives with
  `attachments`.
- **The aerodrome and type tables are seeded thinly, and only one of them
  refuses anything.** Twenty fields and thirty-four types; the real lists are
  an import job (§2.2), not a migration anyone has to read. `home_base` is
  free text as of 0011 — a foreign key against twenty of some twenty thousand
  airfields refuses almost every true answer — while `type_code` keeps its
  key, because `engine_type` on the other side of it decides which
  maintenance presets an aircraft is seeded with. Both are suggested from the
  tables; only one is checked against them.
- **`member_credentials` and `member_aircraft_authorizations` are not built**
  (§3.5). The authorization table gates booking and arrives with the
  scheduler; the credentials table is open decision 3 and should be settled
  rather than assumed.
- **The calendar is a list, not a time grid.** Per aircraft there can be no
  overlaps at all — the exclusion constraint forbids them — so an ordered
  list of a day's bookings is complete information rather than a
  simplification. A grid would spend a lot of CSS saying the same thing, and
  say it worse on a phone at a tiedown. Worth revisiting if a tenant ever has
  enough aircraft for a fleet-wide day view to feel crowded.
- **Times are wall-clock in the tenant's zone, converted in `web/src/lib/time.ts`.**
  No library: two `Intl` round-trips, applied twice so a booking either side
  of a daylight-saving change lands on the hour somebody meant. The API only
  ever sees instants.
- **An admin settings hub is wanted, and is not built.** The idea: one
  `/settings` for admins, branching into aircraft settings, maintenance
  setup, members and permissions, invite and suspend, and subscription.
  Today those live where the thing lives — per-aircraft settings on the
  aircraft, members at `/members`, tenant settings at `/settings` — and that
  is not an accident worth undoing lightly:

  - Per-aircraft settings are most findable on the aircraft. A hub makes them
    two navigations away from the page that shows the aeroplane they belong
    to, and a club with three aircraft then picks from a list twice.
  - Members is a daily screen for a club of five, not a setting. Filing it
    under settings makes the most-used admin page the most buried one.
  - Subscription genuinely belongs in a hub, and now exists: it sits at
    `/settings/subscription`, linked from a card on the settings page. That
    is the first piece of the hub, arrived at by the route the argument
    below predicted.

  The version worth building is probably a hub that **links** rather than
  absorbs: one page an admin can start from, pointing at the screens where
  the things already are, plus subscription and maintenance-preset setup
  which have nowhere else to be. That keeps one place to look without making
  anything harder to reach. There are two things in it now — the club's own
  settings and the subscription — and maintenance-preset setup would be the
  third that settles it.
- **MFA is reported but not enforced.** `login` returns `mfa_required` from
  the user row; nothing acts on it yet.
- **A plan change is the only thing that writes `audit_log`.** §5.9 wants
  before/after *resolved entitlements* rather than a plan code, and that is
  what the webhook records. Nothing else writes there yet.
- **§5's downgrade machinery is partly deliberate absence.** `over_quota` is
  computed rather than stored — it is `tenant_usage` against the resolved
  limit, which both sides already know, and a state column would be a third
  place to get it wrong. The 14-day remediation window and the deterministic
  auto-archive are out of v1 by V1_SCOPE's own decision: creates are blocked
  and the club decides what to move, for as long as it takes. A downgrade to
  Free is the provider's "cancel at period end", so §5.1 needs no timer of
  ours and no subscription schedules.
- **`packages/shared` has no build step.** It is consumed only with
  `import type`, which erases, so nothing resolves it at runtime. A *value*
  import from it would compile and then fail at runtime. The moment it needs
  runtime values it gains a `tsc` build, and the root `build` script gains
  explicit ordering — `npm run build --workspaces` builds alphabetically,
  which puts `api` before `packages/shared`.
- **`web/`, `mobile/` and `infra/` are empty.** Their READMEs record what each
  already owes the design; `mobile/` in particular notes that Expo under npm
  workspaces needs Metro configured before it will resolve anything.
