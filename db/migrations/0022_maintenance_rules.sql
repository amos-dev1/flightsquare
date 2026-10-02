-- ===========================================================================
-- 0022_maintenance_rules.sql — an item may be due on more than one basis, and
-- each basis gets to say when
--
-- §3.6 has always said "items can be due on more than one basis at once, and
-- the earliest wins", and 0008 implemented that with three columns on the item:
-- `interval_months`, `interval_hours`, `interval_cycles`. That carries one
-- interval per basis and no way to say *which* basis is the one running out,
-- which is exactly what the maintenance screen has to put on the card.
--
-- `docs/maintenance/SPEC.md` §4.2 wants up to three rules per item, each with
-- its own thresholds, plus two kinds the column model cannot express at all:
-- a plain day count (`cal_day`) and a one-off date (`fixed_date`, for an ELT
-- battery stamped on the transmitter or a deferred AD action).
--
-- So the intervals move to a child table, one row per rule.
--
-- ---------------------------------------------------------------------------
-- `cycles` is kept, though the spec drops it
--
-- The column, the status view and `db/tests/100` all carry it today, and a
-- turbine operator counts cycles the way a piston operator counts hours.
-- Removing a basis the product already supports because a document written for
-- piston singles did not mention it would be a silent regression.
--
-- ---------------------------------------------------------------------------
-- Due points live on the rule; the item keeps the governing one
--
-- Each rule stores its own next due. The item keeps `due_on` / `due_at_hours` /
-- `due_at_cycles` as the *governing* values — the soonest across its rules —
-- because 0017's notice trigger watches them, the API returns them, and the
-- partial index on `(tenant_id, aircraft_id, due_on)` is built on them. Nothing
-- downstream has to learn about rules to keep working.
--
-- ---------------------------------------------------------------------------
-- Status stays a view
--
-- 0008 settled this and wrote down why: "a stored 'overdue' flag is wrong the
-- morning after it is written, and wrong silently." It depends on current_date
-- and on meters that advance underneath it. The spec asks for a recomputed
-- table; what it actually needs from one — the governing rule, a projected
-- date, and a record of what was last notified — is two view columns and a
-- column that already exists (`maintenance_items.notified_state`).
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

-- ---------------------------------------------------------------------------
-- What an item now carries
-- ---------------------------------------------------------------------------

ALTER TABLE public.maintenance_items
  -- SPEC §4.1. Not a component reference: that is Phase 3's `aircraft_component`
  -- and this is the free-text stand-in §4.8 asks for in the meantime, so a twin
  -- can carry "left" and "right" without a tree to hang them on yet.
  ADD COLUMN category text NOT NULL DEFAULT 'other',
  ADD COLUMN position text,

  -- §4.5: an item that restricts rather than grounds. A lapsed pitot-static
  -- check does not stop the aeroplane flying — it stops it flying IFR — and
  -- saying "grounded" would be the app making an airworthiness claim it has no
  -- business making (§1 principle 2).
  ADD COLUMN restriction_label text,

  -- §4.4: a 100-hour may be overflown by up to 10 hours to reach a place where
  -- the work can be done. The hours flown in tolerance count against the next
  -- interval, which is why `next_from` exists below.
  ADD COLUMN tolerance_hours numeric(6,1),

  -- §4.7: whether the next interval runs from the completion or from the due
  -- point it was meant to happen at. Flying 8 hours into a 10-hour tolerance
  -- and then resetting from the completion would quietly gift those 8 hours.
  ADD COLUMN next_from text NOT NULL DEFAULT 'completion';

ALTER TABLE public.maintenance_items
  ADD CONSTRAINT maintenance_items_category_check
    CHECK (category IN ('airframe', 'engine', 'prop', 'avionics', 'other')),
  ADD CONSTRAINT maintenance_items_next_from_check
    CHECK (next_from IN ('completion', 'previous_due')),
  ADD CONSTRAINT maintenance_items_tolerance_check
    CHECK (tolerance_hours IS NULL OR tolerance_hours >= 0);

COMMENT ON COLUMN public.maintenance_items.restriction_label IS
  '§4.5: shown as a restriction when overdue, and never blocks a booking. The '
  'app advises; the A&P decides.';

-- §4.2: calendar rules evaluate where the aeroplane lives, not where the
-- server does. Null means the tenant''s zone, which is where it was until now.
ALTER TABLE public.aircraft ADD COLUMN timezone text;

-- ---------------------------------------------------------------------------
-- The rules
-- ---------------------------------------------------------------------------

