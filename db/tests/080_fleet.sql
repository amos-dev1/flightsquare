-- ===========================================================================
-- Aircraft, meters, and the totals derived from them.
--
-- Runs as app_role.
-- ===========================================================================

DO $guard$
BEGIN
  IF current_user <> 'app_role' THEN
    RAISE EXCEPTION 'this test must run as app_role, not %', current_user;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- §6.1 items 5 and 6, and the constraint the product most depends on:
-- registration is unique per tenant, not globally.
-- ---------------------------------------------------------------------------
-- Everything below runs in one transaction and rolls back. app_role holds no
-- DELETE on aircraft and none on meter_readings by design, so a test that
-- commits rows cannot clean up after itself.
BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';
DO $t$
DECLARE n bigint;
BEGIN
  INSERT INTO public.aircraft (id, tenant_id, registration, type_code, home_base)
  VALUES ('01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-00000000000a', 'N123AB', 'C172', 'KPAO');

  SELECT count(*) INTO n FROM public.aircraft;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A sees % aircraft, expected 1', n; END IF;

  -- The same tail number, again, in this tenant: a duplicate.
  BEGIN
    INSERT INTO public.aircraft (tenant_id, registration)
    VALUES ('01920000-0000-7000-8000-00000000000a', 'N123AB');
    RAISE EXCEPTION 'the same registration was accepted twice in one tenant';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok: a registration is unique within its tenant';
  END;

  BEGIN
    INSERT INTO public.aircraft (tenant_id, registration)
    VALUES ('01920000-0000-7000-8000-00000000000b', 'N999ZZ');
    RAISE EXCEPTION 'WITH CHECK did not reject an aircraft for tenant B';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: cannot add an aircraft to another tenant';
  END;
END
$t$;

-- The leaseback case, which is why the constraint is not global: the owner
-- tracks maintenance and expenses while the club schedules the same airframe.
-- Two real records against N123AB, and neither is a duplicate of the other.
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
DO $t$
DECLARE n bigint;
BEGIN
  INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
  VALUES ('01920000-0000-7000-8000-0000000000f2',
          '01920000-0000-7000-8000-00000000000b', 'N123AB', 'C172');

  SELECT count(*) INTO n FROM public.aircraft;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant B should see only its own N123AB'; END IF;

  SELECT count(*) INTO n FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF n <> 0 THEN RAISE EXCEPTION 'tenant A''s aircraft was visible from tenant B'; END IF;
  RAISE NOTICE '   ok: two tenants can track the same tail number (leaseback)';
END
$t$;

-- ---------------------------------------------------------------------------
-- The quota counter follows the fleet.
-- ---------------------------------------------------------------------------
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
DO $t$
DECLARE v_usage bigint;
BEGIN
  SELECT current_value INTO v_usage FROM public.tenant_usage
   WHERE quota_key = 'aircraft.active';
  IF v_usage <> 1 THEN RAISE EXCEPTION 'expected 1 active aircraft, usage says %', v_usage; END IF;

  -- §5.5: archiving is a status, and an archived aircraft keeps its history.
  -- It stops counting against the quota without disappearing.
  UPDATE public.aircraft SET status = 'archived'
   WHERE id = '01920000-0000-7000-8000-0000000000f1';

  SELECT current_value INTO v_usage FROM public.tenant_usage
   WHERE quota_key = 'aircraft.active';
  IF v_usage <> 0 THEN RAISE EXCEPTION 'archiving did not decrement: %', v_usage; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.aircraft
                  WHERE id = '01920000-0000-7000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'the archived aircraft disappeared instead of being archived';
  END IF;
  RAISE NOTICE '   ok: archiving frees the quota and keeps the record';

  -- Put it back: the rest of the file expects a live aircraft.
  UPDATE public.aircraft SET status = 'active'
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
END
$t$;

-- ---------------------------------------------------------------------------
-- Meters: append-only, latest-wins per meter, ordered by when the reading was
-- taken rather than when it arrived.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  a          record;
  v_first_id uuid;
