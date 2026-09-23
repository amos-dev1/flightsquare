# FlightSquare

Multi-tenant SaaS for aircraft and flight management, scoped to **FAA Part 91 general aviation**. Organizations register, invite their own members, and manage their own aircraft: scheduling, maintenance tracking, and flight logging. Subscription tiers run free → enterprise.

**Current target tenants: single-aircraft owners and small flying clubs.** Flight schools are a deliberate later phase — they bring training records, endorsements, instructor scheduling, and student-privacy obligations that would distort the model if designed for now. Where a decision is cheap today and expensive to retrofit, the file notes the school case and leaves room; where it is not, it ignores schools entirely. Charter, Part 135, and passenger-carrying operations are out of scope, full stop.

**Build the club model; every smaller shape is a degenerate case of it.** A tenant is some pilots sharing some aircraft. A club is many-to-many, a partnership is a few-to-one, a solo owner is one-to-one. The same schema serves all three, and the smaller cases simply have fewer rows.

**Scheduling need tracks pilot count, not ownership.** A single owner who shares their aircraft with a partner and two friends has a real scheduling problem — arguably a sharper one than a club, because there is no dispatcher and no norms, just four people and a calendar. A solo owner flying alone needs no scheduling at all; they need maintenance tracking and a logbook. Do not infer scheduling need from aircraft count or from who holds title.

The consequence for implementation: scheduling is **unused**, never **unavailable**, in the solo case. No separate code path, no "scheduling off" mode. One pilot means the reservations table is empty and the UI doesn't lead with it. The moment a second pilot is invited, the feature is already there and already correct.

This file is the architectural constitution. The invariants below are not style preferences — violating one is a security or correctness bug, not a code-review nit. When a task appears to require breaking one, stop and raise it instead of working around it.

---

## 1. Architectural invariants

### 1.1 Tenancy lives in Postgres, not in application code

Isolation is enforced by row-level security. Application code is not the thing standing between tenant A and tenant B's data; the database is. Application code that filters by tenant is defence in depth at best and a false sense of security at worst.

Every tenant-scoped table:

```sql
ALTER TABLE aircraft ENABLE ROW LEVEL SECURITY;
ALTER TABLE aircraft FORCE ROW LEVEL SECURITY;   -- applies to the table owner too

CREATE POLICY tenant_isolation ON aircraft
  USING      (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
```

Rules that follow from this:

- `USING` alone is not enough. Without `WITH CHECK`, a tenant can *insert* or *update* a row carrying someone else's `tenant_id`. Every policy gets both.
- `current_setting('app.tenant_id', true)` returns NULL when unset, the comparison is NULL, and no rows match. **Unset context means zero rows, never all rows.** That is the desired failure mode.
- Tenant context is set with `SET LOCAL` inside the transaction, never plain `SET`. Under transaction-level connection pooling, plain `SET` leaks one tenant's context onto the next request that borrows the connection.
- The tenant id comes from the authenticated session, resolved server-side. It never comes from a request header, query parameter, path segment, or JSON body, even "just for admin tooling."
- `tenant_id uuid NOT NULL REFERENCES tenants(id)` on every tenant-scoped table. No nullable tenant ids, no implicit "shared" rows in a tenant-scoped table.
- Background jobs, schedulers, and data migrations have no request to inherit context from. They set context explicitly per tenant and loop. They do not run unscoped.

### 1.2 Never grant the application role BYPASSRLS

Not in production, not in staging, not "temporarily to debug the seeder." `BYPASSRLS` silently disables isolation everywhere at once, and nothing in the test suite will notice — every query keeps returning rows, just more of them than it should.

The application role is also not a superuser and does not own the tables. Table ownership sits with a separate migration/DDL role. `FORCE ROW LEVEL SECURITY` closes the owner loophole for the cases where these overlap.

Where genuinely unscoped access is required, use §2 (SECURITY DEFINER functions) — a small, enumerable, reviewable list — rather than a blanket capability.

### 1.3 Never branch on tenant identity

No code path anywhere may ask *which* tenant this is in order to decide what to do.

Forbidden, in application code, SQL, templates, tests, and infrastructure:

```ts
if (tenantId === '…')            // no
if (tenant.slug === 'acme-air')  // no
switch (tenant.name) { … }       // no
tenantOverrides[tenantId]?.foo   // no
```

Anything that varies between tenants is one of exactly three things:

1. a **feature flag** (boolean capability),
2. a **quota** (numeric limit),
3. a **configuration value** (branding, locale, default units, retention window).

All three are data, resolved through the same chain, stored in the same place, and readable by support without a deploy. If a requirement seems to need a fourth kind, that is a design conversation, not a conditional.

This applies to tests. A test fixture may not be special-cased by tenant identity either — if a test needs different behaviour, it sets a different flag or quota.

### 1.4 Entitlements resolve in one order, always

```
tenant override → plan → global default
```

First layer that has a value for the key wins. Same chain for flags, quotas, and config. There is no fourth layer and no per-call override argument.

- Every key is declared in a registry with a global default, so resolution is **total** — it cannot fail or return "unknown."
- An undeclared key is a startup error, not a runtime `false`. Boot fails loudly rather than silently disabling a feature in production.
- The resolver is pure and side-effect free: `(tenant, key) → value`. It does not consult the request, the user, or the clock.
- Resolution results are cached per request, invalidated on plan change or override write.

### 1.5 Permissions are resource + level, enforced server-side

A permission is a pair: a **resource** and a **level** from `none | read | write`. Levels are ordered — `write` implies `read`, `read` implies `none`.

Resources for this domain:

```
aircraft       reservations   flights      squawks    maintenance
rates          charges        qualifications
documents      members        subscription settings
```

Two distinctions that are easy to lose and expensive to recover:

- `squawks` is separate from `maintenance`. A pilot reports a defect but does not sign off work, close an item, or record compliance — `squawks: write` with `maintenance: read`. Collapsing them makes the central permission line in the product inexpressible.
- `subscription` (what the tenant pays FlightSquare) is separate from `rates` and `charges` (what pilots pay their club). See §3.7.

- **Roles are bundles of pairs, not code.** "Dispatcher," "Chief Pilot," "Maintenance Controller," "Owner," "Read-only Auditor" are named sets of (resource, level) rows. Adding a role is a data change. Nothing branches on a role name.
- Enforcement is server-side at the API boundary. The client's job is to hide buttons; it is not a control.
- Checks are explicit per endpoint. There is no "authenticated therefore allowed" default and no route that inherits its check from a parent router by accident.
- Permission grants are per (user, tenant) via membership — see §3 on why a user can belong to several tenants.

### 1.6 Gate responses: 404, 403, 402

Three distinct failures, three distinct codes, checked in this order:

| Gate | Question | Response |
|---|---|---|
| **Feature** | Is this capability in the tenant's entitlements? | **404** |
| **Permission** | Does this user hold the required level on the resource? | **403** |
| **Quota** | Is the tenant under its numeric limit? | **402** |

Order matters. Feature first, so a tenant without the maintenance module cannot tell from status codes whether the module exists, whether they'd be allowed to use it, or how close to a limit they are. A gated capability is indistinguishable from a nonexistent one.

Refinements:

- 404 applies to resources and routes whose *existence* is gated. If a gated feature is a **field** on an otherwise-visible resource, omit the field — do not 404 the whole resource.
- 402 bodies are machine-readable so the UI can offer the right remediation:
  ```json
  { "error": "quota_exceeded", "quota": "aircraft.active",
    "limit": 3, "current": 3, "remediation": ["upgrade", "archive"] }
  ```
- **429** is reserved for rate limiting (requests per unit time). It is not a plan quota. Do not conflate them.
- Never return 402 or 403 where 404 is required in the table above just because the message would be friendlier. Upsell copy lives in the UI, reached through entitlement data the client already has — not through error codes.

---

## 2. The bootstrap trap — read before touching auth

**The problem.** With RLS enabled on `tenants`, the application cannot look up a tenant at the start of a request, because looking up the tenant *is* how it obtains the tenant context the policy requires. The policy fails closed, correctly, and the request dies before it begins. This bit us in the TMS. It will bite here.

**The wrong fixes.** Granting `BYPASSRLS` (§1.2). Leaving `tenants` without RLS. Adding a policy so permissive it's decorative. All of these trade a narrow problem for a system-wide hole.

