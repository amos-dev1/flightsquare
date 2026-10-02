-- ===========================================================================
-- 0023_maintenance_rules_backfill.sql — the backfill 0022 could not do
--
-- 0022 created `maintenance_item_rules` and carried every existing item's
-- intervals across. The structures landed; the backfill moved nothing.
--
-- It ran as `flightsquare_owner` with no tenant context, and `maintenance_items`
-- is `FORCE ROW LEVEL SECURITY` with `tenant_id = app.current_tenant_id()`. The
-- owner is not exempt from a forced policy, `current_setting('app.tenant_id',
-- true)` was NULL, the comparison was NULL, and the INSERT … SELECT read zero
-- rows. So did the guard written to catch exactly that, which is why the
-- migration reported success.
--
-- That is §1.1 working as designed — "unset context means zero rows, never all
-- rows" — arriving as a silent no-op rather than an error, which is the whole
-- point of the failure mode and also what makes it easy to miss. §1.1 already
-- says what to do instead, in the sentence about this case:
--
--   "Background jobs, schedulers, and data migrations have no request to
--    inherit context from. They set context explicitly per tenant and loop.
--    They do not run unscoped."
--
-- So this loops. 0022 is left as it is: §6 makes migrations forward-only, and
-- editing an applied one is refused by its checksum — correctly, because the
-- structures it created are right and in use.
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

/*
  Enumerating the tenants is itself a read with no tenant context, and `tenants`
  is forced too. `definer_bootstrap` is the door for precisely that — the owner
  may list tenants while `app.auth_bootstrap` is set — and a per-tenant data
  migration is the same shape of problem as the session lookups it was built
  for: something that must find the tenant before it can act inside one.

  `SET LOCAL`, not `SET` (§1.1). This is one transaction and the setting dies
  with it.
*/
SET LOCAL app.auth_bootstrap = 'on';

DO $backfill$
DECLARE
  t        record;
  inserted bigint := 0;
  total    bigint := 0;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY created_at LOOP
    -- Context for this tenant and no other, set the way every request sets it.
    PERFORM set_config('app.tenant_id', t.id::text, true);

    -- A calendar interval. `end_of_month` is recorded from the item's template
    -- rather than assumed: `apply_compliance_to_item` has always rolled these
    -- to the end of the month, and this writes that down as a property of the
    -- rule instead of a behaviour of the function (§4.2).
    INSERT INTO public.maintenance_item_rules
      (tenant_id, maintenance_item_id, kind, every, end_of_month,
       due_on, warn_at, critical_at)
    SELECT i.tenant_id, i.id, 'cal_month', i.interval_months,
           i.template_code IN ('annual', 'elt_inspection', 'elt_battery',
                               'transponder', 'pitot_static'),
           i.due_on,
           i.warn_within_days, least(i.warn_within_days, 7)
      FROM public.maintenance_items i
     WHERE i.interval_months IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.maintenance_item_rules r
                        WHERE r.maintenance_item_id = i.id
                          AND r.kind = 'cal_month');
    GET DIAGNOSTICS inserted = ROW_COUNT;
    total := total + inserted;

    -- An hour interval, against whichever meter the item names — or the
    -- aircraft's configured maintenance meter, or tach. The same coalesce the
    -- status view has done since 0008.
    INSERT INTO public.maintenance_item_rules
      (tenant_id, maintenance_item_id, kind, every,
       due_at_hours, warn_at, critical_at)
    SELECT i.tenant_id, i.id,
           CASE coalesce(i.hours_meter, cfg.maintenance_meter, 'tach')
             WHEN 'hobbs'    THEN 'hobbs_hr'
             WHEN 'airframe' THEN 'airframe_hr'
             ELSE 'tach_hr'
           END,
           i.interval_hours, i.due_at_hours,
           i.warn_within_hours, least(i.warn_within_hours, 3.0)
      FROM public.maintenance_items i
      LEFT JOIN public.aircraft_config cfg ON cfg.aircraft_id = i.aircraft_id
     WHERE i.interval_hours IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.maintenance_item_rules r
                        WHERE r.maintenance_item_id = i.id
                          AND r.kind IN ('tach_hr', 'hobbs_hr', 'airframe_hr'));
    GET DIAGNOSTICS inserted = ROW_COUNT;
    total := total + inserted;

    INSERT INTO public.maintenance_item_rules
      (tenant_id, maintenance_item_id, kind, every,
       due_at_cycles, warn_at, critical_at)
    SELECT i.tenant_id, i.id, 'cycles', i.interval_cycles, i.due_at_cycles, 25, 10
      FROM public.maintenance_items i
     WHERE i.interval_cycles IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.maintenance_item_rules r
                        WHERE r.maintenance_item_id = i.id AND r.kind = 'cycles');
    GET DIAGNOSTICS inserted = ROW_COUNT;
    total := total + inserted;

    -- A date with no interval behind it: a one-off, or a row that had a due
    -- point and nothing to roll it forward by. It becomes the fixed-date rule
    -- it always was.
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
    GET DIAGNOSTICS inserted = ROW_COUNT;
    total := total + inserted;
  END LOOP;

  RAISE NOTICE 'maintenance rules written: %', total;
END
$backfill$;

/*
  And the check that 0022's could not make.

  Every active item has to be due on something after this, or it has quietly
  stopped being tracked — which would be the worst available outcome for a
  table whose job is to say when an aeroplane is out of annual.

  It loops for the same reason the backfill does. A count taken without context
  is zero, and zero would read as success.
*/
DO $verify$
DECLARE
  t        record;
  orphaned bigint;
  checked  bigint := 0;
BEGIN
  FOR t IN SELECT id FROM public.tenants LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    SELECT count(*) INTO orphaned
      FROM public.maintenance_items i
     WHERE i.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM public.maintenance_item_rules r
                        WHERE r.maintenance_item_id = i.id);
    IF orphaned > 0 THEN
      RAISE EXCEPTION '% active items in tenant % have no rule', orphaned, t.id;
    END IF;

    SELECT count(*) INTO orphaned FROM public.maintenance_items;
    checked := checked + orphaned;
  END LOOP;

  IF checked = 0 THEN
    RAISE WARNING 'no maintenance items were visible in any tenant — '
                  'if that is a surprise, the context loop is not working';
  END IF;
  RAISE NOTICE 'items checked across all tenants: %', checked;
END
$verify$;