CREATE TABLE public.maintenance_item_rules (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),
  maintenance_item_id uuid NOT NULL,

  kind        text NOT NULL,

  -- How much of that basis between completions. Null for `fixed_date`, which
  -- happens once and does not recur.
  every       numeric(8,1),
  -- §4.2: a 12-month annual signed on 12 March is due on 31 March, because
  -- 91.409 counts calendar months. Regulatory items default this on; an oil
  -- change every 4 months does not.
  end_of_month boolean NOT NULL DEFAULT false,
  fixed_date  date,

  -- Where this rule's next due point sits. Rolled forward by
  -- `apply_compliance_to_item` when a completion lands.
  due_on      date,
  due_at_hours numeric(10,1),
  due_at_cycles integer,

  -- §4.4's thresholds, per rule rather than per item: 10 hours of warning on a
  -- 50-hour oil change is a fifth of the interval, and on a 2000-hour overhaul
  -- it is nothing.
  warn_at     numeric(8,1) NOT NULL,
  critical_at numeric(8,1) NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_item_rules_item_fkey
    FOREIGN KEY (tenant_id, maintenance_item_id)
    REFERENCES public.maintenance_items (tenant_id, id),
  CONSTRAINT maintenance_item_rules_tenant_id_key UNIQUE (tenant_id, id),

  CONSTRAINT maintenance_item_rules_kind_check CHECK (kind IN (
    'tach_hr', 'hobbs_hr', 'airframe_hr', 'cycles',
    'cal_month', 'cal_day', 'fixed_date')),

  -- A recurring rule needs an interval; a one-off needs a date. Neither makes
  -- sense without exactly one of them.
  CONSTRAINT maintenance_item_rules_shape_check CHECK (
    CASE kind
      WHEN 'fixed_date' THEN every IS NULL AND fixed_date IS NOT NULL
      ELSE every IS NOT NULL AND every > 0 AND fixed_date IS NULL
    END),

  -- `end_of_month` only means anything to a month count.
  CONSTRAINT maintenance_item_rules_eom_check
    CHECK (NOT end_of_month OR kind = 'cal_month'),

  CONSTRAINT maintenance_item_rules_thresholds_check
    CHECK (warn_at >= critical_at AND critical_at >= 0)
);

-- §6.1 item 4: an index leading with tenant_id.
CREATE INDEX maintenance_item_rules_item_idx
  ON public.maintenance_item_rules (tenant_id, maintenance_item_id);

COMMENT ON TABLE public.maintenance_item_rules IS
  'One row per basis an item is due on (§3.6, SPEC §4.2). Up to three, '
  'combined whichever-comes-first, each with its own due point and its own '
  'warning thresholds.';

ALTER TABLE public.maintenance_item_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_item_rules FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.maintenance_item_rules
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- A rule is a setting, not a record: editing and removing one is ordinary
-- admin work, unlike the compliance history it drives.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.maintenance_item_rules TO app_role;

CREATE TRIGGER maintenance_item_rules_touch
  BEFORE UPDATE ON public.maintenance_item_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Carry the existing intervals across
--
-- Every item written since 0008 has between one and three of the interval
-- columns set. Each becomes a rule, keeping the due point it already had and
-- the item's thresholds, so nothing changes state the moment this runs.
--
-- The old columns stay. Dropping them in the same migration that fills their
-- replacement leaves no way to check the backfill against the source, and
-- §6 makes migrations forward-only — there is no undo to fall back on.
-- ---------------------------------------------------------------------------

INSERT INTO public.maintenance_item_rules
  (tenant_id, maintenance_item_id, kind, every, end_of_month,
   due_on, due_at_hours, due_at_cycles, warn_at, critical_at)
SELECT i.tenant_id, i.id, 'cal_month', i.interval_months,
       -- Regulatory calendar items have always been rolled to the end of the
       -- month by `apply_compliance_to_item`; this records that as a property
       -- of the rule rather than as a fact about the function.
       i.template_code IN ('annual', 'elt_inspection', 'elt_battery',
                           'transponder', 'pitot_static'),
       i.due_on, NULL, NULL,
       i.warn_within_days, least(i.warn_within_days, 7)
  FROM public.maintenance_items i
 WHERE i.interval_months IS NOT NULL;

INSERT INTO public.maintenance_item_rules
  (tenant_id, maintenance_item_id, kind, every,
   due_on, due_at_hours, due_at_cycles, warn_at, critical_at)
