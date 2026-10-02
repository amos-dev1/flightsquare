-- ===========================================================================
-- 0031_next_due_scale.sql — the preview and the saved row must read the same,
-- not merely mean the same
--
-- `next_due_for` returned a bare `numeric`, so 1,225.0 + 50 came back as
-- `1275`. The column it is written into is `numeric(10,1)`, which stores and
-- renders `1275.0`. Same number; different string.
--
-- That matters because the two readers are the completion trigger and the
-- unsaved-form preview. A pilot sees "Next due 1275 tach" in mockup 03's
-- footer, presses Save, and the item detail says 1275.0. Nothing is wrong and
-- everything looks slightly off, which is worse than an error — it is the kind
-- of thing that makes somebody check whether the app got the maths right.
--
-- §13 asks that the preview match the saved result. The scale is part of the
-- match.
--
-- Dropped and recreated rather than replaced: a return type cannot be changed
-- in place. `apply_compliance_to_item` calls it from inside a plpgsql body, so
-- the reference resolves at run time and the trigger needs no change.
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

DROP FUNCTION public.next_due_for(text, numeric, boolean, date, numeric, integer);

CREATE FUNCTION public.next_due_for(
  p_kind          text,
  p_every         numeric,
  p_end_of_month  boolean,
  p_anchor_on     date,
  p_anchor_hours  numeric,
  p_anchor_cycles integer
)
-- The scales the rules table holds, so a preview and a saved row are the same
-- string and not merely the same quantity.
RETURNS TABLE (due_on date, due_at_hours numeric(10,1), due_at_cycles integer)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    CASE
      WHEN p_kind = 'cal_month' AND p_anchor_on IS NOT NULL AND p_end_of_month THEN
        -- 14 CFR 91.409 counts *calendar* months: an annual signed on 12 March
        -- 2026 is good until 31 March 2027, not the 12th. Getting this wrong
        -- grounds an aeroplane a fortnight early or — far worse — declares an
        -- out-of-annual aeroplane fit to fly.
        (date_trunc('month', p_anchor_on + make_interval(months => p_every::integer))
         + interval '1 month - 1 day')::date
      WHEN p_kind = 'cal_month' AND p_anchor_on IS NOT NULL THEN
        (p_anchor_on + make_interval(months => p_every::integer))::date
      WHEN p_kind = 'cal_day' AND p_anchor_on IS NOT NULL THEN
        (p_anchor_on + make_interval(days => p_every::integer))::date
      -- A fixed date happens once. Completing it does not schedule another,
      -- which is the whole difference between an ELT battery and an annual.
      ELSE NULL
    END,

    CASE
      WHEN p_kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
        AND p_anchor_hours IS NOT NULL
        THEN (p_anchor_hours + p_every)::numeric(10,1)
      ELSE NULL
    END,

    CASE
      WHEN p_kind = 'cycles' AND p_anchor_cycles IS NOT NULL
        THEN p_anchor_cycles + p_every::integer
      ELSE NULL
    END;
$$;

COMMENT ON FUNCTION public.next_due_for(text, numeric, boolean, date, numeric, integer) IS
  'When a rule comes due again, from an anchor (SPEC §4.2). The one '
  'implementation: the completion trigger and the unsaved-form preview both '
  'call it, so §13''s "preview matches saved result" is structural rather than '
  'something a test has to keep catching — down to the scale it renders at.';

REVOKE ALL ON FUNCTION public.next_due_for(text, numeric, boolean, date, numeric, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_due_for(text, numeric, boolean, date, numeric, integer)
  TO app_role;
