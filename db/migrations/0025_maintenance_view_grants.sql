-- ===========================================================================
-- 0025_maintenance_view_grants.sql — the grants 0022 dropped with the views
--
-- 0022 had to `DROP VIEW` rather than replace, because it inserted columns into
-- the middle of `maintenance_item_status`. A dropped view takes its privileges
-- with it, and `CREATE VIEW` makes a fresh object owned by the migration role
-- with nothing granted on it. So `app_role` lost SELECT on both views, and the
-- new `maintenance_rule_status` never had it.
--
-- Three db suites said so immediately — `100_maintenance`, `130_scheduling` and
-- the fleet checks — all with "permission denied for view". Which is the
-- failure working: the application could not read the thing it reads on every
-- booking, and the tests refused to pretend otherwise.
--
-- Nothing in the data changed. This is the one line per view that 0022 should
-- have carried with the `CREATE`.
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

-- Exactly what 0008 granted, and for the reason it gave: the views are
-- read-only by nature and carry the policies of the tables under them.
-- `admin_role` gets neither, for the same reason it gets no policy on the
-- tables — §7.2 puts maintenance records in the content tier.
GRANT SELECT ON public.maintenance_item_status TO app_role;
GRANT SELECT ON public.aircraft_availability   TO app_role;

-- New in 0022, and never granted at all. Same terms as its neighbours.
GRANT SELECT ON public.maintenance_rule_status TO app_role;
