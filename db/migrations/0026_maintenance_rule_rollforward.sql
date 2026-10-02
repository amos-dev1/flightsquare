-- ===========================================================================
-- 0026_maintenance_rule_rollforward.sql — the two functions that maintain due
-- points now maintain rules
--
-- 0022 moved the intervals onto `maintenance_item_rules` and 0023 carried the
-- existing ones across, but the two functions that *write* due points were left
-- reading the item's interval columns. So:
--
--   * a completion rolled the item forward and left every rule where it was, and
--   * an item instantiated from the template library arrived with no rules at
--     all — which `maintenance_item_status` reads as "nothing governs this", and
--     reports as `ok`.
--
-- `db/tests/100` caught the second one in the sentence it was written for four
-- months ago: "a seeded annual reads as ok, expected due_soon". An annual due
-- today reporting `ok` is the exact failure §1 principle 2 is about — the app
-- making a claim about an aeroplane that nobody checked.
--
-- ---------------------------------------------------------------------------
-- `next_from`, and why it is not a detail
--
-- SPEC §4.7 lets a completion reset the next interval from the completion
-- (default) or from the due point it was meant to happen at. That second option
-- is what makes §4.4's tolerance honest: a 100-hour may be overflown by 10
-- hours to reach a shop, and if the next 100 then counted from the completion,
-- those 10 hours would be a gift the regulation did not give. `previous_due`
-- counts them.
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
-- Roll every rule forward, then restate the item's governing due points
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

  /*
    Each rule from its own anchor.

    `next_from = 'previous_due'` counts from where the rule was already due,
    which is the tolerance case above. It falls back to the completion when the
    rule has no previous due point to count from — a first completion on an item
    somebody added without one.

    A record that states its own next due still wins outright, for both bases: a
    recurring AD says when it comes back, and that is not an interval anything
    here gets to compute.
  */
  UPDATE public.maintenance_item_rules r
     SET due_on = CASE
           WHEN NEW.next_due_on IS NOT NULL
             AND r.kind IN ('cal_month', 'cal_day') THEN NEW.next_due_on
           WHEN r.kind = 'cal_month' THEN
             CASE WHEN r.end_of_month
               -- 14 CFR 91.409 counts *calendar* months: an annual signed on
               -- 14 March 2026 is good until 31 March 2027, not the 14th.
               THEN (date_trunc('month',
                       coalesce(CASE WHEN v_item.next_from = 'previous_due'
                                     THEN r.due_on END, NEW.complied_on)
                       + make_interval(months => r.every::integer))
                     + interval '1 month - 1 day')::date
               ELSE (coalesce(CASE WHEN v_item.next_from = 'previous_due'
                                   THEN r.due_on END, NEW.complied_on)
                     + make_interval(months => r.every::integer))::date
             END
           WHEN r.kind = 'cal_day' THEN
             (coalesce(CASE WHEN v_item.next_from = 'previous_due'
                            THEN r.due_on END, NEW.complied_on)
              + make_interval(days => r.every::integer))::date
           -- A fixed date happens once. Completing it does not schedule another.
           ELSE r.due_on
         END,

         due_at_hours = CASE
           WHEN NEW.next_due_at_hours IS NOT NULL
             AND r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
             THEN NEW.next_due_at_hours
           WHEN r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr')
             AND coalesce(CASE WHEN v_item.next_from = 'previous_due'
                               THEN r.due_at_hours END,
                          NEW.complied_at_hours) IS NOT NULL
             THEN coalesce(CASE WHEN v_item.next_from = 'previous_due'
                                THEN r.due_at_hours END,
                           NEW.complied_at_hours) + r.every
           ELSE r.due_at_hours
         END,

         due_at_cycles = CASE
           WHEN r.kind = 'cycles'
             AND coalesce(CASE WHEN v_item.next_from = 'previous_due'
                               THEN r.due_at_cycles END,
                          NEW.complied_at_cycles) IS NOT NULL
             THEN coalesce(CASE WHEN v_item.next_from = 'previous_due'
                                THEN r.due_at_cycles END,
                           NEW.complied_at_cycles) + r.every::integer
           ELSE r.due_at_cycles
         END
   WHERE r.maintenance_item_id = NEW.maintenance_item_id;

  PERFORM public.restate_item_due_points(NEW.maintenance_item_id);
  RETURN NULL;
END
$$;

/*
  The item's own due columns, restated from its rules.

  They are kept because everything downstream reads them: 0017's notice trigger
  watches them, the partial index is built on them, and the API has returned
  them since 0008. They are now a denormalisation of "the soonest rule", written
  in one place rather than computed in several.
*/
CREATE FUNCTION public.restate_item_due_points(p_item_id uuid)
RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  UPDATE public.maintenance_items i
     SET due_on = (SELECT min(r.due_on) FROM public.maintenance_item_rules r
                    WHERE r.maintenance_item_id = i.id),
         due_at_hours = (SELECT min(r.due_at_hours) FROM public.maintenance_item_rules r
                          WHERE r.maintenance_item_id = i.id),
         due_at_cycles = (SELECT min(r.due_at_cycles) FROM public.maintenance_item_rules r
                           WHERE r.maintenance_item_id = i.id)
   WHERE i.id = p_item_id;
