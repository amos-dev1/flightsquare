-- ===========================================================================
-- 0024_maintenance_local_dates.sql — a calendar item is due where the
-- aeroplane is, not where the server is
--
-- SPEC §4.2: "Calendar rules evaluate in the aircraft's home time zone (store
-- on aircraft; default to account TZ)." 0022 added `aircraft.timezone` and then
-- went on using bare `current_date`, which is the server's — UTC.
--
-- The gap is not theoretical and it is not small. An annual due 31 March is
-- legal *through* 31 March, which `maintenance_item_status` has always encoded
-- as `due_on < current_date`. With a UTC server and a club in Chicago, UTC
-- rolls to 1 April at 19:00 on the 31st, so for the last five hours of a legal
-- day the aeroplane reads as overdue — and because `grounds_aircraft` is set on
-- an annual, `aircraft_availability` would refuse a booking for an aircraft
-- that is perfectly legal to fly. The same five hours put every "days
-- remaining" figure in the product out by one, every evening.
--
-- This was visible the moment the views were first queried: the demo club's
-- items reported against 2026-10-02 while it was still the 1st in Chicago.
--
-- ---------------------------------------------------------------------------
-- Replaced, not dropped
--
-- Both views keep the same columns in the same order and only their expressions
-- change, so `CREATE OR REPLACE VIEW` is enough. `aircraft_availability` reads
-- `maintenance_item_status` and is left alone — which is the point of replacing
-- rather than dropping: the booking trigger never loses sight of it.
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

COMMENT ON COLUMN public.aircraft.timezone IS
  'Where this aeroplane lives, for the calendar rules in SPEC §4.2. NULL means '
  'the tenant''s zone, which is right for a club whose fleet is on one field '
  'and wrong only for the one that is not.';

-- ---------------------------------------------------------------------------
-- Per-rule status, against the aircraft's own today
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.maintenance_rule_status
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
  r.remaining,

  CASE
    WHEN r.item_status <> 'active'               THEN 'inactive'
    WHEN r.remaining IS NULL                     THEN 'ok'
    WHEN r.remaining < -coalesce(r.tolerance, 0) THEN 'overdue'
    WHEN r.remaining <= r.critical_at            THEN 'due_soon'
    WHEN r.remaining <= r.warn_at                THEN 'upcoming'
    ELSE 'ok'
  END AS state,

  CASE
    WHEN r.kind IN ('cal_month', 'cal_day', 'fixed_date') THEN r.due_on
    WHEN r.per_day IS NULL OR r.per_day <= 0              THEN NULL
    WHEN r.remaining IS NULL                              THEN NULL
    ELSE r.local_today + greatest(ceil(r.remaining / r.per_day), 0)::integer
  END AS projected_date
FROM (
  SELECT
    r.*,
    i.aircraft_id,
    i.status AS item_status,
    CASE WHEN r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
         THEN i.tolerance_hours END AS tolerance,
    z.local_today,
    m.current_value,
    m.per_day,
    CASE r.kind
      WHEN 'cycles'     THEN (r.due_at_cycles - a.cycles)::numeric
      WHEN 'cal_month'  THEN (r.due_on - z.local_today)::numeric
      WHEN 'cal_day'    THEN (r.due_on - z.local_today)::numeric
      WHEN 'fixed_date' THEN (r.due_on - z.local_today)::numeric
      ELSE r.due_at_hours - m.current_value
    END AS remaining
  FROM public.maintenance_item_rules r
  JOIN public.maintenance_items i
    ON i.id = r.maintenance_item_id AND i.tenant_id = r.tenant_id
  JOIN public.aircraft a ON a.id = i.aircraft_id
  JOIN public.tenants tn ON tn.id = i.tenant_id
  CROSS JOIN LATERAL (
    -- The aeroplane's own today. Its zone if it has one, else the club's, else
    -- UTC — and UTC only because a database with no answer has to pick
    -- something, not because it is ever the right answer.
    SELECT (now() AT TIME ZONE coalesce(a.timezone, tn.timezone, 'UTC'))::date
             AS local_today
  ) AS z
  CROSS JOIN LATERAL (
    SELECT
      CASE r.kind
        WHEN 'hobbs_hr'    THEN a.hobbs
        WHEN 'airframe_hr' THEN a.airframe_hours
        WHEN 'tach_hr'     THEN a.tach
      END AS current_value,
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
  'Every rule''s own next due, remaining and state (SPEC §4.2-4.4), measured '
  'against the aircraft''s local today rather than the server''s. Derived, '
  'never stored: it depends on the date and on meters that move underneath it.';

-- ---------------------------------------------------------------------------
-- Per-item status, same correction
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.maintenance_item_status
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

  (i.due_on - z.local_today)            AS days_remaining,
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
JOIN public.tenants tn ON tn.id = i.tenant_id
LEFT JOIN public.aircraft_config cfg ON cfg.aircraft_id = a.id
CROSS JOIN LATERAL (
  SELECT (now() AT TIME ZONE coalesce(a.timezone, tn.timezone, 'UTC'))::date
           AS local_today
) AS z
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
            rs.projected_date NULLS LAST,
            rs.remaining      NULLS LAST,
            rs.rule_id
   LIMIT 1
) AS g ON true;

COMMENT ON VIEW public.maintenance_item_status IS
  'Due resolution for §3.6, across an item''s rules and against the aircraft''s '
  'local today. The item''s state is the worst of them and `governing_rule_id` '
  'names the one deciding it — the number that belongs on the card.';
