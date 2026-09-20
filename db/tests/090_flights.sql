-- ===========================================================================
-- Flight logging: the core loop, the fuel distinction, and the gap flag.
--
-- Runs as app_role, in one transaction that rolls back.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';

-- An aircraft with a known starting point.
INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'N123AB', 'C172');
INSERT INTO public.meter_readings
  (tenant_id, aircraft_id, hobbs, tach, airframe_hours, recorded_at)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f1',
        1200.0, 1100.0, 1200.0, now() - interval '7 days');

-- ---------------------------------------------------------------------------
-- flight logged -> meters advance. The first arrow, and it is not optional:
-- nothing in this test inserts a meter reading for the flight.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  a       record;
  n       bigint;
  reading record;
BEGIN
  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, departed_from, arrived_at)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2',   -- alice's membership
          current_date, 'KPAO', 'KTRK');

  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a',
          1200.0, 1202.3, 1100.0, 1102.0);

  SELECT hobbs, tach INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1202.3 OR a.tach <> 1102.0 THEN
    RAISE EXCEPTION 'the flight did not advance the meters: % / %', a.hobbs, a.tach;
  END IF;

  SELECT * INTO reading FROM public.meter_readings
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
  IF reading.source <> 'flight' THEN
    RAISE EXCEPTION 'the reading was not attributed to the flight';
  END IF;
  RAISE NOTICE '   ok: logging a flight advances the meters, without being asked to';

  -- §3.4: recorded as read, neither derived from the other. They ran at
  -- different rates — 2.3 Hobbs against 2.0 tach — and both are kept.
  SELECT hobbs_hours, tach_hours INTO a FROM public.flight_meters
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
  IF a.hobbs_hours <> 2.3 OR a.tach_hours <> 2.0 THEN
    RAISE EXCEPTION 'hours were derived wrongly: % / %', a.hobbs_hours, a.tach_hours;
  END IF;
  RAISE NOTICE '   ok: hobbs and tach are kept apart, and the hours are derived';

  SELECT count(*) INTO n FROM public.flights WHERE needs_review;
  IF n <> 0 THEN RAISE EXCEPTION 'a flight that met the meters was flagged'; END IF;
END
$t$;

-- ---------------------------------------------------------------------------
-- §8.2: a start that does not meet the previous end is a **flag**, never a
-- rejection. The gap is usually a maintenance run or an unlogged flight, and
-- refusing the entry would discard that along with the flight nobody would
-- then bother to log.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE f record;
BEGIN
  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2', current_date);

  -- Starts 0.4 above where the last flight left it.
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a',
          1202.7, 1204.0, 1102.4, 1103.5);

  SELECT needs_review, review_reason INTO f FROM public.flights
   WHERE id = '01920000-0000-7000-8000-0000000000c2';

  IF NOT f.needs_review THEN
    RAISE EXCEPTION 'a meter gap was not flagged for review';
  END IF;
  IF f.review_reason NOT LIKE '%1202.7%' OR f.review_reason NOT LIKE '%1202.3%' THEN
    RAISE EXCEPTION 'the flag does not say what the gap was: %', f.review_reason;
  END IF;

  -- And the flight was still recorded, meters and all.
  IF (SELECT hobbs FROM public.aircraft
       WHERE id = '01920000-0000-7000-8000-0000000000f1') <> 1204.0 THEN
    RAISE EXCEPTION 'the flagged flight did not advance the meters';
  END IF;
  RAISE NOTICE '   ok: a meter gap flags the flight and still records it';
END
$t$;