SELECT i.tenant_id, i.id,
       -- The item's own meter when it names one, else the aircraft's
       -- configured maintenance meter, else tach — the same coalesce the
       -- status view has always done.
       CASE coalesce(i.hours_meter, cfg.maintenance_meter, 'tach')
         WHEN 'hobbs'    THEN 'hobbs_hr'
         WHEN 'airframe' THEN 'airframe_hr'
         ELSE 'tach_hr'
       END,
       i.interval_hours, NULL, i.due_at_hours, NULL,
       i.warn_within_hours, least(i.warn_within_hours, 3.0)
  FROM public.maintenance_items i
  LEFT JOIN public.aircraft_config cfg ON cfg.aircraft_id = i.aircraft_id
 WHERE i.interval_hours IS NOT NULL;

INSERT INTO public.maintenance_item_rules
  (tenant_id, maintenance_item_id, kind, every,
   due_on, due_at_hours, due_at_cycles, warn_at, critical_at)
SELECT i.tenant_id, i.id, 'cycles', i.interval_cycles,
       NULL, NULL, i.due_at_cycles, 25, 10
  FROM public.maintenance_items i
 WHERE i.interval_cycles IS NOT NULL;

-- An item due on a date with no recurring interval behind it — a one-off, or a
-- row written before this migration with a due point and nothing to roll it
-- forward by. It becomes the fixed-date rule it always was.
INSERT INTO public.maintenance_item_rules
  (tenant_id, maintenance_item_id, kind, fixed_date, due_on,
   warn_at, critical_at)
SELECT i.tenant_id, i.id, 'fixed_date', i.due_on, i.due_on,
       i.warn_within_days, least(i.warn_within_days, 7)
  FROM public.maintenance_items i
 WHERE i.due_on IS NOT NULL
   AND i.interval_months IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.maintenance_item_rules r
                    WHERE r.maintenance_item_id = i.id);

-- Every active item must now be due on something, or it has silently stopped
-- being tracked. `has_a_basis_check` guaranteed that for the columns; this
-- says the backfill carried all of it across.
DO $check$
DECLARE orphaned bigint;
BEGIN
  SELECT count(*) INTO orphaned
    FROM public.maintenance_items i
   WHERE i.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.maintenance_item_rules r
                      WHERE r.maintenance_item_id = i.id);
  IF orphaned > 0 THEN
    RAISE EXCEPTION '% active items came out of the backfill with no rule', orphaned;
  END IF;
END
$check$;

-- ---------------------------------------------------------------------------
-- A fourth state, because "due soon" was carrying two jobs
--
-- SPEC §4.4 separates `upcoming` (amber, in a weekly digest) from `due_soon`
-- (orange, pushed to admins and to pilots who have the aeroplane booked). The
-- old model had one threshold and called everything inside it `due_soon`, so
-- an annual 29 days out shouted as loudly as an oil change 2 hours out.
-- ---------------------------------------------------------------------------

ALTER TABLE public.maintenance_items
  DROP CONSTRAINT IF EXISTS maintenance_items_notified_state_check;
ALTER TABLE public.maintenance_items
  ADD CONSTRAINT maintenance_items_notified_state_check
    CHECK (notified_state IS NULL
           OR notified_state IN ('upcoming', 'due_soon', 'overdue'));

-- ---------------------------------------------------------------------------
-- Per-rule status
--
-- The rule is the thing with a due point, so it is the thing with a state.
-- Mockup 04 shows exactly this: every rule listed with its own next due and
-- its own remaining, and a "Governs" tag on whichever one is deciding.
-- ---------------------------------------------------------------------------

CREATE VIEW public.maintenance_rule_status
WITH (security_invoker = true) AS
SELECT
  r.id        AS rule_id,
  r.tenant_id,
  r.maintenance_item_id,
  r.aircraft_id,
  r.kind,
  r.every,
  r.end_of_month,
  r.due_on,
  r.due_at_hours,
  r.due_at_cycles,
  r.warn_at,
  r.critical_at,
  r.current_value,

  -- How much is left, in the rule's own units. Hours and cycles for the meter
  -- rules, days for the calendar ones — never mixed, because 10 of one is not
  -- 10 of the other.
  r.remaining,

  /*
    Tolerance (§4.4) applies to hour rules only, and only to the question of
    whether the item is *overdue*. A 100-hour with 10 hours of tolerance is
    still inside its allowance at 104 hours flown; it is not "not due", it is
    "due and legal to fly to the shop".
  */
  CASE
    WHEN r.item_status <> 'active'           THEN 'inactive'
    WHEN r.remaining IS NULL                 THEN 'ok'
    WHEN r.remaining < -coalesce(r.tolerance, 0) THEN 'overdue'
    WHEN r.remaining <= r.critical_at        THEN 'due_soon'
    WHEN r.remaining <= r.warn_at            THEN 'upcoming'
    ELSE 'ok'
  END AS state,

  /*
    §4.3: when this rule runs out, at the pace the aeroplane has actually been
    flown. Null for a calendar rule, which does not need predicting, and null
    when there is not enough flying behind it to predict from — the spec is
    explicit that a thin average must show nothing rather than a number
    somebody might plan around.
  */
  CASE
    WHEN r.kind IN ('cal_month', 'cal_day', 'fixed_date') THEN r.due_on
    WHEN r.per_day IS NULL OR r.per_day <= 0              THEN NULL
    WHEN r.remaining IS NULL                              THEN NULL
    ELSE current_date + greatest(ceil(r.remaining / r.per_day), 0)::integer
  END AS projected_date