**The fix.** A small, closed set of `SECURITY DEFINER` functions for the handful of lookups that legitimately run with no tenant context.

```sql
CREATE FUNCTION auth.resolve_tenant_by_host(p_host text)
RETURNS TABLE (tenant_id uuid, status text, plan_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT id, status, plan_code
  FROM public.tenants
  WHERE host = p_host AND status <> 'deleted'
$$;

REVOKE ALL ON FUNCTION auth.resolve_tenant_by_host(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.resolve_tenant_by_host(text) TO app_role;
```

**Rules for every SECURITY DEFINER function, without exception:**

1. `SET search_path` is pinned explicitly. An unpinned search_path on a definer function is a privilege-escalation vector.
2. `REVOKE ALL … FROM PUBLIC`, then `GRANT EXECUTE` to the application role only.
3. Arguments are scalars matched on equality. No `LIKE`, no arrays, no arbitrary predicates, no `ORDER BY` or `LIMIT` passed in by the caller — those turn a lookup into an enumeration oracle.
4. Returns the minimum columns needed, never `SELECT *`, never a row set spanning tenants.
5. Every function lives in the `auth` schema and is listed in §2.1. Adding one is an architectural decision requiring review; it is not routine.

### 2.1 The permitted list

Each entry provably cannot have tenant context yet. Six are lookups, and five more arrived with sessions and email tokens; `db/tests/030` asserts the list is exactly these eleven.

| Function | Runs when | Returns |
|---|---|---|
| `auth.resolve_tenant_by_host` | Request routing, before session | tenant id, status, plan |
| `auth.resolve_tenant_by_slug` | Login page, invite acceptance | tenant id, status, branding |
| `auth.find_user_by_email` | Credential check | user id, hash, MFA state |
| `auth.list_memberships_for_user` | Post-auth tenant picker | (tenant id, name) for that user only |
| `auth.resolve_invite_token` | Invite acceptance, pre-membership | invite row, single-use |
| `auth.tenant_for_billing_customer` | Billing-provider webhooks | tenant id |
| `auth.provision_tenant` | Signup — the tenant does not exist yet | new tenant, user and membership ids |
| `auth.resolve_session_token` | Every request, before context exists | session, user, selected tenant |
| `auth.consume_refresh_token` | Token rotation | the rotated session |
| `auth.request_email_token` | Verification and password reset | the queued message |
| `auth.consume_auth_token` | Accepting either | the token's subject, single-use |

If a task seems to need a twelfth, the first question is whether the caller could have set tenant context and simply didn't. Platform billing is the worked example of the answer being yes: a provider's webhook looks like it needs a door, and does not — it resolves its tenant through `tenant_for_billing_customer` and then runs in ordinary tenant context like everything else.

**Extra rules for a definer function that writes.** The rules above were written for lookups, and rule 3 in particular — scalar arguments matched on equality — is about not turning a lookup into an enumeration oracle. A write function's arguments are values to store rather than predicates, so it carries four of its own instead:

1. **It takes no `tenant_id`.** It can only ever create a new tenant, never reach into an existing one. This is what keeps a write door as narrow as a read one, and it is asserted from the catalog rather than by reading the body.
2. **It inserts, and never updates or deletes.** Nothing that already exists changes.
3. **Any user id it is handed must equal `app.current_user_id()`.** Otherwise anyone could create a tenant and drop a stranger's account into it as Admin. Checked in the database, not promised by the API.
4. **It is the only `VOLATILE` function in the schema.** That makes "did anything else in here learn to write?" a one-line catalog query, and a read function that quietly becomes volatile is a review failure rather than a mystery.

Abuse is the API's problem, not the policy's: nothing stops `app_role` calling it in a loop, so signup is rate limited at the boundary (429 — and §1.6 is explicit that 429 is not a quota).

### 2.2 Table classes

Three classes, three different rules. Classify every new table when you create it.

- **Tenant-scoped** — `tenant_id` column, RLS enabled and forced, isolation policy with `USING` + `WITH CHECK`. The default; assume a new table is this unless argued otherwise.
- **Global reference** — shared, read-only to the application, no `tenant_id`, no RLS. Aerodromes, ICAO aircraft type designators, countries, timezones, currencies. Written only by migrations and reference-data import jobs. Never contains customer data.
- **Platform / control plane** — `tenants`, `plans`, `plan_entitlements`, `tenant_entitlement_overrides`, `subscriptions`, `users`, billing events. Reached via §2 functions or with tenant context where it applies. Never joined casually into tenant queries.

### 2.3 Privileged helpers — the second kind of definer function

§2.1 is the bootstrap door: functions that run with **no** tenant context, because obtaining the context is what they are for. There is a second, opposite category, and it needs naming rather than smuggling in under §2.1's rules.

A **privileged helper** runs only **with** tenant context. It exists because the application role must not hold a privilege directly — the case that forces it is §4.5's quota counter: `SELECT … FOR UPDATE` requires `UPDATE` privilege, and an application role that can update its own usage counters can set one to zero and walk past every quota.

Rules, which are stricter than §2.1's in the way that matters:

1. **It requires tenant context and fails closed without it.** No context is an exception, never a permissive default. This is the inverse of a §2.1 function and is what makes the category safe.
2. **It derives the tenant from `app.current_tenant_id()`, never from an argument.** A helper that takes a `tenant_id` can be aimed at another tenant, which makes it a bypass wearing a different hat. This rule is absolute.
3. **It exists only to hold a privilege the application role must not have.** Convenience is not a justification; if `app_role` could do the work under its own grants, it does.
4. `SET search_path` pinned, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE` to the application role only. Trigger functions get no grant at all — nothing can call them directly, which is why they are doors that do not open.
5. **It lives in `public` and is listed below.** Adding one is an architectural decision requiring review, exactly as in §2.1.

| Function | Holds the privilege to | Tenant from |
|---|---|---|
| `public.assert_quota` | lock and read a `tenant_usage` row the app may only read | `app.current_tenant_id()` |
| `public.refresh_*_usage` | write `tenant_usage` (triggers; not callable) | the row being changed |
| `public.refresh_aircraft_meter_totals` | write the derived totals on `aircraft` (trigger; not callable) | the row being changed |
| `public.set_billing_customer` | write `tenants.billing_customer_id`, once, from NULL | `app.current_tenant_id()` |
| `public.apply_subscription` | write `tenants.plan_code` and the `subscriptions` row | `app.current_tenant_id()` |

`refresh_*_usage` is a **family**, one per counted table, and a new member is an instance of a decision already taken rather than a new one: each recomputes exactly one quota key from exactly one table and is reachable only as a trigger. A helper of a genuinely new *shape* still needs review.

Before adding one, answer this in the code: could the application role simply be granted what it needs without also being able to abuse it? Two worked answers, because they differ:

- **Usage counters — no.** A role that can write its own counters can set one to zero and walk past every quota.
- **The plan — no, and this is the sharpest case.** `plan_code` is the left-hand layer of §1.4's chain, so a role that can write it resolves itself onto every flag and every quota in the registry, while `assert_quota` goes on faithfully enforcing a limit the caller has just rewritten. The same argument covers `billing_customer_id`, which is the only thing that tells a webhook whose event it is: a role that can write it can point at another tenant's customer and inherit what they pay for.
- **Derived meter totals — no, for a different reason.** The totals come from an append-only log precisely so the maintenance numbers downstream have an audit trail (§3.4). If the application could write them directly, the derivation would be a suggestion and the trail optional. Granting `UPDATE` there is not a convenience; it deletes the guarantee.

---

## 3. Domain model

Fresh model. No concept, table name, or abstraction is carried over from the TMS — only the structural rules above.

### 3.1 Identity

`users` are **global**, and memberships are tenant-scoped. This is not architectural neatness; it is the domain. A club member frequently also owns an aircraft of their own, and belongs to two clubs at the field. One human, one login, many memberships. (When instructors arrive, they are the same pattern at higher multiplicity.)

```
users                 global identity, credentials, MFA
memberships           (user, tenant) + role bundle + status   [tenant-scoped]
role_bundles          named sets of (resource, level)          [tenant-scoped]
```

A user with no memberships is valid (just invited, or removed from their last org). A membership is the only thing that grants a user any visibility into a tenant.

**Tenant archetype** is a column on `tenants`: `solo | partnership | club` (`school` later). It is a descriptive label for onboarding copy, quota defaults at provisioning, and reading the control plane at a glance. Cheap to add now, annoying to backfill later.

**It must never be read at runtime to decide behavior.** `if (tenant.archetype === 'solo')` is §1.3 in a better disguise. Behavior comes from flags, quotas, and permissions — never from this column.

### 3.2 Fleet

```
aircraft              registration, type_code → aircraft_types, serial,
                      year, home_base → aerodromes, status, ownership