$$;

COMMENT ON FUNCTION public.restate_item_due_points(uuid) IS
  'Writes the soonest of an item''s rules back onto the item, where 0017''s '
  'notice trigger, the due index and the API all still read it.';

REVOKE ALL ON FUNCTION public.restate_item_due_points(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restate_item_due_points(uuid) TO app_role;

-- ---------------------------------------------------------------------------
-- An instantiated item arrives with its rules
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.instantiate_maintenance_templates(p_aircraft_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tenant  uuid;
  v_meter   text;
  v_hours   numeric(10,1);
  v_created integer := 0;
BEGIN
  SELECT a.tenant_id,
         coalesce(cfg.maintenance_meter, 'tach'),
         CASE coalesce(cfg.maintenance_meter, 'tach')
           WHEN 'hobbs'    THEN a.hobbs
           WHEN 'airframe' THEN a.airframe_hours
           ELSE a.tach
         END
    INTO v_tenant, v_meter, v_hours
    FROM public.aircraft a
    LEFT JOIN public.aircraft_config cfg ON cfg.aircraft_id = a.id
   WHERE a.id = p_aircraft_id;

  IF v_tenant IS NULL THEN
    RETURN 0;
  END IF;

  WITH applicable AS (
    SELECT DISTINCT ON (t.code) t.*
      FROM public.maintenance_interval_templates t
      JOIN public.aircraft a ON a.id = p_aircraft_id
      LEFT JOIN public.aircraft_types ty ON ty.code = a.type_code
     WHERE t.auto_instantiate
       AND (t.applies_to = 'all'
         OR (t.applies_to = 'type_code'   AND t.applies_value = a.type_code)
         OR (t.applies_to = 'engine_type' AND t.applies_value = ty.engine_type)
         OR (t.applies_to = 'category'    AND t.applies_value = ty.category))
     ORDER BY t.code, t.version DESC
  ), inserted AS (
    INSERT INTO public.maintenance_items
      (tenant_id, aircraft_id, name, description, regulatory_reference,
       grounds_aircraft, hours_meter, interval_months, interval_hours,
       interval_cycles, warn_within_days, warn_within_hours,
       due_on, due_at_hours, template_code, template_version, category)
    SELECT v_tenant, p_aircraft_id, t.name, t.description, t.regulatory_reference,
           t.grounds_aircraft, t.hours_meter, t.interval_months, t.interval_hours,
           t.interval_cycles, t.warn_within_days, t.warn_within_hours,
           -- Due now and never recorded, which is the honest starting point:
           -- the app has no idea when this aeroplane was last in annual, and
           -- `ever_complied` is what keeps it from implying otherwise.
           CASE WHEN t.interval_months IS NOT NULL THEN current_date END,
           CASE WHEN t.interval_hours  IS NOT NULL THEN v_hours END,
           t.code, t.version,
           CASE WHEN t.applies_to = 'engine_type' THEN 'engine' ELSE 'airframe' END
      FROM applicable t
    ON CONFLICT DO NOTHING
    RETURNING id, template_code, interval_months, interval_hours, interval_cycles,
              warn_within_days, warn_within_hours, due_on, due_at_hours
  ), month_rules AS (
    INSERT INTO public.maintenance_item_rules
      (tenant_id, maintenance_item_id, kind, every, end_of_month,
       due_on, warn_at, critical_at)
    SELECT v_tenant, i.id, 'cal_month', i.interval_months,
           -- The regulatory ones count calendar months (§4.2); an oil change
           -- every four months counts from the day it was done.
           i.template_code IN ('annual', 'elt_inspection', 'elt_battery',
                               'transponder', 'pitot_static'),
           i.due_on, i.warn_within_days, least(i.warn_within_days, 7)
      FROM inserted i WHERE i.interval_months IS NOT NULL
    RETURNING 1
  ), hour_rules AS (
    INSERT INTO public.maintenance_item_rules
      (tenant_id, maintenance_item_id, kind, every,
       due_at_hours, warn_at, critical_at)
    SELECT v_tenant, i.id,
           CASE v_meter WHEN 'hobbs' THEN 'hobbs_hr'
                        WHEN 'airframe' THEN 'airframe_hr'
                        ELSE 'tach_hr' END,
           i.interval_hours, i.due_at_hours,
           i.warn_within_hours, least(i.warn_within_hours, 3.0)
      FROM inserted i WHERE i.interval_hours IS NOT NULL
    RETURNING 1
  ), cycle_rules AS (
    INSERT INTO public.maintenance_item_rules
      (tenant_id, maintenance_item_id, kind, every, warn_at, critical_at)
    SELECT v_tenant, i.id, 'cycles', i.interval_cycles, 25, 10
      FROM inserted i WHERE i.interval_cycles IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_created FROM inserted;

  RETURN v_created;
END
$$;

COMMENT ON FUNCTION public.instantiate_maintenance_templates(uuid) IS
  '§3.6: copies applicable library entries onto an aircraft, with their rules '
  '(§4.2). A copy, never a reference — editing a preset must not rewrite '
  'thousands of tenants'' compliance data. Idempotent via the partial unique '
  'index on (tenant_id, aircraft_id, template_code).';