-- ---------------------------------------------------------------------------
-- Fuel is two things, and the schema will not let them be one.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE fuel record;
BEGIN
  INSERT INTO public.flight_fuel
    (flight_id, tenant_id, fuel_remaining_after, fuel_added_qty, fuel_added_cost_cents)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a',
          22.5, 31.4, 20410);   -- $204.10, in minor units

  SELECT * INTO fuel FROM public.flight_fuel
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
  IF fuel.fuel_remaining_after <> 22.5 OR fuel.fuel_added_qty <> 31.4 THEN
    RAISE EXCEPTION 'state and transaction did not survive as separate values';
  END IF;
  IF fuel.currency <> 'USD' THEN RAISE EXCEPTION 'no currency was stored'; END IF;

  -- §3.7 rule 3: integer minor units, never a float. 20410 is exact; 204.10
  -- as a float is not, and this is money that will be disputed.
  IF pg_typeof(fuel.fuel_added_cost_cents)::text <> 'integer' THEN
    RAISE EXCEPTION 'fuel cost is %, not integer minor units',
      pg_typeof(fuel.fuel_added_cost_cents);
  END IF;
  RAISE NOTICE '   ok: fuel state and fuel spend are separate, and money is integer';

  -- A cost with no quantity is not a fuel purchase.
  BEGIN
    INSERT INTO public.flight_fuel
      (flight_id, tenant_id, fuel_added_cost_cents)
    VALUES ('01920000-0000-7000-8000-0000000000c2',
            '01920000-0000-7000-8000-00000000000a', 5000);
    RAISE EXCEPTION 'a fuel cost with no quantity was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a fuel cost without a quantity is refused';
  END;

  -- The record is immutable: a correction is a new flight or a reversing
  -- entry, never an edit to what someone spent.
  BEGIN
    UPDATE public.flight_fuel SET fuel_added_cost_cents = 1
     WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
    RAISE EXCEPTION 'a fuel transaction was edited';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a fuel transaction cannot be edited';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- A flight that advanced no meter is not a flight this product records.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c3',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2', current_date);

  BEGIN
    INSERT INTO public.flight_meters (flight_id, tenant_id, hobbs_start, tach_start)
    VALUES ('01920000-0000-7000-8000-0000000000c3',
            '01920000-0000-7000-8000-00000000000a', 1204.0, 1103.5);
    RAISE EXCEPTION 'a flight with no ending meter was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a flight has to advance a meter to be a flight';
  END;

  BEGIN
    INSERT INTO public.flight_meters (flight_id, tenant_id, hobbs_start, hobbs_end)
    VALUES ('01920000-0000-7000-8000-0000000000c3',
            '01920000-0000-7000-8000-00000000000a', 1204.0, 1203.0);
    RAISE EXCEPTION 'a flight that ran the meter backwards was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a meter cannot end before it started';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- §6.1 item 6, and §7.2: flights are content, not metadata.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  BEGIN
    INSERT INTO public.flights (tenant_id, aircraft_id, flown_by, flight_date)
    VALUES ('01920000-0000-7000-8000-00000000000b',
            '01920000-0000-7000-8000-0000000000f1',
            '01920000-0000-7000-8000-0000000000a2', current_date);
    RAISE EXCEPTION 'WITH CHECK did not reject a flight for tenant B';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN
    RAISE NOTICE '   ok: cannot log a flight into another tenant';
  END;

  -- §4.2: there is no flight quota on any tier, and there is no counter
  -- either. A tenant that hit a cap would stop logging, the meters would go
  -- stale, and every maintenance number would quietly become wrong.
  SELECT count(*) INTO n FROM public.tenant_usage WHERE quota_key LIKE 'flight%';
  IF n <> 0 THEN RAISE EXCEPTION 'something is counting flights'; END IF;
  RAISE NOTICE '   ok: nothing counts flights, on any tier';
END
$t$;

ROLLBACK;

-- The content tier, checked outside the transaction so it reads real grants.
DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['flights', 'flight_meters', 'flight_fuel'] LOOP
    IF has_any_column_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role can read % — §7.2 puts it in the content tier', t;
    END IF;
  END LOOP;
  RAISE NOTICE '   ok: the control plane cannot read flights without a grant';
END
$t$;