aircraft_config       seating, equipment, MEL reference, performance profile
aircraft_documents    airworthiness cert, registration, insurance, W&B
meter_readings        hobbs, tach, airframe hours, cycles — append-only
```

**Registration is unique per tenant, not globally.** A tail number is unique in the real world, but two tenants legitimately track the same aircraft. The concrete case is **leaseback**: an owner leases their aircraft to a club, the owner tracks maintenance and expenses, the club schedules it. Both are real tenants with real records against N123AB, and neither is a duplicate of the other. Unique constraint is `(tenant_id, registration)`.

Whether those two tenants can ever *link* their records — shared squawks, shared meter readings — is a later product question. Do not pre-build it, but do not add a global uniqueness constraint that would make it impossible.

### 3.3 Scheduling

```
reservations            booked_by, purpose, start, end, status, notes
reservation_resources   (reservation, resource_type, resource_id)
blackouts               aircraft unavailable: annual, AOG, owner-held
```

**A reservation holds resource lines, not a single `aircraft_id`.** Today every reservation has exactly one line, of type `aircraft`. This looks like pointless indirection and is the single most valuable twenty lines in the schema: when instructors arrive, an instructor is another `resource_type`, a lesson booking is a reservation with two lines, and the conflict query does not change — it already asks "does any resource line overlap another." The alternative is a schema migration plus a rewrite of every booking path.

Conflict detection is a database-level exclusion constraint on `(resource_type, resource_id, tstzrange(start, end))`, not an application `SELECT`-then-`INSERT`. Two members hitting Book at the same moment is the normal case for a club with one popular aircraft on a Saturday, and application-level checking loses that race.

**A grounded aircraft blocks new reservations.** This is the first real cross-module dependency: a squawk at grounding severity, or an overdue annual or 100-hour, has to reach the scheduler. Design the signal now even though the maintenance module is thin — a resolved `aircraft_availability` view the booking path consults — because retrofitting it means finding every booking path later. Existing future reservations are flagged for review, not silently cancelled; the club needs to call those members.

### 3.4 Flight logging

**Scope: this tracks the aircraft, not the pilot.** A flight record exists to advance the aircraft's meters and feed maintenance. FlightSquare is **not** building a pilot logbook — no experience totals, no currency computation, no day/night landing counts, no approach or endorsement history, no 8710 support. Pilots keep their own logbooks in ForeFlight, LogTen, or paper, and that is fine.

This boundary is load-bearing. Pilot logbooks pull in certification, experience, and regulatory-credit logic that is a product of its own, and every feature request in that direction should be declined until it is a deliberate decision rather than a drift.

```
flights         aircraft, date, flown_by (member), from/to, remarks
flight_meters   hobbs_start / hobbs_end, tach_start / tach_end
flight_fuel     fuel_remaining_after, fuel_added_qty, fuel_added_cost, receipt
```

`flown_by` is the billing subject and the accountability record — who had the plane, who owes for it — not the seed of an experience log.

**The post-flight entry is the most important screen in the product.** One form, filled in on a phone at the tiedown: Hobbs out/in, tach out/in, fuel remaining, fuel added if any. Everything downstream — billing, maintenance countdown, the next pilot's dispatch decision — is derived from it. If it takes more than a minute, people skip it, the meters go stale, and every number in the app quietly becomes wrong. Optimize this screen over everything else.

**Fuel is two different things and must not be one field:**

- `fuel_remaining_after` is **aircraft state**. Latest reading wins; it tells the next pilot what they're walking out to. It is not a running total and must never be computed by arithmetic across flights — pilots estimate, gauges lie, and someone always tops off without logging it.
- `fuel_added_qty` / `fuel_added_cost` is a **transaction**. It feeds member billing (§3.7) when the aircraft is on a wet rate, and it is an immutable record of what someone spent.

Fuel level is not a maintenance interval, despite sitting next to them on the form. It is current state with an optional low-level alert, and it never grounds an aircraft on its own.

**Meters are the point.**

- **Hobbs and tach are recorded as read, and neither is derived from the other.** They run at different rates by design, and the difference between them is real data about how the aircraft was flown.
- Which meter drives what is **tenant configuration, not hardcoded.** Most tenants bill on Hobbs and run engine and 100-hour intervals on tach, but plenty do it differently, and some aircraft have only one meter. Per §1.3, that's a config value.
- Meter readings are **append-only**; a correction is a new row referencing the one it supersedes. People fat-finger Hobbs constantly, and the maintenance numbers downstream need an audit trail, not a silent overwrite.
- The aircraft carries current totals (airframe hours, engine time since overhaul) maintained from readings, so nothing has to sum the whole history to answer "what's it at?"

**The core loop, which the rest of the product hangs off:**

```
flight logged → meters advance → maintenance items tick down
   → item comes due, or a squawk grounds the aircraft
   → aircraft_availability blocks new reservations

            └→ charge computed against the pilot (§3.7)
```

A flight record should be creatable from a completed reservation with date and pilot prefilled.

A CSV export of a member's own flight rows is a reasonable convenience so they can transcribe into their real logbook. That is the extent of the pilot-logbook story: an export, not a feature.

### 3.5 Member qualifications

**Scope-sensitive — see open decision 3.** Given §3.4's boundary, the only defensible reason for FlightSquare to hold anything about a pilot's qualifications is as a **gate on booking**, never as a record of their experience.

```
member_aircraft_authorizations  (member, aircraft, authorized_on, authorized_by)
member_credentials              flight review due, medical expiry   -- see below
```

`member_aircraft_authorizations` stays regardless. It is the club and partnership checkout rule — "is Dave signed off in the 182?" — it gates booking, and it is about the aircraft, not the pilot's résumé.

`member_credentials` is two dates and nothing else: no certificate numbers, no ratings, no history, no computed currency. Its only job is to stop a booking and tell the admin. It sits right on the line drawn in §3.4, so confirm it before building — a defensible alternative is dropping it entirely in v1 and letting tenants handle it the way they do now.

If kept: medical expiry is health-adjacent personal data and a lapsed flight review is an FAA-enforcement-relevant fact about an individual. Both sit on the protected side of the control-plane split (§7.2).

### 3.6 Maintenance

```
maintenance_items     annual, 100-hour, ELT, transponder, pitot-static,
                      oil change — due by date / hobbs / tach / cycles
squawks               reported defect: severity, grounding?, status
work_orders           performed work, parts, A&P/IA signoff
compliance_records    AD / SB compliance — append-only, never edited
```

`squawks.grounding` is the boolean that feeds §3.3. An overdue `maintenance_item` with `grounds_aircraft = true` does the same. Both resolve through `aircraft_availability`.

**Interval presets.** Adding an aircraft should not mean typing in fifteen maintenance intervals from scratch. A global reference library (§2.2) holds suggested schedules keyed by aircraft and engine type — annual, 100-hour, oil change, oil filter, spark plugs, ELT battery, transponder and pitot-static checks, ADs — and adding an aircraft instantiates the applicable ones.

**Instantiate a copy; never reference the template.** The tenant's `maintenance_items` are their own rows from the moment they are created, freely editable, with no live link back. If they pointed at the global library, editing a preset would silently rewrite thousands of tenants' compliance data — the same class of bug as a mutable billing rate (§3.7), and worse, because this one has regulatory consequences. Record which template version seeded a row for provenance, and nothing more.

Intervals tick down against whichever meter the item specifies — tach for engine items, Hobbs or airframe hours for others, calendar months for ELT and transponder. Items can be due on more than one basis at once, and the earliest wins.

Maintenance and compliance records carry regulatory weight and are **append-only**: corrections are new rows referencing the superseded one, with actor and timestamp. Never `UPDATE` a signed compliance record, and never hard-delete one.

This is not abstract caution. After a GA accident, the squawk log, deferral history, and annual/100-hour compliance records are discoverable and get subpoenaed. Two consequences bind elsewhere in this file: control-plane read access to these tables is narrow and logged (§7.2), and a tenant under `legal_hold` is exempt from every purge, retention window, and downgrade auto-archive path in §5 (§7.4).

### 3.7 Member billing

**There are two entirely separate money systems in this product. Never call either one "billing" without a qualifier.**

| | **Platform billing** | **Member billing** |
|---|---|---|
| Who pays whom | Tenant → FlightSquare | Pilot → their club/partnership |
| Tables | `plans`, `subscriptions`, `plan_entitlements` | `aircraft_rates`, `flight_charges`, `member_ledger` |
| Permission resource | `subscription` | `charges`, `rates` |

They will be confused in conversation, in code, and in support tickets unless the names stay distinct everywhere. This section is member billing only.

```
aircraft_rates        (aircraft, amount, meter, wet_or_dry, effective_from)
member_aircraft_rates (member, aircraft, amount, effective_from)   -- override
flight_charges        (flight, member, meter_hours, rate_applied,
                       rate_source, amount, currency)
