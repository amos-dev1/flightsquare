-- ===========================================================================
-- 0028_next_due_for.sql — one implementation of "when is it next due"
--
-- Two things need this arithmetic and they must never disagree:
--
--   * the trigger, when a completion lands and every rule rolls forward, and
--   * the preview (SPEC §8's `POST /maintenance-items/preview`), which answers
--     the same question for a form nobody has saved — the live "Next due
--     1,275.0 tach or Dec 2, 2026" in mockups 03 and 05.
--
-- §13 requires that "preview matches saved result". The cheapest way to
-- guarantee that is not a test; it is having one function. A second copy in the
-- API would be a second end-of-month rule, a second leap-year edge, and a
-- second place to be wrong about when an aeroplane is out of annual — and the
-- two would agree right up until somebody fixed one of them.
--
-- So the maths comes out of `apply_compliance_to_item` and into a function both
-- callers use. The trigger loses nothing; it gains a name for what it was doing
-- inline.
--
-- ---------------------------------------------------------------------------
-- No time zone argument, deliberately
--
-- The anchor is a plain calendar date — the day the work was signed — and
-- "4 months after 2 August" is the same answer in every zone on earth. Zones
-- matter only to the question of what *today* is, which is where remaining and
-- status are computed, and that is already handled in the views (0024).
-- Passing a zone here would invite the belief that it changes the answer.
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

CREATE FUNCTION public.next_due_for(
  p_kind          text,
  p_every         numeric,
  p_end_of_month  boolean,
  p_anchor_on     date,
  p_anchor_hours  numeric,
  p_anchor_cycles integer
)
RETURNS TABLE (due_on date, due_at_hours numeric, due_at_cycles integer)
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
        THEN p_anchor_hours + p_every
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
  'something a test has to keep catching.';

REVOKE ALL ON FUNCTION public.next_due_for(text, numeric, boolean, date, numeric, integer)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_due_for(text, numeric, boolean, date, numeric, integer)
  TO app_role;

-- ---------------------------------------------------------------------------
-- The trigger now asks the function
--
-- Same behaviour, one less copy of the arithmetic. `next_from` still chooses
-- the anchor — completion, or the due point the work was meant to happen at —
-- and a record that states its own next due still wins outright, because a
-- recurring AD says when it comes back and that is not an interval anything
-- here gets to compute.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.apply_compliance_to_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_item public.maintenance_items;
BEGIN
  IF NEW.maintenance_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_item FROM public.maintenance_items
   WHERE id = NEW.maintenance_item_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.maintenance_items i
     SET last_complied_on     = NEW.complied_on,
         last_complied_hours  = coalesce(NEW.complied_at_hours, i.last_complied_hours),
         last_complied_cycles = coalesce(NEW.complied_at_cycles, i.last_complied_cycles)
   WHERE i.id = NEW.maintenance_item_id;

  UPDATE public.maintenance_item_rules r
     SET due_on        = coalesce(
           CASE WHEN r.kind IN ('cal_month', 'cal_day') THEN NEW.next_due_on END,
           n.due_on, r.due_on),
         due_at_hours  = coalesce(
           CASE WHEN r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
                THEN NEW.next_due_at_hours END,
           n.due_at_hours, r.due_at_hours),
         due_at_cycles = coalesce(n.due_at_cycles, r.due_at_cycles)
    FROM LATERAL public.next_due_for(
           r.kind,
           r.every,
           r.end_of_month,
           /*
             §4.7's `previous_due`: count from where the rule was already due
             rather than from the completion. That is what makes §4.4's
             tolerance honest — a 100-hour overflown by 8 hours to reach a shop
             must not have those 8 hours handed back on the next interval.
           */
           coalesce(CASE WHEN v_item.next_from = 'previous_due'
                         THEN r.due_on END, NEW.complied_on),
           coalesce(CASE WHEN v_item.next_from = 'previous_due'
                         THEN r.due_at_hours END, NEW.complied_at_hours),
           coalesce(CASE WHEN v_item.next_from = 'previous_due'
                         THEN r.due_at_cycles END, NEW.complied_at_cycles)
         ) AS n
   WHERE r.maintenance_item_id = NEW.maintenance_item_id;

  PERFORM public.restate_item_due_points(NEW.maintenance_item_id);
  RETURN NULL;
END
$$;
