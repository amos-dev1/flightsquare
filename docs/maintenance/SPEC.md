# FlightSquare — Maintenance Module: Build Spec

Status: final for build · 2026-09-30 · Owner: Amos Savickas

This is the source of truth for the Maintenance module. Mockups in `docs/maintenance/mockups/` are the visual target — match layout, hierarchy, copy and colors. Where this spec and a mockup disagree, this spec wins. Everything here follows the existing rules in the root `CLAUDE.md` (Postgres RLS tenancy, no branching on tenant identity, flags resolve tenant → plan → global, resource + level permissions enforced server-side, feature gate → 404, permission gate → 403).

---

## 1. What the module does

Tracks every recurring maintenance obligation on an aircraft against tach, Hobbs and/or calendar, shows how much time remains, warns as items come due, and can ground the aircraft when a flagged item lapses.

Principles (non-negotiable):

1. **Empty by default.** A new aircraft has zero tracked items. No seeded or demo events. Anything suggested by the app (regulatory, ADs, logbook-derived) needs explicit admin approval, one by one.
2. **The app advises; the A&P/IA decides.** Never say "airworthy" or "legal to fly". Use "tracked as due", "grounded by your settings".
3. **One source of meter truth.** Counters derive from the latest tach/Hobbs readings already captured by post-flight entries. Nobody decrements counters by hand.
4. **Audit everything.** Completions, edits, voids, grounding overrides and suggestion decisions are append-only history with actor + timestamp.

## 2. Phases and build order

Build and ship in order. Each phase is independently shippable. **Start with Phase 1.**

| Phase | Scope |
| --- | --- |
| 1 — Core tracking | Aircraft picker, tracked items with interval rules, counters and projection, status thresholds, ground flag + restriction flag, mark complete / reset, history, pilot read-only view, booking warnings, push + in-app notifications |
| 2 — Records | Attach invoice / logbook-entry photo or PDF to a completion; per-aircraft document storage (S3, tenant-prefixed); expiry reminders for the documents that have one |
| 3 — Regulatory assist | AVIATES starter library as suggestions; aircraft component tree; AD ingest + matching + per-AD compliance status; suggestions inbox |
| 4 — Logbook intelligence | Upload Airframe / Engine / Prop / Avionics logbooks; transcription; "Ask your logbooks" chat; logbook-derived suggestions |

## 3. Roles, permissions, tiers