FROM (
  SELECT
    r.*,
    i.aircraft_id,
    i.status AS item_status,
    CASE WHEN r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
         THEN i.tolerance_hours END AS tolerance,
    m.current_value,
    m.per_day,
    CASE r.kind
      WHEN 'cycles' THEN (r.due_at_cycles - a.cycles)::numeric
      WHEN 'cal_month'  THEN (r.due_on - current_date)::numeric
      WHEN 'cal_day'    THEN (r.due_on - current_date)::numeric
      WHEN 'fixed_date' THEN (r.due_on - current_date)::numeric
      ELSE r.due_at_hours - m.current_value
    END AS remaining
  FROM public.maintenance_item_rules r
  JOIN public.maintenance_items i
    ON i.id = r.maintenance_item_id AND i.tenant_id = r.tenant_id
  JOIN public.aircraft a ON a.id = i.aircraft_id
  CROSS JOIN LATERAL (
    SELECT
      CASE r.kind
        WHEN 'hobbs_hr'    THEN a.hobbs
        WHEN 'airframe_hr' THEN a.airframe_hours
        WHEN 'tach_hr'     THEN a.tach
      END AS current_value,
      /*
        Average per day over the last 90 days, from the append-only log rather
        than from the aircraft's totals — the totals are a single number with
        no history in them.

        Guarded by §4.3's two floors: fewer than three flights, or less than an
        hour flown, and this is null. An aeroplane that flew once in March does
        not get to imply a rate for June.
      */
      (SELECT CASE
                WHEN count(*) FILTER (WHERE mr.flight_id IS NOT NULL) < 3 THEN NULL
                WHEN max(v.value) - min(v.value) < 1.0 THEN NULL
                ELSE (max(v.value) - min(v.value)) / 90.0
              END
         FROM public.meter_readings mr
         CROSS JOIN LATERAL (
           SELECT CASE r.kind
                    WHEN 'hobbs_hr'    THEN mr.hobbs
                    WHEN 'airframe_hr' THEN mr.airframe_hours
                    ELSE mr.tach
                  END AS value
         ) v
        WHERE mr.aircraft_id = i.aircraft_id
          AND mr.recorded_at >= now() - interval '90 days'
          AND v.value IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                           WHERE s.supersedes_id = mr.id)
      ) AS per_day
  ) AS m
) AS r;

COMMENT ON VIEW public.maintenance_rule_status IS
  'Every rule''s own next due, remaining and state (SPEC §4.2-4.4). Derived, '
  'never stored: it depends on current_date and on meters that move underneath '
  'it, so a written-down answer is wrong by the next morning and wrong quietly.';

-- ---------------------------------------------------------------------------
-- Per-item status, resolved across the rules
--
-- The item's state is the worst of its rules, and the governing rule is the one
-- that is driving it — worst state first, then soonest to run out. That is the
-- rule whose remaining goes on the card, because it is the one that will stop
-- the aeroplane.
-- ---------------------------------------------------------------------------

/*
  Dropped and recreated rather than replaced: `CREATE OR REPLACE VIEW` may only
  append columns, and this inserts `category`, `restriction_label` and the
  governing-rule columns among the existing ones. `aircraft_availability` reads
  it, so that goes first and comes back below — unchanged, and recreated here
  rather than left to `CASCADE`, which would drop it quietly and leave the
  booking trigger pointing at nothing.
*/
DROP VIEW public.aircraft_availability;
DROP VIEW public.maintenance_item_status;