BEGIN
  INSERT INTO public.meter_readings
    (id, tenant_id, aircraft_id, hobbs, tach, airframe_hours, recorded_at, recorded_by)
  VALUES ('01920000-0000-7000-8000-0000000000e1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          1200.4, 1100.2, 1200.4, now() - interval '2 days',
          '01920000-0000-7000-8000-0000000000a1')
  RETURNING id INTO v_first_id;

  SELECT hobbs, tach, airframe_hours INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1200.4 OR a.tach <> 1100.2 THEN
    RAISE EXCEPTION 'totals did not follow the first reading: % / %', a.hobbs, a.tach;
  END IF;

  -- A reading that carries only Hobbs — a fuel stop, say. Tach must keep the
  -- value it already had rather than being blanked.
  INSERT INTO public.meter_readings
    (tenant_id, aircraft_id, hobbs, recorded_at)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          1202.9, now() - interval '1 day');

  SELECT hobbs, tach INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1202.9 THEN RAISE EXCEPTION 'hobbs did not advance: %', a.hobbs; END IF;
  IF a.tach <> 1100.2 THEN RAISE EXCEPTION 'tach was blanked by a hobbs-only reading: %', a.tach; END IF;
  RAISE NOTICE '   ok: each meter advances on its own, and none is blanked';

  -- §8.2: readings arrive out of order. Two pilots fly the same aircraft on
  -- the same afternoon and sync in the wrong sequence; the server orders by
  -- recorded_at, so an older reading arriving late must not roll the meter
  -- backwards.
  INSERT INTO public.meter_readings
    (tenant_id, aircraft_id, hobbs, recorded_at)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          1201.5, now() - interval '36 hours');

  SELECT hobbs INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1202.9 THEN
    RAISE EXCEPTION 'a late-arriving older reading moved the meter to %', a.hobbs;
  END IF;
  RAISE NOTICE '   ok: a reading that arrives late does not roll the meter back';

  -- A correction is a new row pointing at the one it replaces. Both stay.
  INSERT INTO public.meter_readings
    (tenant_id, aircraft_id, hobbs, recorded_at, supersedes_id, note)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          1200.9, now() - interval '2 days', v_first_id, 'transposed digits');

  IF NOT EXISTS (SELECT 1 FROM public.meter_readings WHERE id = v_first_id) THEN
    RAISE EXCEPTION 'the superseded reading was removed instead of superseded';
  END IF;

  BEGIN
    UPDATE public.meter_readings SET hobbs = 1.0 WHERE id = v_first_id;
    RAISE EXCEPTION 'a meter reading was edited';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a correction is a new row; readings are never edited';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- The totals are derived, and the application cannot simply assert them.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    UPDATE public.aircraft SET airframe_hours = 99999
     WHERE id = '01920000-0000-7000-8000-0000000000f1';
    RAISE EXCEPTION 'app_role wrote a derived total directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: totals come from the log, not from an UPDATE';
  END;

  -- The rest of the row is ordinary tenant data and stays editable.
  UPDATE public.aircraft SET home_base = 'KSQL'
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
END
$t$;

-- ---------------------------------------------------------------------------
-- Reference data is shared, readable without tenant context, and not writable.
-- ---------------------------------------------------------------------------
SET LOCAL app.tenant_id = '';
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.aircraft_types;
  IF n = 0 THEN RAISE EXCEPTION 'no aircraft types are seeded'; END IF;

  SELECT count(*) INTO n FROM public.aerodromes WHERE ident = 'KPAO';
  IF n <> 1 THEN RAISE EXCEPTION 'KPAO is missing from the aerodrome seed'; END IF;

  BEGIN
    INSERT INTO public.aircraft_types (code, manufacturer, model, category, engine_type)
    VALUES ('XXXX', 'Nobody', 'Nothing', 'airplane', 'piston');
    RAISE EXCEPTION 'app_role wrote global reference data';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: reference data is readable everywhere and written by migrations';
  END;
END
$t$;

ROLLBACK;