| Capability | Admin | Pilot | Permission (resource · level) |
| --- | --- | --- | --- |
| Status card, grounded banner, next 5 items | ✓ | ✓ | `maintenance.summary` · read |
| Full item list, item detail, history | ✓ | — | `maintenance.items` · read |
| Add / edit / delete items, mark complete, void completion | ✓ | — | `maintenance.items` · write |
| Grounding override | ✓ | — | `maintenance.items` · write |
| Attach records (P2) | ✓ | — | `maintenance.items` · write (a completion's invoice) |
| Aircraft documents (P2) | ✓ | read | `documents` · write |
| Suggestions inbox (P3/P4) | ✓ | — | `maintenance.suggestions` · write |
| Upload logbooks (P4) | ✓ | — | `logbooks` · write |
| Ask logbooks (P4) | ✓ | account setting, off by default | `logbooks.ask` · read |

Pilot view = **next 5 items + grounded/restriction banners only**. No full list, history, records or notes.

Feature flags / quotas (resolve tenant → plan → global, never by tenant id):

| Key | Free | Pro | Enterprise |
| --- | --- | --- | --- |
| `maintenance.core` | on | on | on |
| `maintenance.items_per_aircraft` (quota) | 10 | unlimited | unlimited |
| ~~`maintenance.records`~~ | — | — | **not built** |
| `maintenance.regulatory_assist` | off | on | on |
| `maintenance.logbooks` | off | off | on |
| `maintenance.logbook_pages_per_aircraft` (quota) | 0 | 0 | 2,000 (tunable) |
| `maintenance.pilots_can_ask_logbooks` (account setting) | — | — | default off |

Downgrade: existing items stay visible and keep counting; only creating beyond quota and gated features lock.

## 4. Domain rules (Phase 1)

### 4.1 Tracked item

A named obligation on one aircraft (optionally one component — engine/prop — once P3 components exist). Fields: name, category (`airframe | engine | prop | avionics | other`), 1–3 interval rules, anchor (last completion), thresholds, `ground_if_overdue` flag, optional `restriction_label` (e.g. "Not for IFR", "Transponder inop"), optional tolerance, `next_from` (`completion` default | `previous_due`), notes, source (`manual | regulatory | ad | logbook`), active.

One-time items (single AD action, deferred repair) = an item with a `fixed_date` or one-shot hour target and no recurrence.

### 4.2 Interval rules

Up to 3 per item, combined **whichever comes first**.

| kind | Input | Next due |
| --- | --- | --- |
| `tach_hr` | every N (0.1 precision) | anchor tach + N |
| `hobbs_hr` | every N | anchor Hobbs + N |
| `cal_month` | every N months, `end_of_month` bool | anchor date + N months; if `end_of_month`, last day of that month |
| `cal_day` | every N days | anchor date + N days |
| `fixed_date` | a date | that date |

Regulatory calendar-month items (annual, ELT, transponder, pitot-static) default `end_of_month = true` (e.g. signed Mar 12 → due Mar 31 next year).

Calendar rules evaluate in the **aircraft's home time zone** (store on aircraft; default to account TZ).

### 4.3 Counters and projection

- Remaining per rule = next due − current value (latest tach / Hobbs reading, or today).
- Item's governing rule = the one that runs out first, normalized by projected date (hour rules projected using usage; if no usage data, hour rules compare by hours only).
- Projection: average tach (or Hobbs) per day over the last 90 days. `projected_date = today + remaining / avg_per_day`. If < 3 flights or < 1.0 hr in 90 days → show "—", never a misleading forecast.
- UI copy: `4.6 hr` + `~5 days` (round: < 14 days → days, < 10 weeks → weeks, else months).

### 4.4 Status

Defaults, editable per item (stored per rule as `warn_at` / `critical_at`):

| Status | Hour rules | Date rules | Effects |
| --- | --- | --- | --- |
| `ok` | > 10 hr | > 30 days | — |
| `upcoming` | ≤ 10 hr | ≤ 30 days | amber in lists; admin weekly digest |
| `due_soon` | ≤ 3 hr | ≤ 7 days | push to admins + pilots with upcoming bookings on this aircraft; aircraft card shows Attention |
| `overdue` | ≤ 0 (beyond tolerance) | past due | red everywhere; daily push to admins |
| grounded | overdue AND `ground_if_overdue` | same | aircraft status `grounded` |

Item status = worst across its rules. Aircraft status = `grounded` > `attention` (any due_soon/overdue or active restriction) > `ok`.

Tolerance: e.g. 100-hour inspection allows 10.0 hr overfly; item isn't overdue until remaining < −tolerance. Hours flown in tolerance count against the next interval (next due computed from the original due point, not the completion).

### 4.5 Grounding

- When a `ground_if_overdue` item goes overdue → create `grounding_event` (cause = item) and set aircraft status `grounded`.
- **Grounded blocks new bookings only.** Existing bookings that fall after the due point are flagged (badge on the booking) and the admin + booked pilot are notified. The app never cancels bookings itself.
- Admin override: requires a typed reason and an expiry datetime; logged; shown on the aircraft card ("Override until …").
- Grounding clears automatically when the causing item is completed (or override expires → re-evaluate).
- `restriction_label` items: when overdue, show the label as a restriction banner on the aircraft card and at booking; do **not** block bookings.

### 4.6 Booking awareness

On create/edit booking, compare booking duration (scheduled block hours) to the smallest hour-based remaining. If booking would cross it: warning "This 3.5 hr booking would take N4521K past its Oil & filter change." Warn only.

### 4.7 Complete & reset

- "Mark complete" sheet prefilled with today, latest tach, latest Hobbs; all editable (work is often logged days later; dates may be in the past).
- Fields: date done, tach, Hobbs, performed by (free text), A&P/IA cert no. (optional), notes, (P2) attachments.
- "Next interval starts from": `completion` (default) | `previous_due`.
- Saving appends a `completion`, sets new anchor, recomputes status, clears grounding if this item caused it. Preview of the new next-due shown before save.
- Completions can be edited or voided (soft, with reason); anchor recomputes from the latest non-voided completion.

### 4.8 Meter edge cases

- **Meter swap:** a `meter_reading` with `source = meter_swap` stores old final + new start; all math uses continuous adjusted time (offset).
- **Out-of-order / late readings:** recompute all statuses; notifications fire once per threshold crossing per item cycle (idempotent; track `last_notified_status` per item).
- **Item edited mid-cycle:** recompute next due from existing anchor; edit recorded in history.
- **Twins:** engine/prop items attach to a component (left/right) so one aircraft can carry two of each (P3; in P1 allow free-text "position" on item).

## 5. Screens (Phase 1 unless noted)

Navigation: the Maintenance tab in the bottom tab bar (Schedule · Flights · Maintenance · Squawks · More).

**Aircraft picker (every maintenance screen):** account with > 1 aircraft → dropdown button (tail number large mono + make/model, chevron). Exactly 1 → same header, no chevron, not tappable. Remember last selected aircraft per user.

1. **Maintenance home — admin** (`01-maintenance-home-admin.html`)
   - Header: aircraft picker, notifications bell with dot.
   - Dark status card: status pill (OK / Attention / Grounded), "Updated after last flight · 2h ago", Tach and Hobbs (mono), "Next due: {item} in {remaining}".
   - Suggestions banner (P3+; hidden when 0 or feature off).
   - Segmented filter: All n / Due soon n / Overdue n. "+ Add" button → Add screen.
   - Item cards sorted by urgency (status, then projected date): name, ground lock icon if flagged, remaining (mono, status color), rule summary, projection or restriction label, progress bar = remaining fraction of the governing interval.
   - Empty state (no items): three actions — "Add an item", "Start with required inspections" (P3; until then hide), "Upload logbooks" (P4; hide until enabled).
2. **Pilot view** (`02-pilot-view-grounded.html`) — picker; red grounded banner with cause and "New bookings are blocked until an admin logs it complete"; Tach/Hobbs card; "Coming up" next 5 items with remaining or Overdue pill; note "Full maintenance records are kept by your account admin"; "Report a squawk" button (existing squawk flow).
3. **Add / edit tracked item** (`03-add-tracked-item.html`) — Cancel / title / Save; name with template chips (Oil change, Annual, 100-hour, ELT, Transponder, Pitot-static, VOR, Magneto, Custom) that prefill rules + defaults; "Applies to" segmented (Airframe / Engine / Prop / Avionics / Other); Interval card: rule rows (type, every N, last completed value), "+ Add rule", "Whichever comes first"; Warnings card (Remind at, Urgent at, Ground-if-overdue switch with helper "Blocks new bookings once overdue", optional restriction label); notes. Sticky dark footer: live preview "Next due {tach} or {date} · {remaining} from now · {status}".
4. **Item detail** (`04-item-detail.html`) — back to aircraft, Edit; title + category/component; countdown ring (remaining fraction, status color) with "hr left" / "days left", status pill, "About N days at current pace", "Avg X tach hr / day, last 90 days"; rules list with next due each, "Governs" tag on governing rule; ground flag; next-from setting; primary "Mark complete"; History list (date · tach · performed by · notes; attachment icon P2). Delete in Edit.
5. **Mark complete** (`05-mark-complete.html`) — modal sheet: Cancel / "Log completion"; item name; Date done, Tach (prefilled, "Latest reading prefilled"), Hobbs, Performed by, cert no.; attach Invoice / Logbook entry tiles (P2 — the two tiles are *kinds*, and each then asks for a *source*: camera, photo library, or a file, because photographing a paper invoice is the common case and a shop emails a PDF); next-from segmented; green preview "Resets to {tach} or {date}, whichever first."; "Save & reset counter".
6. **Suggestions inbox** (P3/P4, `06-suggestions-inbox.html`) — "Nothing is tracked until you approve it."; filter chips All / Required / ADs / Logbook; cards by source:
   - Logbook: evidence snippet + page thumbnail; Decline / Edit / Approve.
   - AD possibly applicable: AD number + subject, match reason, interval, "View on FAA DRS" link; Not applicable / Complied / Track.
   - Required (AVIATES): rule + CFR cite; Decline / Edit / Approve (Approve opens Add prefilled, needs last-completed anchor).
   - Informational (TBO): no ground flag by default.
   - "Dismissed (n)" in header, restorable. If an item already exists for the same thing, the suggestion becomes "Update last completed?" instead of a duplicate.
7. **Logbooks & Ask** (P4, `07-logbooks-ask.html`) — 2×2 shelves (Airframe, Engine, Propeller, Avionics) with page count + state (Transcribed / N entries to review / Transcribing x/y progress / Upload pages); "Ask your logbooks" chat; answers cite entry date + page chip linking to the page image; follow-up action links (e.g. "Suggest a 500-hr inspection item →"); input bar "Ask about {tail}'s logbooks…".

## 6. Visual system (from the mockups)

- Fonts: **IBM Plex Sans** (UI, 400/500/600/700) and **IBM Plex Mono** (all meter values, hours, days, dates in counters; tabular numerals).
- Colors:

| Token | Hex | Use |
| --- | --- | --- |
| ink | `#0F1B2A` | text, dark status card, footer |
| ground | `#F4F5F2` | screen background |
| surface | `#FFFFFF` | cards |
| line | `#DDE1E6` | borders; `#EEF0F2` dividers / track |
| muted | `#4A5566` | secondary text |
| primary | `#1D3A5F` | buttons, links, active tab; tint `#E6EDF6` |
| ok | `#2E7D4F` | OK values / bars; tint `#E6F2EA`, dark text `#1E5A38` |
| upcoming | text `#8A5300`, bar `#D99A1E`, tint `#FFF3D6` |
| due soon | `#C2410C`; pill tint `#FFE4D5` text `#9A3412`; on-dark `#FFB38A` |
| overdue / grounded | `#B42318`; tint `#FDE2E0` |
| attention pill | `#F5B83D` on ink |

- Radii: cards 12–16, pills 999, buttons 10–12. Touch targets ≥ 44 px. Icons: 1.75–2 px stroke line icons. No emoji.
- Status must never be color-only: always pair with a word (Due soon, Overdue, Grounded) or the number.

## 7. Data model (all tenant tables have `tenant_id` + RLS)

| Table | Key columns | Phase |
| --- | --- | --- |
| `meter_reading` | aircraft_id, kind (`tach`/`hobbs`), value numeric(8,1), read_at, source (`flight`/`manual`/`meter_swap`), offset | 1 (likely exists — extend) |
| `tracked_item` | aircraft_id, component_id null, name, category, position, source, ground_if_overdue, restriction_label, tolerance_hr, next_from, notes, active, created_by | 1 |
| `interval_rule` | tracked_item_id, kind, every numeric, end_of_month bool, fixed_date, warn_at, critical_at | 1 |
| `completion` | tracked_item_id, done_on, tach, hobbs, performed_by, cert_no, notes, next_from_used, voided_at, void_reason, created_by | 1 |
| `item_status` | tracked_item_id, per-rule next_due + remaining, governing_rule_id, status, projected_date, last_notified_status, computed_at | 1 (table, recomputed) |
| `grounding_event` | aircraft_id, cause (`item`/`squawk`/`manual`), tracked_item_id, started_at, override_reason, override_until, cleared_at | 1 |
| `item_history` | tracked_item_id, actor, action, before jsonb, after jsonb, at | 1 |
| `attachments` | squawk_id / compliance_record_id / aircraft_document_id (at most one, each a composite FK), storage_key, kind, content_type, byte_size, status | 2 |
| `aircraft_documents` | aircraft_id, kind, title, reference, issued_on, expires_on, supersedes_id, status, notified_state | 2 |
| `aircraft_component` | aircraft_id, parent_id, kind (`airframe`/`engine`/`prop`/`appliance`), make, model, serial, position | 3 |
| `suggestion` | aircraft_id, source (`regulatory`/`ad`/`logbook`), payload jsonb, evidence jsonb, state (`open`/`approved`/`edited`/`declined`), decided_by, decided_at | 3 |
| `interval_library` (global, no tenant) | key, name, rules, applicability flags, cfr_ref, source_doc | 3 |
| `tbo_library` (global) | engine/prop make+model, tbo_hr, tbo_years, source_doc, revision | 3 |
| `ad_document`, `ad_applicability` (global) | ad_number, effective_date, supersedes, full_text, extracted applicability jsonb, recurring, reviewed | 3 |
| `aircraft_ad_status` | aircraft_id, ad_id, state (`na`/`complied`/`recurring`), reason, tracked_item_id | 3 |
| `logbook`, `logbook_page`, `logbook_entry` | book kind, page image key, entry date, tach/TT, text, tags, confidence, embedding | 4 |

Global library tables are read-only to the app role.

### Phase 2 as built — three deviations from the tables above (2026-10-02)

1. **No `maintenance.records` resource.** A completion's invoice is
   `maintenance.items: write` — the invoice *is* the record, and whoever may log
   the work may file what proves it — and aircraft documents use `documents`,
   which has been in the resource list since `0005` and in both role bundles
   since `0027` with nothing using it. A resource nothing else would ever
   reference is a column in the permission model, not a resource.

2. **No feature flag, on any tier.** CLAUDE.md §8.3 is explicit that
   "deliberately crippling the free tier to push people to the web is itself
   grounds for rejection", and a solo owner who cannot keep the invoice for
   their own oil change has a crippled free tier. `storage.bytes` — 1 GiB free,
   25 GiB Pro — is the only limit, and it is already counted and enforced.

3. **`attachment` is not polymorphic.** The `(owner_type, owner_id)` shape above
   cannot carry a foreign key, so nothing would stop a row naming a record in
   another tenant; CLAUDE.md §1.1 makes that unrepresentable with composite
   keys, and three nullable columns with three composite FKs are three
   constraints the database enforces rather than none. A document also turned
   out not to be "the same shape" as a stored object — it has a kind and two
   dates — so it is its own table, and the file points at it.

Pilots read aircraft documents, which SPEC §3's "no records" line above reads
against. A pilot is responsible for the AROW set being aboard and the weight and
balance is operationally theirs; `0027` had already seeded the grant.

## 8. API (illustrative; follow existing API conventions)

```
GET    /aircraft/:id/maintenance/summary          (maintenance.summary:read) status, meters, next 5, banners
GET    /aircraft/:id/maintenance/items            (maintenance.items:read)  ?filter=all|due_soon|overdue
POST   /aircraft/:id/maintenance/items            (write) item + rules + anchor; quota check
GET    /maintenance/items/:itemId                 (read) detail + history
PATCH  /maintenance/items/:itemId                 (write)
DELETE /maintenance/items/:itemId                 (write) soft delete
POST   /maintenance/items/:itemId/completions     (write)
PATCH  /maintenance/completions/:id               (write) edit or void
POST   /maintenance/items/preview                 (write) compute next-due for unsaved form (Add + Complete previews)
POST   /aircraft/:id/grounding/override           (write) reason + until
GET    /aircraft/:id/bookings/check?hours=3.5     booking warning
```

Server computes all statuses; clients never compute due/remaining themselves (they render what the API returns, plus the preview endpoint for forms).

## 9. Jobs and notifications

- **On meter reading / completion / item edit:** recompute that aircraft's `item_status`; evaluate grounding; enqueue notifications for threshold crossings.
- **Hourly job:** re-evaluate date-based rules for all aircraft (per aircraft TZ), override expiries, grounding.
- **Notifications v1: push + in-app only** (email later). Fire once per status crossing per cycle. Recipients: `upcoming` → admins weekly digest; `due_soon` → admins + pilots with bookings on that aircraft in next 14 days; `overdue` → admins daily; grounded / cleared → admins + all pilots on the aircraft; flagged booking → its pilot + admins.

## 10. Regulatory library (Phase 3 content)

Offered only as suggestions; onboarding questions decide applicability (flown IFR? used for hire/instruction? transponder? ELT?). Each needs a last-completed anchor before it counts.

| Item | Rule | Interval | Suggest when | Default flag |
| --- | --- | --- | --- | --- |
| Annual inspection | 14 CFR 91.409(a) | 12 cal months, end of month | always | ground |
| VOR check | 14 CFR 91.171 | 30 days | flown IFR | restriction "Not for IFR (VOR)" |
| 100-hour inspection | 14 CFR 91.409(b) | 100 hr, 10 hr tolerance | for hire / instruction | ground |
| ADs | Part 39 / 91.403 | per AD | via AD lookup | per AD; recurring → ground |
| Transponder check | 14 CFR 91.413 | 24 cal months, end of month | transponder installed | restriction "Transponder" |
| ELT inspection | 14 CFR 91.207(d) | 12 cal months, end of month | ELT installed | ground |
| ELT battery | 14 CFR 91.207(c) | fixed date marked on transmitter (50% useful life) or after 1 hr cumulative use | ELT installed | ground |
| Pitot-static / altimeter | 14 CFR 91.411 | 24 cal months, end of month | IFR in controlled airspace | restriction "Not for IFR" |
| Engine / prop TBO | Manufacturer (Lycoming SI 1009 rev BF Jul 2026; Continental SIL 98-9) | hours + calendar per model | always, informational | none — recommended, not mandatory under Part 91 |
| Recommended (oil, magnetos, vacuum pump, plugs, hoses, compass swing, nav database, registration 7 yr…) | Manufacturer / admin | editable defaults | template chips | none |

## 11. AD lookup (Phase 3)

- No official serial-number AD API exists. FAA DRS is web-only (link target on every AD card).
- **Ingest:** nightly job pulls FAA AD final rules from the Federal Register API (`https://www.federalregister.gov/api/v1/documents.json`, agency `federal-aviation-administration`, type `RULE`, term "Airworthiness Directives"), stores full text, and has an LLM extract structured applicability (makes, models, serial ranges, part numbers), required actions, recurring vs one-time vs terminating. Extraction stored globally once, marked `reviewed` after spot-check.
- **Onboarding prefill:** FAA Releasable Aircraft Database (daily zip, `https://registry.faa.gov/database/ReleasableAircraft.zip`) — N-number → make/model/serial/engine. Load into a global lookup table on a daily job.
- **Match:** structured filter on component make/model → serial range / part number → suggestion "Possibly applicable" with match reason. Admin decides: Not applicable (reason kept) / Complied one-time (date, tach, method, reference) / Track recurring (creates tracked item, ground flag on).
- New matching AD → push to admins. Copy on the AD list: assists, does not replace the owner's and mechanic's AD research.

## 12. Logbooks (Phase 4)

- Upload: camera capture (edge detection, multi-page batch) or PDF, into one of Airframe / Engine (per engine) / Propeller / Avionics. S3, tenant-prefixed; page quota enforced.
- Async per page: OCR + vision LLM → raw text → entry segmentation (date, tach/TT, description, signer, cert no., references) → per-field confidence → tags (inspection, component replaced/overhauled, AD compliance, oil change…). Low confidence → "Review" with the page image side by side.
- Ask: retrieval over entries + page text scoped to one aircraft (optional book); answers only from logbooks, always cite entry date + page; say so when not found.
- Suggestions: latest relevant entry per component + library interval → suggestion (e.g. magnetos replaced at 870.4 tach, now 1,270.4, 500 hr interval → 100 hr remaining). Never auto-create.
- Logbook data never crosses tenants; LLM calls carry only that tenant's content.

## 13. Phase 1 acceptance criteria

- New aircraft shows the empty state; no items exist until an admin adds one.
- Admin can create an item with tach, Hobbs, calendar-month (end-of-month), calendar-day and fixed-date rules, combined whichever-first; preview matches saved result.
- Example must hold: oil change every 50 tach / 4 months, last done 1,225.0 tach on Aug 2 2026, current tach 1,270.4 → next due 1,275.0 or Dec 2 2026, 4.6 hr remaining, status `due_soon`.
- Annual signed Mar 12 2026 → due Mar 31 2027.
- Posting a flight updates remaining and status without manual action; threshold notifications fire once per crossing.
- Flagged item going overdue sets aircraft `grounded`, blocks new bookings, flags (not cancels) later existing bookings, notifies admin + affected pilots; completing it clears grounding.
- Restriction items show their label but never block.
- Mark complete from 1,270.4 on Sep 30 2026 resets oil change to 1,320.4 or Jan 30 2027.
- Voiding the latest completion restores the previous anchor.
- Pilot sees only summary + next 5; pilot calls to item endpoints return 403; maintenance endpoints for a tenant without `maintenance.core` return 404.
- Free tier blocks the 11th item on an aircraft with a clear upgrade message.
- RLS tests: another tenant's items/completions are invisible and unwritable.
- Unit tests cover: end-of-month math (incl. Feb / leap years), whichever-first, tolerance, meter swap offset, projection fallback, time-zone boundaries.
