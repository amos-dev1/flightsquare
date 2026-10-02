-- ===========================================================================
-- 0033_availability_left_join.sql — a CROSS JOIN to nothing is nothing
--
-- 0032 added the override lookup to `aircraft_availability` as a
-- `CROSS JOIN LATERAL`, beside the two that were already there. The two that
-- were already there aggregate — `count(*)` always produces exactly one row,
-- even over no rows — so a cross join to them is safe. The new one does not: it
-- is a `SELECT … LIMIT 1` over a table that is empty for every aeroplane that
-- has never been overridden.
--
-- A cross join to zero rows produces zero rows. So every aircraft without an
-- override disappeared from the view, which is every aircraft. The whole fleet
-- went invisible to `GET /availability`, to the maintenance summary, and to the
-- booking trigger — and a booking trigger that finds no row finds nothing to
-- refuse.
--
-- `db/tests/130` said so in one line: "a grounded aircraft was booked".
--
-- `LEFT JOIN LATERAL … ON true` is the shape that was meant: one row either
-- way, with nulls when there is no override. Replaced rather than dropped,
-- since the column list is unchanged.
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

CREATE OR REPLACE VIEW public.aircraft_availability
WITH (security_invoker = true) AS
SELECT
  a.id        AS aircraft_id,
  a.tenant_id,
  a.registration,
  a.status    AS aircraft_status,
  g.count     AS grounding_squawks,
  -- An override does not make the item not overdue — the maintenance screen
  -- goes on saying so — it makes the aeroplane bookable despite it.
  CASE WHEN ov.until IS NULL THEN o.count ELSE 0 END AS overdue_grounding_items,
  (a.status = 'active' AND g.count = 0
     AND (o.count = 0 OR ov.until IS NOT NULL)) AS available,
  array_remove(
    ARRAY[CASE
            WHEN a.status = 'grounded' THEN 'Grounded by an administrator'
            WHEN a.status <> 'active'  THEN format('Aircraft is %s', a.status)
          END],
    NULL)
  || g.reasons
  -- The reasons stay either way. A club calling a member needs to be able to
  -- say what was overridden and until when, not just that it was.
  || CASE WHEN ov.until IS NULL THEN o.reasons
          ELSE ARRAY[format('Override until %s: %s',
                            to_char(ov.until, 'YYYY-MM-DD HH24:MI'), ov.reason)]
               || o.reasons
     END AS grounding_reasons
FROM public.aircraft a
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format('Grounding squawk: %s', s.summary)
                            ORDER BY s.reported_at), ARRAY[]::text[]) AS reasons
    FROM public.squawks s
   WHERE s.aircraft_id = a.id
     AND s.grounding
     -- A deferral is the decision that it may fly with the defect — that is
     -- what an MEL and 91.213 are for — so only 'open' grounds. A squawk is
     -- never overridden by §4.5; it is deferred, which is the same decision
     -- made the way the regulation describes.
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
) AS o
/*
  LEFT, because this one can find nothing.

  The two above aggregate and always return a row. This is a plain `LIMIT 1`
  over a table that is empty for every aeroplane nobody has overridden, and a
  cross join to no rows produces no rows — which took the entire fleet out of
  the view in 0032.
*/
LEFT JOIN LATERAL (
  -- The live override. It expires by itself: nobody has to remember to take it
  -- off, which is why `override_until` is required rather than optional.
  SELECT e.override_until AS until, e.override_reason AS reason
    FROM public.maintenance_grounding_events e
   WHERE e.aircraft_id = a.id
     AND e.cleared_at IS NULL
     AND e.override_until IS NOT NULL
     AND e.override_until > now()
   ORDER BY e.override_until DESC
   LIMIT 1
) AS ov ON true;
