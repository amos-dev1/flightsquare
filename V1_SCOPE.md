# FlightSquare v1 Scope

Companion to CLAUDE.md. That file says *how* to build; this one says *what* v1 is and — more importantly — what it is not. Section references point into CLAUDE.md.

---

## 1. What v1 is

> **A flying club with five pilots and one aircraft can run their entire operation on FlightSquare for a month with no spreadsheets: book the plane, log flights, see what maintenance is coming due, report squawks, and get a correct statement for each pilot at month end.**

That is the test of done. Not a feature count — a month of real use by a real club that doesn't fall back to their old tools.

Everything in this document either serves that sentence or is explicitly deferred.

### The v1 shape

- **Free tier is fully functional.** One pilot, one aircraft, maintenance tracking, unlimited logging. It has to stand alone as a product (§8.3).
- **Pro is the real product.** Up to 5 pilots on one aircraft: scheduling and member billing switch on.
- **Enterprise exists but is barely exercised in v1.** Multiple aircraft, unlimited members. Ship it, don't optimize it.

### The platform split

**The phone is for pilots. The web is for admins.**

This is the single biggest scope reduction in the document, and it holds for all of v1. A pilot's job happens at the aircraft — book it, fly it, log it, report a problem, check what they owe. Five screens. An admin's job happens sitting down — rates, members, maintenance schedules, statements, settings — and there is no reason to build that twice.

No admin functionality on mobile in v1. If an admin needs to change a rate, they open a laptop.

---

## 2. Roles

Two, as defined in CLAUDE.md §4.4.

**Admin** — the account creator, plus anyone they promote. Full write on everything. Manages aircraft, members, rates, maintenance, and the subscription.

**Pilot** — books, flies, logs, reports squawks, sees their own charges. Read-only on aircraft, maintenance, and rates.

No other roles in v1. A treasurer-who-isn't-an-admin and a maintenance-officer-who-isn't-an-admin are both real club structures and both wait for v2, when role bundles become editable.

---

## 3. Modules

### M1 — Identity and tenancy

**In scope**

- Sign up: creates the tenant and the first membership as Admin, in one flow. Free tier by default.
- Email/password auth. Email verification on signup.
- Password reset by emailed token.
- Log out, session expiry, refresh tokens for mobile (§8.4).
- Invite a member by email → emailed token → they set a password (or sign in, if the email already has a FlightSquare account) → membership created.
- Member list: name, email, role, status, date joined.
- Change a member's role (Admin ↔ Pilot).
- Deactivate a member. Never hard-delete — their flights, charges, and squawks stay attached.
- Profile: name, email, phone.
- Tenant settings: name, timezone, archetype.

**Rules**

- A tenant always has at least one Admin. The last one cannot be demoted or deactivated (§4.4).
- Inviting is blocked at the `members.active` quota with 402 (§1.6). Free tier means the invite button is absent, not broken.
- `users` are global; the same email can hold memberships in several tenants (§3.1). Post-login, if a user has more than one membership, they pick.

**Out:** SSO/SAML, 2FA, magic links, bulk import, custom roles.

---

### M2 — Aircraft

**In scope**

- Add an aircraft: registration, make/model, type, year, serial, home base (free-text airport identifier).
- Current meters: Hobbs, tach, airframe hours. Set at creation, advanced by flight logs thereafter.
- Per-aircraft config:
  - **Billing meter** — Hobbs or tach
  - **Rate basis** — wet or dry (§3.7)
  - **Default hourly rate**
  - **Maintenance meter** — which meter engine-hour intervals run against
  - Fuel capacity and units
- Status: `active`, `grounded`, `archived`.
- Aircraft detail view: meters, next maintenance due, open squawks, fuel remaining, upcoming reservations.
- Archive an aircraft — history preserved, no new bookings or flights (§5.5).

**Rules**

- Registration unique per tenant, not globally (§3.2).
- Adding is blocked at the `aircraft.active` quota with 402.
- Meter values only ever advance through flight logs or an explicit admin correction, never by direct edit.