CREATE VIEW public.maintenance_item_status
WITH (security_invoker = true) AS
SELECT
  i.id   AS maintenance_item_id,
  i.tenant_id,
  i.aircraft_id,
  i.name,
  i.status,
  i.category,
  i.grounds_aircraft,
  i.restriction_label,
  i.due_on,
  i.due_at_hours,
  i.due_at_cycles,
  m.hours_meter,
  m.current_hours,
  i.template_code,
  i.last_complied_on,
  (i.last_complied_on IS NOT NULL OR i.last_complied_hours IS NOT NULL)
    AS ever_complied,

  (i.due_on - current_date)             AS days_remaining,
  (i.due_at_hours - m.current_hours)    AS hours_remaining,
  (i.due_at_cycles - a.cycles)          AS cycles_remaining,

  g.rule_id      AS governing_rule_id,
  g.kind         AS governing_kind,
  g.remaining    AS governing_remaining,
  g.projected_date,
  coalesce(g.state, CASE WHEN i.status <> 'active' THEN 'inactive' ELSE 'ok' END)
    AS state
FROM public.maintenance_items i
JOIN public.aircraft a ON a.id = i.aircraft_id
LEFT JOIN public.aircraft_config cfg ON cfg.aircraft_id = a.id
CROSS JOIN LATERAL (
  SELECT meter,
         CASE meter
           WHEN 'hobbs'    THEN a.hobbs
           WHEN 'airframe' THEN a.airframe_hours
           ELSE a.tach
         END AS current_hours
    FROM (SELECT coalesce(i.hours_meter, cfg.maintenance_meter, 'tach') AS meter) s
) AS m(hours_meter, current_hours)
LEFT JOIN LATERAL (
  SELECT rs.rule_id, rs.kind, rs.state, rs.remaining, rs.projected_date
    FROM public.maintenance_rule_status rs
   WHERE rs.maintenance_item_id = i.id
   ORDER BY CASE rs.state
              WHEN 'overdue'  THEN 0
              WHEN 'due_soon' THEN 1
              WHEN 'upcoming' THEN 2
              WHEN 'ok'       THEN 3
              ELSE 4
            END,
            -- Within a state, whichever runs out first. Nulls last: a rule
            -- with nothing to measure against cannot be the one governing.
            rs.projected_date NULLS LAST,
            rs.remaining      NULLS LAST,
            rs.rule_id
   LIMIT 1
) AS g ON true;

COMMENT ON VIEW public.maintenance_item_status IS
  'Due resolution for §3.6, now across an item''s rules rather than its '
  'columns. The item''s state is the worst of them and `governing_rule_id` '
  'names the one deciding it — the number that belongs on the card.';

-- ---------------------------------------------------------------------------
-- Availability, back as it was
--
-- Identical to 0011's definition. It is here only because it reads
-- `maintenance_item_status`, which had to be dropped to be reshaped. The
-- override (§4.5) and the restriction label arrive in 0023 — this migration
-- changes what an item is due on, and nothing about what stops an aeroplane.
-- ---------------------------------------------------------------------------

CREATE VIEW public.aircraft_availability
WITH (security_invoker = true) AS
SELECT
  a.id        AS aircraft_id,
  a.tenant_id,
  a.registration,
  a.status    AS aircraft_status,
  g.count     AS grounding_squawks,
  o.count     AS overdue_grounding_items,
  (a.status = 'active' AND g.count = 0 AND o.count = 0) AS available,
  array_remove(
    ARRAY[CASE
            WHEN a.status = 'grounded' THEN 'Grounded by an administrator'
            WHEN a.status <> 'active'  THEN format('Aircraft is %s', a.status)
          END],
    NULL) || g.reasons || o.reasons AS grounding_reasons
FROM public.aircraft a
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format('Grounding squawk: %s', s.summary)
                            ORDER BY s.reported_at), ARRAY[]::text[]) AS reasons
    FROM public.squawks s
   WHERE s.aircraft_id = a.id
     AND s.grounding
     -- A deferral is the decision that it may fly with the defect — that is
     -- what an MEL and 91.213 are for — so only 'open' grounds.
     AND s.status = 'open'
) AS g
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format(CASE WHEN mis.ever_complied
                                        THEN 'Overdue: %s'
                                        ELSE 'Not recorded: %s' END, mis.name)
                            ORDER BY mis.name), ARRAY[]::text[]) AS reasons
    FROM public.maintenance_item_status mis
   WHERE mis.aircraft_id = a.id
     AND mis.grounds_aircraft
     AND mis.state = 'overdue'
) AS o;

COMMENT ON VIEW public.aircraft_availability IS
  '§3.3: the one place that decides whether an aircraft may be booked. Three '
  'ways in — an admin''s grounding, a grounding squawk, an overdue inspection '
  '— and one answer out, so the booking path never has to know which (§6.2).';