fuel_credits          (flight, member, quantity, amount)
ledger_adjustments    (member, amount, reason, created_by)         -- admin manual
```

**Rate resolution follows the §1.4 pattern:**

```
member-specific rate for this aircraft → aircraft default rate
```

Two layers today. A third (a member-category rate — student, associate, instructor) drops in later without restructuring, which is the point of using the same shape as everything else.

**Four rules that make this correct, in order of how expensive they are to get wrong:**

1. **Charges snapshot the rate; they never reference it.** `flight_charges` stores the meter hours, the amount actually applied, *and which rule supplied it* — never a foreign key to a mutable rate row. When the club raises the rate from $140 to $155 in March, February's flights must still read $140 forever. A live join re-prices history the moment anyone edits a rate, and the first the treasurer hears of it is a member disputing a statement they already paid. This is the same principle as the entitlement inspector in §7.8: record the resolved value and its source, not a pointer.

2. **Charges are append-only.** A correction is a reversing entry plus a new charge, with actor and reason. Never `UPDATE` an amount. This is money, and it will be disputed.

3. **Money is integer minor units.** Never float, never `NUMERIC` in application code paths that do arithmetic in another language. Store a currency code even while USD is the only one.

4. **Rates are effective-dated**, so a rate change is a new row, not an edit. Combined with rule 1 this makes historical re-pricing structurally impossible rather than merely discouraged.

**Wet vs dry.** A wet rate includes fuel, so a pilot who buys fuel is credited back against their charges. A dry rate excludes it, and fuel is simply the pilot's own cost with no ledger effect. This is a per-aircraft setting and it decides whether `flight_fuel.fuel_added_cost` produces a `fuel_credits` row at all.

**Which meter bills** is per-aircraft config and is frequently not the meter maintenance runs on. Hobbs for billing and tach for engine intervals is the common pairing, but it is configuration either way (§1.3).

**Member billing is a Pro-and-up capability.** A free tenant has exactly one member, so there is nobody to bill — the module is feature-gated off and returns 404 (§1.6). This is a clean, honest tier boundary: the second pilot is simultaneously when scheduling starts mattering and when billing starts existing.

### 3.8 Cross-cutting

```
audit_log             actor, tenant, resource, action, before/after — append-only
attachments           object-store pointers, tenant-scoped metadata
notifications         per-user, per-tenant
```

---

## 4. Entitlements: flags and quotas

A free tier means numeric limits, not just switches. Both resolve through the §1.4 chain; they differ in what enforcement looks like.

### 4.1 Feature flags

Boolean capabilities. Gated with 404. Examples: `maintenance_module`, `crew_currency_tracking`, `api_access`, `sso_saml`, `custom_branding`, `webhooks`, `audit_export`.

### 4.2 Quotas

Three kinds, and the distinction is load-bearing — they are enforced at different moments and behave differently on downgrade.

**Stock quotas** — a count at a point in time. Enforced at creation. These are the ones that define the product today:

```
aircraft.active          free: 1      pro: 1        enterprise: unlimited
members.active           free: 1      pro: 5        enterprise: unlimited
storage.bytes            free: 1 GiB  pro: 25 GiB   enterprise: unlimited
```

**Flow quotas** — a count within a period. Enforced at creation, reset at the period boundary. The mechanism exists; nothing important uses it yet.

```
exports.per_month        free: 2      pro: unlimited
api.calls_per_day        free: 0      pro: 0        enterprise: 10000
```

**Never cap flights.** Flight records are how meters advance (§3.4). A tenant that hits a monthly cap stops logging, the meters go stale, and every maintenance number in the product silently becomes wrong. This quota would damage the data, not just the experience. Unlimited on every tier including free.

**Window quotas** — how far back data remains visible. Enforced at read. The mechanism exists and is **unused**: history retention is unlimited on all tiers.

```
history.retention_days   free: unlimited   pro: unlimited   enterprise: unlimited
```

Same reasoning. Airframe hours, meter history, and maintenance compliance follow the aircraft for its entire life — they are consulted at every annual, every prebuy inspection, and every sale, decades on. Hiding them behind a plan would be the fastest way to lose trust in this market. Keep the mechanism — it may suit some future high-volume data — but not meters or maintenance.

### 4.3 Tiers as they stand today

The whole tier definition is rows in `plans` and `plan_entitlements`. Nothing below is in code.

| | Free | Pro | Enterprise |
|---|---|---|---|
| Aircraft | 1 | 1 | unlimited |
| Members | 1 (creator only) | 5 | unlimited |
| Scheduling | unused (no one to share with) | yes | yes |
| Maintenance tracking | yes | yes | yes |
| Flight logging | unlimited | unlimited | unlimited |

Adding a tier — a "Club" plan at 3 aircraft and 25 members, say — is inserting rows. No deploy, no migration, no code change. That is the entire point of §1.4, and it is worth protecting: the moment a plan code appears in a conditional, the property is gone.

### 4.4 Role bundles as they stand today

Two bundles, also data (§1.5). Free tenants only ever have an Admin.

| Resource | Admin | Pilot |
|---|---|---|
| `aircraft` | write | read |
| `reservations` | write | write |
| `flights` | write | write |
| `squawks` | write | write |
| `maintenance` | write | read |
| `rates` | write | read |
| `charges` | write | read — **own only, see below** |
| `qualifications` | write | read |
| `documents` | write | read |
| `members` | write | none |
| `subscription` | write | none |
| `settings` | write | none |

The account creator is Admin. A tenant must always have at least one member holding `members: write` — enforced on removal, on role change, and on downgrade auto-archive (§5.4).

Row scoping is a third dimension, not a bespoke rule (2026-09-21). A permission is now a triple: resource, level, and scope: own | all. Enforcement is in RLS as §10 already settled, through 
 app.owns_row(resource, member_id). Everything except a Pilot's charges is all: a club's flights, squawks and maintenance are shared by design. The resolved scope is also sent to clients, for wording and for hiding — never for enforcement.

The same question applies more mildly to `flights: write`, which today means any flight, not just one's own.

Representation: the resolved value is a typed `Unlimited | Limit(n)`. Do not encode unlimited as `-1`, `0`, `NULL`, or `Number.MAX_SAFE_INTEGER` — every one of those eventually gets compared with `<` by accident.

### 4.5 Enforcing quotas

Counting belongs in the database, for the same reason isolation does: it is the only place that sees every write.

- A `tenant_usage` table holds one row per `(tenant_id, quota_key)`, maintained by triggers on the counted tables.
- The creation path calls `assert_quota(p_key text, p_limit int)`, which takes `SELECT … FOR UPDATE` on that usage row inside the caller's transaction and raises if the limit would be exceeded. The lock closes the check-then-insert race that lets two concurrent requests both slip past a limit of one.
- The app resolves the limit (that needs plan config) and passes it in; the database does the counting and locking.
- Archived and soft-deleted rows do not count toward stock quotas. Decrementing on archive is the trigger's job, not the caller's.
- Window quotas are applied in the query layer as a date floor, never by deleting rows.

---

## 5. Downgrade policy

Decided up front, as required. **A plan change never destroys data. It changes what is active and what is visible.**

1. **Upgrades take effect immediately. Downgrades take effect at the end of the current paid period.** No proration surprises, and the remaining period is natural remediation time.

2. **At the effective date, if the tenant is over a stock limit, it enters `over_quota` for that quota key.** Reads work normally. Existing records keep working. Creating more of *that resource type* returns 402. Nothing else is restricted — an over-aircraft tenant can still log flights.

3. **14-day remediation window.** The UI shows what is over, by how much, and offers two paths: upgrade, or choose what to archive. The tenant picks. This is the intended resolution path.

4. **If unresolved after 14 days, the system auto-archives deterministically** — least-recently-active first, ties broken by newest-created first — down to the limit. The rule is documented, stable, and shown in the UI *before* it runs, so the outcome is never a surprise. Two guards: never archive the last member holding `members: write`, and never archive an aircraft that has a flight scheduled in the next 72 hours (skip to the next candidate and flag it).

5. **Archiving is reversible and non-destructive.** An archived aircraft keeps its full flight and maintenance history; it cannot be assigned to new flights or reservations. Re-upgrading un-archives on request — it does not auto-restore, because the tenant may have reorganized in the meantime.

6. **Flow quotas apply from the next period boundary.** A mid-period downgrade never retroactively invalidates flights already logged.

7. **Window quotas hide, they do not delete.** Data outside the new retention window becomes unreadable through the API, stays in the database for at least 90 days, and is fully restored by an upgrade within that window. Offer an export before the window shrinks.

8. **Feature loss follows the same principle.** Losing `maintenance_module` makes those endpoints 404; the rows remain and return on re-upgrade.

9. **Every plan change writes an audit record** capturing the before/after resolved entitlements, not just the plan code. When someone asks in six months why a tenant lost access to something, the answer must be reconstructable.

---

## 6. Conventions

- **UUIDv7 primary keys.** Time-sortable, no sequence leakage across tenants.
- **`timestamptz` everywhere.** No naive timestamps, no local-time columns.
- **Soft delete via `deleted_at`**, plus a `deleted_at IS NULL` predicate in the RLS policy where the table supports it — so deleted rows are invisible by default at the database level, not by remembering to filter.
- **Migrations are forward-only** and never disable RLS, even transiently. A migration that turns a policy off for the duration of a backfill is a window with no isolation.
- **No raw SQL string interpolation.** Parameterized queries only, including in migrations and scripts.
- **Errors do not leak cross-tenant existence.** "Aircraft not found" for a tail number in another tenant, never "you don't have access to that aircraft."

### 6.1 Definition of done for any tenant-scoped table

1. `tenant_id uuid NOT NULL REFERENCES tenants(id)`
2. `ENABLE` + `FORCE ROW LEVEL SECURITY`
3. Policy with both `USING` and `WITH CHECK`
4. Index leading with `tenant_id`
5. A test that sets context to tenant A, queries, and asserts zero rows from tenant B's fixtures
6. A test that attempts to insert a row with tenant B's id while in tenant A's context, and asserts it fails

Items 5 and 6 are not optional. A policy without a test proving it denies is an untested security control.

### 6.2 Review checklist

- [ ] No branch on tenant identity anywhere in the diff
- [ ] New tables classified (§2.2) and, if tenant-scoped, meet §6.1
- [ ] New `SECURITY DEFINER` functions? Justified against §2.1, search_path pinned, execute revoked from PUBLIC
- [ ] New entitlement keys registered with a global default
- [ ] Gates use the right code: feature 404, permission 403, quota 402, rate limit 429
- [ ] Quota-bearing creates go through `assert_quota` with a row lock
- [ ] Tenant context set with `SET LOCAL`, sourced from the session
- [ ] Compliance/audit tables treated as append-only
- [ ] New table classified for `admin_role` under §7.2 — metadata or content, with a policy either way (default is deny)
- [ ] Any new destructive or data-hiding path checks `legal_hold`
- [ ] Booking paths consult `aircraft_availability` rather than querying squawks directly

---

## 7. Control plane (app-owner administration)

The FlightSquare team needs to see every tenant, review setup and settings, and disable an account. That is inherently cross-tenant, which makes it the one place where §1's invariants could be quietly abandoned. This section defines the legitimate door so nobody reaches for `BYPASSRLS` at 2am.

### 7.1 A second role, not a bypass

RLS policies are per-role and OR together, so cross-tenant access is expressible as policy — auditable, per-table, revocable, and greppable.

```sql
CREATE POLICY admin_read ON tenants  FOR SELECT TO admin_role USING (true);
CREATE POLICY admin_read ON squawks  FOR SELECT TO admin_role USING (false);
```

- `admin_role` is a distinct database role. It is not the application role with extra grants.
- It **does not have `BYPASSRLS`** either. §1.2 is absolute and has no admin exception.
- Default posture is deny: a new table grants `admin_role` nothing until someone writes a policy and classifies it under §7.2.
- Writes are rarer than reads and separately granted. Most admin actions are reads plus a small set of lifecycle transitions.

### 7.2 Two tiers of visibility

**Metadata — `admin_role` reads freely.** Everything needed for billing, support triage, and account review, with no operational content:

```
tenants  memberships  users (identity only)  plans  subscriptions
tenant_entitlement_overrides  tenant_usage  audit_log
aircraft (registration, type, status — not squawk or log detail)
```

**Content — requires a time-boxed, logged, tenant-consented grant:**

```
squawks  work_orders  compliance_records  maintenance_items
flights  flight_times  flight_meters
member_credentials  member_aircraft_authorizations
attachments
```

The metadata tier answers nearly every real support ticket. Content access is for a customer saying "come look at this with me," and it should feel like a deliberate act: a grant row with an expiry, visible to the tenant, written to the audit log on creation and on every read it authorizes.

The line is drawn at medical expiry, currency lapses, and maintenance discrepancy history — personal health-adjacent data, FAA-enforcement-relevant facts about individuals, and litigation-grade records respectively. "We are careful" is a worse answer to a prospect's security question than a list of per-table policies.

### 7.3 Tenant lifecycle

```
trial → active → past_due → suspended → closed
```

This is the disable switch, and it is already wired: `auth.resolve_tenant_by_host` returns `status` on every request (§2.1), so rejecting at bootstrap costs nothing and reaches every entry point at once.

- `suspended` — authentication rejected, data fully intact, reversible in one write. This is the normal disable.
- `closed` — no login, retention clock started, still fully restorable until purge.
- Suspension is never the same as deletion, and the UI must not let them be confused.
- Define all five now. Accreting them later as independent booleans produces the permanent "is it `disabled` or `is_active = false` or `closed_at IS NOT NULL`" tax.

### 7.4 Legal hold

`tenants.legal_hold boolean NOT NULL DEFAULT false`. When true, it hard-blocks **every** destructive or hiding path: retention-window expiry, downgrade auto-archive (§5.4), window-quota hiding (§5.7), post-close purge, and tenant deletion. It is checked in the database, not only in application code, because it must survive a future code path nobody has written yet.

### 7.5 Impersonation

If it exists, it is a distinct session type — never a silent switch of `app.tenant_id`.

- Expires (60 minutes, hard).
- Banner visible to the tenant's own users while active.
- Every request tagged with both the impersonating admin and the target tenant in the audit log.
- Read-only unless the tenant granted write for a specific support session.

Decide whether to build it before the session model hardens; retrofitting a second session type is painful.

### 7.6 Admin audit log

Append-only from day one. `REVOKE UPDATE, DELETE ON admin_audit_log FROM admin_role` — the admin plane cannot edit its own record. This cannot be backfilled, and it is the artifact that makes every claim in §7.2 verifiable rather than aspirational.

### 7.7 Deployment

**Separate application, separate origin, separate database role, MFA mandatory, IP-restricted if practical.** Not a route inside the tenant app behind an `isAdmin` check.

The control plane is the only surface holding cross-tenant sessions. Sharing a codebase and origin with the tenant app means one routing bug, one middleware ordering mistake, or one forgotten guard exposes it. Separate deployment makes that a network-level impossibility rather than a code-level promise.

### 7.8 What v1 actually is

Ship the access model now; the interface can wait. Admin panel v1 is a set of reviewed SQL scripts run as `admin_role`, and that is adequate well past first customers. When a UI is built, these two screens come first:

1. **Resolved entitlement inspector** — every flag and quota for a tenant, its resolved value, and *which layer supplied it* (override / plan / default). Given §1.4, most support tickets are "the customer says they can't do X." This ends that ticket class in one screen.
2. **Downgrade dry-run** — §5.4 auto-archives deterministically after 14 days. Support needs to show a club exactly which aircraft and members would go, before it happens.

Metrics dashboards, cohort reporting, and self-serve provisioning are later.

### 7.9 The invariant still holds here

Operating *on* a tenant is not branching *on* tenant identity. An admin tool taking `tenant_id` as a parameter and applying uniform logic is correct. `if (tenant.slug === 'bigclub')` is banned in the admin plane exactly as it is everywhere else (§1.3).

---

## 8. Clients

FlightSquare ships as a **web application and a native iOS/iPadOS app**. Both are clients of one API. There is no server-rendered web path that bypasses it, and no endpoint that exists for only one client.

### 8.1 The client is untrusted, and now it is also stale

§1.5 already requires server-side enforcement. A shipped iOS build makes that non-negotiable in a new way: **you cannot force-update it.** Some fraction of users will run a six-month-old binary, and that binary is on a device you don't control, talking to your API with a valid token. It is not a trusted part of the system; it is an anonymous HTTP client that happens to have your logo.

Consequences:

- **The API is additive-only.** Never remove a field, never repurpose one, never tighten a validation rule that an old client would now fail. Breaking changes go in new endpoints or new fields.
- **Entitlements are fetched, never compiled in.** The client receives the resolved flags and quotas (§1.4) and hides UI accordingly. It must never carry a hardcoded table of what Pro includes — that table goes stale on the App Store and cannot be corrected without a release.
- **The client hiding a button is cosmetics.** Every gate is enforced server-side, every time (§1.6).
- Ship a **minimum-supported-version handshake** from day one: the API can tell a client it is too old and must update. You will need it exactly once, at the worst possible moment, and it cannot be added retroactively to builds already in the wild.

### 8.2 Offline is a requirement, not a nice-to-have

The most important screen in the product (§3.4) is used standing at a tiedown on a rural field with one bar or none. If post-flight entry requires connectivity, it doesn't get done, and §3.4's failure mode — stale meters, wrong maintenance numbers — arrives by a different road.

- **The client generates ids.** UUIDv7 (§6) already permits this; it is why the choice matters.
- **Every write carries an idempotency key.** Sync retries, spotty connections, and app backgrounding all produce duplicate submissions.
- **Records carry both a recorded-at and a received-at time.** They are frequently different, sometimes by days.
- **The client never computes anything that matters.** Charges, maintenance countdowns, and availability are all computed server-side on sync. Rates may have changed; the client's view of the schedule may be old; and a client-computed charge is a client-asserted charge.
- **Meter readings can arrive out of order.** Two pilots fly the same aircraft on the same afternoon and sync in the wrong sequence. Readings are append-only (§3.4) and the server orders by recorded-at, not arrival. A Hobbs start that doesn't match the previous flight's end is a **flag for the admin, never a rejection** — the gap is real information, usually a maintenance run or an unlogged flight.

### 8.3 Subscription billing stays on the web

Apple requires in-app purchase for digital subscriptions sold inside the app, with a 15–30% commission. The standard B2B SaaS posture — a free app that authenticates against an API, with plans purchased on the web — is explicitly permitted and is how Slack, Notion, and Figma operate. FlightSquare follows it.

Two reasons beyond the commission:

1. **An IAP subscription belongs to an Apple ID, not to an organization.** The member who subscribes owns it. When they leave the club, nobody else can cancel, upgrade, or manage it — and the service provider cannot cancel it either. For a multi-tenant product where the *tenant* is the customer, this is structurally broken, not merely expensive.
2. Web checkout keeps Stripe as the single system of record for §3.7's platform billing, rather than reconciling two.

Conditions this imposes, which the current design already satisfies:

- **The free tier must have real standalone value.** An app that is only a login wall gets rejected as a thin client. Free — one pilot, one aircraft, full maintenance tracking and unlimited flight logging — is a genuinely useful product on its own. Do not erode this to drive upgrades; deliberately crippling the free tier to push people to the web is itself grounds for rejection.
- **No steering from inside the app** outside the US and qualifying EU flows. The iOS app does not link to a signup or upgrade page. Hitting a quota returns 402 (§1.6) and the app explains the limit without pointing at a URL.

App Store rules in this area are actively changing — the post-*Epic* US position, the EU's DMA regime, and Japan's and Brazil's new frameworks all moved recently. **Verify against Apple's current App Review Guidelines before submission rather than trusting this paragraph.**

### 8.4 Auth

Mobile needs long-lived refresh tokens with short-lived access tokens, not session cookies. If any third-party sign-in is offered, Apple requires Sign in with Apple alongside it. Push notifications (maintenance due, squawk filed, booking confirmed) mean APNs and a device-registration table — worth a placeholder in the schema now.

---

## 9. Stack and layout

TypeScript everywhere — API, infra, web, and mobile — so one person can move between all four without a context switch.

```
flightsquare/
├── CLAUDE.md
├── db/                  numbered .sql migrations, RLS isolation tests
├── api/                 Fastify + Kysely
├── infra/               AWS CDK
├── web/                 Next.js — marketing, signup, subscription checkout, full app
├── mobile/              Expo (React Native) — iOS/iPadOS
└── packages/shared/     shared types, generated API client
```

npm workspaces. Vitest for tests.

**Database access is `pg` + Kysely, not a full ORM.** This is a constraint, not a taste: §1.1 requires `SET LOCAL app.tenant_id` inside the transaction that does the work, so the data layer must expose transaction boundaries explicitly. An ORM that transparently manages connections and hides transactions cannot satisfy that safely. Every request opens a transaction, sets the tenant context, runs its queries, commits.

**Migrations are numbered plain SQL** (`0001_foundation.sql`), run by the owner role. The application never runs them and never holds the owner's credentials.

**Mobile is Expo with `expo-sqlite`** for the offline queue in §8.2. Web and mobile do not share UI code; they share types and the API client from `packages/shared`. Two UI codebases is the accepted cost of a web surface good enough to sell subscriptions on (§8.3).

**Hosting is deferred** until there is something worth deploying. Local development is Docker Postgres. The one binding constraint on whatever gets chosen: connection pooling must not break per-transaction `SET LOCAL`, which rules out statement-level pooling and makes pooler configuration a correctness issue rather than a performance one. Session and transaction pooling are both fine — `SET LOCAL` is scoped to the transaction either way. Transaction pooling is in fact the mode that *requires* it: a plain `SET` there leaks one tenant's context onto the next request that borrows the connection, which is the §1.1 failure exactly.

```
Install:        npm install
Dev database:   docker compose up -d
Migrate:        npm run migrate
Test:           npm test
API dev:        npm run dev -w api
Web dev:        npm run dev -w web
Mobile dev:     npx expo start          (from mobile/)
```

---

## 10. Open decisions

### Decided

**Provisioning is a seventh `auth.*` function** (2026-09-20). Creating a tenant and its first user provably cannot have tenant context — the tenant does not exist yet — which is §2.1's own admission test, and the only operation that passes it. `auth.provision_tenant` is the first *write* on the permitted list, and §2.1 now carries the four extra rules that a write door needs. The alternatives were putting public signup on the control-plane origin (§7.7 exists to keep that surface small) or making the global `users` table app-writable.

**The database session carries user identity** (2026-09-20). `SET LOCAL app.user_id` accompanies `SET LOCAL app.tenant_id` on every transaction, read through `app.current_user_id()`. Row scoping (decision 3 below) will therefore be enforced in RLS rather than by a remembered `WHERE` clause, consistent with §1.1 — the database is the thing standing between people and data, not the application. This does not settle the *shape* of the permission model; decision 3 is still open.

**Impersonation: deferred, with the seam kept open** (2026-09-20). Not built in v1 — §7.2's time-boxed, logged, tenant-consented content grant covers the actual support need. But §7.5's warning about retrofitting a second session type binds: **the sessions table carries a `session_type` discriminator and the audit log carries an acting-admin column from the migration that creates them**, even though only one value of each is ever written today.

**FlightSquare produces statements; it does not move members' money** (2026-09-21). §3.7's ledger records what a pilot owes their club and what they have paid, and a treasurer settles it by cheque, transfer or cash at the hangar — a payment recorded as an adjustment. Processing pilot payments would mean platform accounts, refunds, chargebacks and tax reporting, which is a different product. The ledger is shaped so recorded payments could become real ones without restructuring. Platform billing (§8.3) is the only money the product moves, it is the tenant's subscription, and it is Stripe on the web.

**`deleted_at` is a control-plane marker, not an application verb** (2026-09-20). §6 asks for a `deleted_at IS NULL` predicate in the RLS policy *and* for soft deletion; Postgres will not give both, because on UPDATE it re-checks the new row against the policies that apply to SELECT — so a row that sets `deleted_at` stops satisfying the policy that made it visible, and the write is refused. Resolved in favour of the invariant: `deleted_at` means account closure and purge (§7.3), written by the admin plane. **An application-facing "delete" is a status column** — a removed member is `status = 'removed'`, an archived aircraft will be an aircraft status. §5.5 requires archived records to keep their history and return on re-upgrade, so hiding them at the database level would have been wrong anyway.

### Open

These need your call; they are not blocking the first tables.

1. **The Pro → Enterprise gap.** Pro is one aircraft; Enterprise is unlimited. A club with three aircraft and twelve members has nowhere to land. That is a pricing question, not an architecture one — a middle tier is rows in `plans` whenever you want it (§4.3). Noted so it is a deliberate choice rather than an oversight.
2. **Keep or drop `member_credentials`** (§3.5). Two dates — flight review and medical expiry — as a booking gate. Defensible as aircraft-safety gating, but adjacent to the pilot-record line drawn in §3.4. Dropping it in v1 is a reasonable call. If kept, decide whether one pilot can see another's.
3. **402 vs 409 for quota exhaustion.** 402 chosen because the remediation is a plan change and it stays orthogonal to 429. If you'd rather reserve payment semantics for actual billing failures, 409 with the same body works.
4. **Tenant deletion vs. append-only compliance records.** §3.6 makes maintenance and AD compliance append-only; a hard-delete request collides with that. `legal_hold` handles the litigation case, but the ordinary "close my account and erase me" path still needs a documented retention answer before there is data to delete.
5. **Leaseback record linking** (§3.2). Two tenants tracking one tail number is supported; whether they can ever share squawks or meter readings is a product question. Not now, but don't foreclose it.
6. **Free-tier quota values.** §4.3's aircraft and member counts are real and shipped. `storage.bytes`, `exports.per_month` and `api.calls_per_day` are declared, unenforced placeholders — nothing counts them, so their numbers mean nothing yet.

## 11 DESIGN GUIDELINES

## FlightSquare design system — Cool Aviation

This is the authoritative FlightSquare design specification.
It supersedes all earlier FlightSquare branding, typography, and color
instructions, including monochrome-only rules and earlier addenda.

Apply it to new features and use it to update existing interface styling.
Preserve unrelated project instructions, application architecture,
business logic, data, permissions, and functionality.

### 1. Design direction

FlightSquare is a modern aircraft-management platform.

The interface should feel:
- Clean and minimal.
- Precise and organized.
- Calm and professional.
- Approachable for general aviation owners and pilots.

The chosen visual direction is "Cool Aviation":
white surfaces, soft mist backgrounds, midnight navy typography,
slate supporting details, and restrained bright teal accents.

Add depth through subtle surface tones and clear hierarchy.
Avoid excessive decoration, cockpit themes, futuristic effects,
glassmorphism, heavy shadows, and gradients.

Brand name: FlightSquare.
Official logo wordmark: flightsquare.
Tagline: "Aircraft management, simplified."

Use the tagline on marketing, onboarding, and sign-in screens.
Do not repeat it throughout operational screens.

### 2. Logo

Use the supplied approved SVG assets:
- flightsquare-logo.svg: horizontal symbol and wordmark.
- flightsquare-icon.svg: standalone symbol.

The logo remains black or white, even though interface text and buttons
now use navy.

- Black logo on light surfaces.
- White logo on dark navy surfaces.
- Horizontal logo for full headers.
- Standalone symbol for compact navigation and app icons.
- Preserve original proportions and internal spacing.
- Keep external clear space of at least one-quarter of symbol height.
- Typical header symbol height: 28–32px.
- Never recolor the logo teal, redraw it, or replace it with an icon.
- Never recreate the wordmark using live text.
- Do not modify logo paths when changing application fonts.

### 3. Color system

Centralize colors in the existing theme/token system.

Core palette:

| Token | Hex | Purpose |
|---|---|---|
| navy | #152B3C | Primary text, primary buttons, dark brand surfaces |
| teal | #00C2B8 | Main accent, selected controls, key highlights |
| mist | #EAF1F5 | Page backgrounds and subtle section surfaces |
| slate | #718493 | Decorative secondary details and chart series |
| white | #FFFFFF | Cards, forms, menus, dialogs |
| black | #000000 | Approved black logo artwork |

Supporting interface tokens:

| Token | Hex | Purpose |
|---|---|---|
| text-secondary | #526675 | Body-level supporting text |
| border-subtle | #D6E1E8 | Card borders and decorative dividers |
| border-control | #718493 | Input/control boundaries when needed |
| surface-hover | #F3F7F9 | Hover and understated alternate surfaces |
| surface-selected | #E0F5F3 | Selected navigation and control surfaces |
| teal-text | #007A74 | Accessible teal text on light backgrounds |
| navy-hover | #203E54 | Primary-button hover state |
| on-dark | #FFFFFF | Text on navy |
| on-teal | #152B3C | Text and icons on bright teal |

Slate #718493 is not the default for small supporting text on white.
Use text-secondary #526675 and verify contrast in context.

Color application:
- Main app canvas: mist.
- Cards, dialogs, menus, and form surfaces: white.
- Primary text and headings: navy.
- Supporting text: text-secondary.
- Primary buttons: navy with white text.
- Teal: selected indicators, enabled controls, and limited highlights.
- Dark marketing panels and reverse business cards: navy.
- Logo artwork: black or white only.

White and mist should dominate most screens.
Teal should remain a small portion of the interface, generally under 5%.
Navy can occupy larger areas when useful, such as a marketing panel.

Do not introduce coral, ivory, sand, sage, or olive from other concepts.
Do not turn every button, icon, link, and heading teal.
Avoid large saturated teal backgrounds.

Do not use white text on bright teal.
Use teal-text for small teal links on light surfaces.
Verify actual foreground/background contrast before implementation.

### 4. Typography

Use two font roles:

- Brand font: Manrope.
- Interface font: Inter.

Manrope:
- Marketing headlines.
- Brand taglines.
- Promotional display titles.
- Report-cover display titles.

Inter:
- All operational app headings and subheadings.
- Body text and descriptions.
- Navigation, tabs, buttons, and menus.
- Labels, inputs, placeholders, and validation.
- Tables, flight logs, maintenance records, and financial information.
- Metrics, badges, dialogs, notifications, and tooltips.
- Chart labels and legends.
- Marketing body copy and controls.
- Report body text and data tables.

The approved SVG wordmark remains unchanged and has no font dependency.

Do not mix Manrope headings with Inter body copy inside working app screens.
Inter is the default for the entire operational interface.

Font stacks:
- font-brand: "Manrope", sans-serif
- font-ui: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif

Inter weights:
- 400: body, inputs, descriptions, table values.
- 500: labels, navigation, tabs, table headers.
- 600: headings, buttons, card titles, key metrics.

Manrope weights:
- 600–700 for marketing headings.
- 400–500 for supporting brand treatments where appropriate.

Preferred interface scale:

| Element | Size | Weight |
|---|---|---|
| Page title | 28–32px | 600 |
| Section heading | 20–24px | 600 |
| Card heading | 16–18px | 600 |
| Body | 14–16px | 400 |
| Form input | 16px | 400 |
| Button/navigation/label | 14px | 500–600 |
| Supporting text | 12–13px | 400–500 |
| Key metric | 28–36px | 600 |

Retain existing sizes that already work within this scale.
Do not enlarge the interface merely because the font changed.

- Body line height: approximately 1.5.
- Heading line height: approximately 1.2–1.3.
- Sentence case by default.
- Uppercase only for short metadata, registrations, and aviation abbreviations.
- Normal letter spacing for operational text.
- Tabular numerals for aligned hours, amounts, and date/time columns.
- Preserve intentional monospace styles for actual code.

Load real font files and weights through the existing project mechanism.
Avoid synthetic weights and duplicate font-loading systems.
Preserve font license notices.

### 5. Layout, spacing, and surfaces

Use a shared spacing scale:
4, 8, 12, 16, 24, 32, and 48px.

Defaults:
- Desktop page padding: 24–32px.
- Mobile page padding: 16px.
- Card padding: 20–24px desktop, 16px mobile.
- Related field spacing: 16px.
- Major section spacing: 24–32px.
- Button/input radius: 8px.
- Card/dialog radius: 12px.
- Borders: generally 1px.

Use mist backgrounds to separate white cards naturally.
Favor whitespace and alignment over unnecessary nested containers.

Cards should be useful and reasonably compact.
Avoid oversized panels containing very little information.

Use subtle shadows only where elevation matters, such as menus and dialogs.
Do not apply heavy shadows to every card.

### 6. Buttons and actions

Primary button:
- Navy background.
- White text.
- Inter 600.
- Approximately 44px high.
- 8px radius.
- Navy-hover hover state.

Secondary button:
- White background.
- Navy text.
- Clearly visible neutral border.
- Subtle hover background.

Tertiary action:
- Navy text or icon.
- No permanent filled background.
- Clear hover and focus feedback.

Inline links:
- Navy with underline, or teal-text with underline.
- Do not rely on color alone to identify links.

Use one visually dominant primary action per workflow or section.
Use specific labels: "Add aircraft", "Schedule flight", "Save changes".

Do not make primary buttons bright teal by default.

### 7. Navigation

Preserve the established navigation structure unless explicitly requested.

Light navigation is the default:
- White surface.
- Navy text and outline icons.
- Selected item: pale selected surface, stronger text weight,
  and a small teal marker.
- Keep an additional non-color cue for selection.

Do not create a large dark sidebar solely to match a marketing mockup.
A dark navy navigation treatment is acceptable only where the existing
layout or an explicit design request calls for it.

### 8. Forms

- Visible labels above fields.
- White fields with navy text.
- Placeholders supplement labels; they never replace them.
- Consistent field heights and padding.
- Clear required-field identification.
- Helper and validation text placed next to the relevant field.
- Preserve entered values after validation errors.
- Ensure inputs, selects, textareas, and buttons inherit Inter.
- Use visible navy focus outlines with separation from the component.
- Use sufficiently contrasting control borders, not decorative
  low-contrast dividers when the boundary is needed to identify a field.

Provide distinct disabled, read-only, focused, selected, and invalid states.

### 9. Cards, tables, and data

Cards:
- White surface.
- Navy heading.
- Muted supporting text.
- Subtle border.
- Consistent action placement.
- Optional mist or pale selected surface for a specific highlighted area.

Tables:
- Inter throughout.
- Light mist or hover-tone header surface.
- Clear headers and subtle row dividers.
- Navy primary values; darker supporting text where needed.
- Left-align text.
- Right-align comparable numeric values.
- Use tabular numerals.
- Keep units, currencies, and date formats consistent.
- Make sorting, filtering, and pagination understandable.
- Adapt dense tables for mobile without hiding essential information.

Avoid decorative aircraft imagery on every operational card.
Use images where they help identify an aircraft or support marketing.

### 10. Icons and imagery

Use the existing consistent outline icon family.
If none exists, use Lucide.

Icon sizes:
- 16px for compact actions.
- 20px default.
- 24px for larger navigation or empty states.

Use consistent stroke weight around 1.75–2px.
Default icons are navy or supporting-text colored.
Use teal only for deliberate emphasis.

Do not mix outline icons, emoji, multicolor artwork, and filled styles.
Never replace the official logo with an icon-library airplane.

Brand photography:
- Small general aviation aircraft.
- Cirrus SR20/SR22-style piston airplanes are preferred.
- Natural daylight, clean airport or hangar settings.
- Realistic scale, details, and proportions.
- Avoid airliners and large business jets in general brand marketing.
- Preserve real uploaded aircraft photos regardless of aircraft type.

### 11. Status, warnings, and aviation information

Brand accent colors are not substitutes for semantic status rules.

- Teal represents interaction, selection, or limited emphasis.
- Do not use teal as a universal "safe" or "airworthy" signal.
- Pair statuses with explicit text and recognizable icons.
- Keep routine statuses visually restrained.
- Make warnings and blocking conditions clearly distinguishable.
- Preserve existing functional error, warning, and success colors
  where they communicate necessary meaning.
- Do not remove established red/amber warning behavior to force
  everything into the brand palette.
- Semantic colors are functional exceptions, not decorative accents.
- Never rely on color alone.

Do not infer airworthiness from an absence of maintenance warnings.
Preserve validated business rules and source data.

Explicitly identify Hobbs versus tach time, time zones, units, and currencies
where ambiguity is possible.

Mockup names, registrations, dates, contacts, routes, and values are examples.
Do not copy them into production as real data.

### 12. Charts

Use:
- Teal for the primary emphasized series.
- Navy and slate for supporting series.
- Mist for restrained contextual surfaces and grid treatment.

Use labels, markers, and line patterns to distinguish series.
Do not depend solely on color or similar shades.
Keep axes, units, legends, and supporting summaries readable.

Avoid rainbow palettes, decorative gauges, 3D charts, and heavy fills.

### 13. Motion and accessibility

Use restrained transitions, generally 150–200ms.
Respect reduced-motion preferences.
Avoid decorative logo animation, bouncing, and parallax.

Target WCAG AA:
- Verify text and non-text contrast in actual context.
- Maintain visible keyboard focus.
- Aim for touch targets of at least 44 × 44px.
- Give icon-only controls accessible names.
- Support keyboard navigation and dialog focus management.
- Do not communicate meaning through color alone.
- Preserve readable text on mobile.
- Provide loading, empty, error, success, and disabled states.
- Prevent duplicate submissions.

Bright teal on white may need a darker boundary, marker, or supporting
indicator to meet non-text contrast requirements.

### 14. Updating the existing app

This is an incremental design-system migration, not a rebuild.

1. Inspect existing theme tokens, fonts, and shared components.
2. Map existing tokens to the new Cool Aviation palette.
3. Set Inter as the default operational interface font.
4. Retain Manrope for explicit marketing and brand elements.
5. Update shared components before adding page-level overrides.
6. Replace outdated hardcoded visual values where needed.
7. Review representative screens on desktop and mobile.
8. Correct styling regressions with the smallest necessary changes.

Preserve:
- Routes and navigation structure.
- Business logic and API behavior.
- Authentication and permissions.
- Data models and application state.
- Existing workflows and content.
- Working responsive behavior.
- Accessibility and critical warning behavior.

Do not:
- Rebuild pages from the concept board.
- Introduce new features or marketing claims.
- Add a new UI library solely for this restyle.
- Change layouts that already work without a concrete reason.
- Globally replace every black value, including logo artwork.
- Scatter raw colors and font definitions across components.

Use the existing styling architecture and central theme configuration.
Account for portals, dialogs, chart libraries, native form controls,
and reports that may not inherit global typography.

### 15. Completion checklist

Before finishing a design update, verify:
- Black/white approved SVG logos remain unchanged.
- Inter is loaded and applied throughout operational UI.
- Manrope remains in approved brand/marketing roles.
- Navy, mist, white, slate, and restrained teal are applied consistently.
- Primary buttons are navy with white text.
- Supporting text has adequate contrast.
- Controls and navigation have clear interaction states.
- No text clipping, unexpected wrapping, or layout shifts.
- Tables and numeric columns remain readable.
- Mobile layouts and keyboard interactions work.
- Loading, empty, error, and success states remain complete.
- Functional warnings and business logic are preserved.

The concept boards establish visual direction. This written specification
and actual application requirements take precedence over incidental
details in generated images.