**Out:** photos, equipment lists, avionics inventory, W&B data, performance profiles, document storage.

---

### M3 — Scheduling

Pro and above. A free tenant has one pilot and nothing to coordinate.

**In scope**

- Calendar per aircraft: day and week views. Week is the default.
- Create a reservation: aircraft, start, end, purpose note.
- Edit or cancel your own. Admins can edit or cancel anyone's.
- Conflict prevention via a database exclusion constraint, not an application check (§3.3).
- Blackouts: an admin blocks time for maintenance, annual, or owner use.
- A grounded aircraft blocks new reservations. Existing future reservations are flagged for the admin, never silently cancelled (§3.3).
- Authorization check: a pilot can only book an aircraft they are authorized on (§3.5). Admins grant authorization.
- "My upcoming reservations" list.

**Out:** recurring reservations, waitlists, minimum/maximum booking duration, advance-booking limits, cancellation windows or penalties, instructor scheduling, calendar sync (ICS/Google), squawk-aware soft warnings.

Several of those — recurring bookings and ICS export in particular — are the first things a real club will ask for. They are fast-follows, not v1.

---

### M4 — Flight logging

The core of the product (§3.4). Works on free tier.

**In scope**

- Post-flight entry — **one screen, optimized above everything else**:
  - Date, aircraft, pilot (prefilled from the reservation where one exists)
  - Hobbs start / end
  - Tach start / end
  - Fuel remaining after
  - Fuel added: quantity and cost (only if the aircraft is wet-rate)
  - Remarks
  - From / to, free text, optional
- Submitting advances the aircraft's meters, ticks down maintenance intervals, and generates a charge (Pro+).
- Create from a completed reservation in one tap.
- Log a flight with no reservation — for free tenants, and for the times nobody booked.
- **Offline capture and sync on mobile** (§8.2). Client-generated ids, idempotency keys, recorded-at separate from received-at.
- Flight list; filter by aircraft, pilot, date.
- Edits: a pilot may edit their own entry for 24 hours. An admin may edit any entry at any time. Edits after the window write a correction record, never an overwrite.
- Meter continuity check: a Hobbs start that doesn't match the previous flight's end raises a flag for the admin. **Never a rejection** — the gap is usually a maintenance run or an unlogged flight (§8.2).

**Out:** route tracking, GPS, ForeFlight or logbook integrations, photo attachments, passenger records, per-leg entry. CSV export of a member's own rows is in, as the whole of the pilot-logbook story (§3.4).

---

### M5 — Maintenance and squawks

Works on free tier — a solo owner tracking their own annual is a real use case and the reason free stands alone.

**In scope — maintenance**

- Maintenance items per aircraft, each with:
  - Name, interval basis (tach hours / Hobbs hours / calendar months), interval value
  - Last complied: date and meter reading
  - Next due: computed, on whichever basis arrives first
  - `grounds_aircraft` flag
- **Preset library** instantiated at aircraft creation (§3.6): annual, 100-hour, oil change, oil filter, ELT battery, transponder check, pitot-static check. Copied into the tenant, never referenced (§3.6).
- Add, edit, and remove items freely after instantiation.
- Status: `ok` / `due soon` / `overdue`. "Due soon" threshold is per-item config, defaulting to 10 hours or 30 days.
- Mark complied: records date, meter, who, and a note; recomputes next due. Append-only (§3.6).
- Compliance history per item.
- Dashboard: everything due or overdue across the fleet.

**In scope — squawks**

- Report a squawk: title, description, severity (grounding / non-grounding). Any pilot may file one.
- A grounding squawk immediately makes the aircraft unavailable for new bookings.
- Admin resolves with a note. Append-only.
- Open squawks are visible to all members on the aircraft detail view — the next pilot needs to know.

