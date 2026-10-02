-- ===========================================================================
-- 0029_rule_state.sql — one implementation of "how bad is it"
--
-- The companion to 0028, and the same argument. `maintenance_rule_status`
-- decides a rule's state from its remaining and its thresholds; the preview has
-- to decide the same thing for a form nobody has saved, so mockup 03's sticky
-- footer can read "Next due 1,275.0 tach or Dec 2, 2026 · 4.6 hr from now ·
-- Upcoming" before Save is pressed.
--
-- Comparisons drift more slowly than date arithmetic, but they drift the same
-- way and the consequence is identical: a form that promised `upcoming` and
-- saved `due_soon`. §13 asks that the preview match the saved result, so the
-- preview and the view read from one function.
--
-- ---------------------------------------------------------------------------
-- Why tolerance only moves `overdue`
--
-- §4.4's tolerance is permission to keep flying past a due point — a 100-hour
-- may be overflown by ten hours to reach somewhere the work can be done. It is
-- not permission to stop warning: an item three hours past due with seven hours
-- of tolerance left is still the thing a club needs to be getting a shop slot
-- for. So tolerance shifts the line into `overdue` and leaves `due_soon` and
-- `upcoming` where they are, which is why the comparison sits only in the first
-- branch.
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

CREATE FUNCTION public.rule_state(
  p_remaining   numeric,
  p_warn_at     numeric,
  p_critical_at numeric,
  p_tolerance   numeric DEFAULT NULL,
  p_active      boolean DEFAULT true
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN NOT p_active                                        THEN 'inactive'
    -- Nothing to measure against: a rule whose meter has never been read is
    -- not "fine", it is unknown — but `ok` is what the product has always said
    -- here and `ever_complied` is what carries the distinction (§3.6).
    WHEN p_remaining IS NULL                                 THEN 'ok'
    WHEN p_remaining < -coalesce(p_tolerance, 0)             THEN 'overdue'
    WHEN p_remaining <= p_critical_at                        THEN 'due_soon'
    WHEN p_remaining <= p_warn_at                            THEN 'upcoming'
    ELSE 'ok'
  END;
$$;

COMMENT ON FUNCTION public.rule_state(numeric, numeric, numeric, numeric, boolean) IS
  'SPEC §4.4''s four states from a remaining and its thresholds. The one '
  'implementation: `maintenance_rule_status` and the unsaved-form preview both '
  'call it, so a form cannot promise one state and save another.';

REVOKE ALL ON FUNCTION public.rule_state(numeric, numeric, numeric, numeric, boolean)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rule_state(numeric, numeric, numeric, numeric, boolean)
  TO app_role;

-- ---------------------------------------------------------------------------
-- The view now asks the function
--
-- Same columns, same answers; the CASE moves out of the view and into the thing
-- the preview can call too. `CREATE OR REPLACE` because nothing about the
-- column list changes, which keeps `aircraft_availability` and the booking
-- trigger pointing at it throughout.
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

  public.rule_state(r.remaining, r.warn_at, r.critical_at, r.tolerance,
                    r.item_status = 'active') AS state,

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
