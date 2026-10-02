-- ===========================================================================
-- 0034_one_rollforward_row.sql — a completion is one change to the item
--
-- `apply_compliance_to_item` touched `maintenance_items` twice: once to move
-- the anchor, then again — through `restate_item_due_points` — to write back
-- the soonest of the rules. Two statements, so two rows in the history 0032
-- added, and the second one changed no anchor so it was logged as `edited`.
--
-- The log therefore read: somebody edited this annual, moments after it was
-- signed off. Nobody did. And the `rolled_forward` row above it carried the
-- *old* due date in its `after`, because the restatement had not happened yet
-- — so the one row that was correctly labelled was also the one showing a date
-- that was already stale.
--
-- Both come from the same cause: a single logical change written as two
-- statements. So it becomes one. The rules roll forward first, and then the
-- item takes its anchors and its restated due points in a single UPDATE —
-- which is one history row, correctly labelled, with an `after` that is true.
--
-- `restate_item_due_points` stays: the API's edit path still needs it, because
-- there the rules change without any completion to hang the restatement on.
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

  -- The rules first, so the item can take its due points from them below.
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
    -- The table joined to itself: a lateral cannot see the row being updated.
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

  /*
    And the item, once.

    The anchor and the restated due points in a single statement, because they
    are a single change: the work was signed off, so this is when it was done
    and this is when it is next due. Two statements made two history rows, the
    second of them labelled `edited` and attributed to whoever happened to be
    logged in.
  */
  UPDATE public.maintenance_items i
     SET last_complied_on     = NEW.complied_on,
         last_complied_hours  = coalesce(NEW.complied_at_hours, i.last_complied_hours),
         last_complied_cycles = coalesce(NEW.complied_at_cycles, i.last_complied_cycles),
         due_on        = (SELECT min(r.due_on) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id),
         due_at_hours  = (SELECT min(r.due_at_hours) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id),
         due_at_cycles = (SELECT min(r.due_at_cycles) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id)
   WHERE i.id = NEW.maintenance_item_id;

  RETURN NULL;
END
$$;