**Out:** parts inventory, work orders with labor and cost, AD/SB tracking as a distinct entity, A&P/IA signature capture, photo attachments on squawks, MEL deferrals, type-specific preset libraries, maintenance cost reporting.

Squawk photos are the highest-value item on that out-list and the first thing I would add after v1.

---

### M6 — Member billing

Pro and above (§3.7). A free tenant has one member and nobody to bill.

**In scope**

- Rates:
  - Default hourly rate per aircraft
  - Member-specific rate override for a specific aircraft
  - Rates are effective-dated; a change is a new row, never an edit (§3.7)
- Charge generated server-side on flight log submission: meter hours × resolved rate, snapshotting the amount applied **and which rule supplied it** (§3.7).
- Fuel credit: on a wet-rate aircraft, fuel purchased by a pilot credits against their balance.
- Manual ledger adjustments by an admin, with a reason.
- Member statement: charges, credits, adjustments, balance, for a chosen period.
- "My charges" for a pilot — **their own rows only** (§4.4, open decision 3).
- Admin view of all member balances.
- CSV export of a statement.

**Rules**

- Money is integer minor units. Charges are append-only; a correction is a reversing entry (§3.7).
- **v1 produces statements. It does not move money.** No card processing, no ACH, no payment recording beyond a manual adjustment. The treasurer settles by whatever they use today.

**Out:** payment processing, dues and fixed monthly fees, per-flight surcharges or landing fees, tax handling, PDF statements, emailed statements, split billing between multiple pilots on one flight, aircraft cost/expense tracking.

Recording an offline payment ("Dave paid $400 by check") is a manual adjustment in v1. That works, and it is the smallest thing that makes the ledger balance.

---

### M7 — Platform billing and entitlements

**In scope**

- Three plans: Free, Pro, Enterprise, as rows (§4.3).
- Quota enforcement at creation via `assert_quota` with a row lock (§4.5): `aircraft.active`, `members.active`.
- Entitlement resolution: tenant override → plan → global default (§1.4).
- The client fetches resolved entitlements; nothing is hardcoded in a shipped build (§8.1).
- Stripe Checkout on the **web only** for upgrade (§8.3).
- Stripe webhooks → subscription status → plan.
- Downgrade: takes effect at period end; blocks new creates while over quota; the tenant chooses what to archive (§5).
- Billing portal link for card and invoice management, web only.

**Out for v1:** the 14-day auto-archive timer in §5.4. v1 blocks creates and waits for the tenant to remediate, indefinitely. Automatic archiving is real machinery for a problem that won't exist until there are enough customers to have one, and getting it wrong destroys customer data. The policy stays in CLAUDE.md as the intended behavior; the timer comes later.

**Also out:** annual plans, discounts, coupons, trials, proration, in-app purchase of any kind.

---

### M8 — Notifications

Email only in v1. Push notifications require a paid Apple account, APNs setup, and a device registry — all deferred (§8.4).

**In scope:** email verification, invite, password reset, booking confirmation and cancellation, squawk filed (to admins), maintenance due or overdue (to admins, digest), over-quota notice.

**Out:** push, SMS, per-user notification preferences, in-app notification center.

---

### M9 — Control plane

Per CLAUDE.md §7.8, v1 is **reviewed SQL scripts run as `admin_role`**. No UI.

**In scope:** the `admin_role` with per-table policies (§7.1), the metadata/content split (§7.2), tenant lifecycle states (§7.3), `legal_hold` (§7.4), the append-only admin audit log (§7.6), and a scripts directory covering: list tenants with plan and usage; inspect resolved entitlements for a tenant; suspend and unsuspend; apply an entitlement override.

**Out:** the admin web app, metrics dashboards, impersonation (§7.5), self-serve provisioning.

---

## 4. Screens

### Web — admin

Dashboard · Aircraft list and detail · Members · Schedule · Flights · Maintenance · Squawks · Rates · Statements · Settings · Subscription

### Web — pilot

Schedule · My flights · Log flight · Squawks · My charges

### Mobile — pilot only

