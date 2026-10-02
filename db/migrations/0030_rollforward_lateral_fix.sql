-- ===========================================================================
-- 0030_rollforward_lateral_fix.sql — an UPDATE cannot lateral-join its own target
--
-- 0028 moved the roll-forward arithmetic into `next_due_for` and had the
-- trigger call it like this:
--
--   UPDATE public.maintenance_item_rules r
--      SET ...
--     FROM LATERAL public.next_due_for(r.kind, r.every, ...) AS n
--
-- Postgres refuses that: the row being updated is not visible to the `FROM`
-- clause, so `r.kind` there is an unresolved reference and the statement raises
-- `invalid reference to FROM-clause entry for table "r"`. The migration applied
-- anyway, because a plpgsql body is parsed and not planned at creation time —
-- the SQL inside it is only resolved the first time it runs.
--
-- Which is to say it was broken from the moment it was written and said nothing
-- until a completion landed. `db/tests/100` landed one on the next run.
--
-- The fix is to join the table to itself: `src` is an ordinary FROM entry, the
-- lateral may reference it, and the update matches back on the id. Same single
-- call to `next_due_for`, same behaviour, and it resolves.
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
           -- A record that states its own next due wins outright: a recurring
           -- AD says when it comes back, and that is not an interval anything
           -- here gets to compute.
           CASE WHEN r.kind IN ('cal_month', 'cal_day') THEN NEW.next_due_on END,
           n.due_on, r.due_on),
         due_at_hours  = coalesce(
           CASE WHEN r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
                THEN NEW.next_due_at_hours END,
           n.due_at_hours, r.due_at_hours),
         due_at_cycles = coalesce(n.due_at_cycles, r.due_at_cycles)
    -- The table joined to itself, because the lateral cannot see `r`.
    FROM public.maintenance_item_rules src
    CROSS JOIN LATERAL public.next_due_for(
           src.kind,
           src.every,
           src.end_of_month,
           /*
             §4.7's `previous_due`: count from where the rule was already due
             rather than from the completion. That is what makes §4.4's
             tolerance honest — a 100-hour overflown by 8 hours to reach a shop
             must not have those 8 hours handed back on the next interval.
           */
           coalesce(CASE WHEN v_item.next_from = 'previous_due'
                         THEN src.due_on END, NEW.complied_on),
           coalesce(CASE WHEN v_item.next_from = 'previous_due'
                         THEN src.due_at_hours END, NEW.complied_at_hours),
           coalesce(CASE WHEN v_item.next_from = 'previous_due'
                         THEN src.due_at_cycles END, NEW.complied_at_cycles)
         ) AS n
   WHERE src.id = r.id
     AND r.maintenance_item_id = NEW.maintenance_item_id;

  PERFORM public.restate_item_due_points(NEW.maintenance_item_id);
  RETURN NULL;
END
$$;