1. **Schedule** — aircraft calendar, book, my reservations
2. **Log flight** — the screen the product lives or dies on
3. **Aircraft status** — meters, fuel, maintenance due, open squawks, grounded?
4. **Squawks** — report and view
5. **My charges** — current balance and recent flights

Phone layout first. iPad gets the same layout at larger size in v1 — no split view, no multitasking work, no iPad-specific navigation.

---

## 5. Tier matrix

| | Free | Pro | Enterprise |
|---|---|---|---|
| Aircraft | 1 | 1 | unlimited |
| Members | 1 | 5 | unlimited |
| Flight logging | unlimited | unlimited | unlimited |
| Maintenance and squawks | yes | yes | yes |
| Scheduling | — | yes | yes |
| Member billing | — | yes | yes |
| Mobile app | yes | yes | yes |
| History retention | unlimited | unlimited | unlimited |

Free is a complete product for a solo owner. Pro is the product for everyone else. Scheduling and billing arrive together at the second pilot, which is also exactly when they start to mean anything.

---

## 6. Build order

Each milestone ends in something demonstrable. Mobile comes last deliberately: it consumes an API whose rules must be settled first, and a real club can validate the whole product on web before any App Store work begins.

| | Milestone | Done when |
|---|---|---|
| **M0** | Foundation | RLS isolation tests green; `auth` functions; three DB roles |
| **M1** | Identity | Sign up, log in, invite, accept, roles, member list |
| **M2** | Aircraft | Add aircraft with config and meters; presets instantiated |
| **M3** | Flight logging (web) | Log a flight; meters advance; maintenance ticks down |
| **M4** | Maintenance and squawks | Due/overdue status; file and resolve a squawk; grounding works |
| **M5** | Scheduling | Book, conflict prevention, blackouts, grounding blocks booking |
| **M6** | Member billing | Rates, charges, fuel credits, statement, CSV |
| **M7** | Platform billing | Stripe checkout, webhooks, quota enforcement, downgrade block |
| **M8** | Deploy | RDS, hosting, CI/CD via the OIDC role, a real environment |
| **M9** | Mobile | Five screens, offline logging and sync |
| **M10** | Ship | TestFlight with a real club, then App Store |

**M3 before M5** is deliberate. Flight logging is the core loop and it works without scheduling; scheduling without logging is just a calendar. If the project stalls partway, stopping after M4 leaves a genuinely useful free-tier product.

---

## 7. Explicitly not in v1

Collected for one place to point at when the question comes up.

**Domain:** flight schools and training records · instructor scheduling · pilot logbooks and currency · recurring reservations · waitlists · calendar sync · parts and work orders · AD/SB tracking · document storage · aircraft expense tracking · dues and fixed fees · payment processing · split billing · leaseback record linking

**Platform:** push notifications · SSO and SAML · 2FA · API access for tenants · webhooks for tenants · admin web UI · impersonation · Android · iPad-specific layouts · offline booking · multi-currency · non-English

**A note on offline:** offline is for **logging**, not booking. Logging is append-only and safe to queue; a booking made offline can't check for conflicts and would create double-bookings. Mobile requires connectivity to reserve.

---

## 8. Open questions

Carried from CLAUDE.md §10, restated where v1 forces a call:

1. **Row scoping for `charges`** — a pilot must see only their own ledger. Needs a `scope` dimension in the permission model. **Blocking for M6.**
2. **`member_credentials`** — keep two dates as a booking gate, or drop for v1? Currently written as in-scope-if-kept. **Decide before M5.**
3. **Statements only, no money movement** — recommended and assumed throughout M6. Confirm.
4. **Pro → Enterprise gap** — one aircraft to unlimited, with nothing between. A three-aircraft club has nowhere to land. Pricing, not architecture; a middle tier is rows in `plans`.
5. **Business entity and D-U-N-S** — needed to publish as an organization rather than under a personal name. One to two weeks of lead time, so start it well before M10.
