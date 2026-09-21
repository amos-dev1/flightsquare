-- ===========================================================================
-- Maintenance: the rest of the core loop, and the signal at the end of it.
--
--   flight logged -> meters advance -> maintenance items tick down
--      -> item comes due, or a squawk grounds the aircraft
--      -> aircraft_availability blocks new reservations
--
-- 090 proved the first arrow. This proves the rest, plus the three things
-- that are expensive to get wrong later: calendar months are counted the way
-- 14 CFR 91.409 counts them, compliance records cannot be edited, and a
-- signed work order cannot be rewritten.
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

-- A C172 with known meters: tach 1100.0, hobbs 1200.0.
INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'N123AB', 'C172');
INSERT INTO public.aircraft_config (aircraft_id, tenant_id, maintenance_meter)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'tach');
INSERT INTO public.meter_readings
  (tenant_id, aircraft_id, hobbs, tach, airframe_hours, recorded_at)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f1',
        1200.0, 1100.0, 1200.0, now() - interval '7 days');

-- ---------------------------------------------------------------------------
-- §3.6: adding an aircraft instantiates the applicable presets — as a copy,
-- never a reference.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  n       integer;
  item    record;
  m       bigint;
BEGIN
  n := public.instantiate_maintenance_templates('01920000-0000-7000-8000-0000000000f1');

  -- The six that apply to a piston airplane and instantiate on their own:
  -- annual, ELT inspection, ELT battery, transponder, pitot-static, oil.
  -- The 100-hour is not among them — 91.409(b) requires it only for hire or
  -- instruction, and inventing one would ground a private aeroplane over an
  -- inspection the FAA never asked for.
  IF n <> 6 THEN
    RAISE EXCEPTION 'instantiation produced % items, expected 6', n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.maintenance_items
              WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
                AND template_code = '100_hour') THEN
    RAISE EXCEPTION 'a 100-hour inspection was invented for a private aircraft';
  END IF;

  -- Idempotent: the club adds the aircraft, then taps the button again.
  n := public.instantiate_maintenance_templates('01920000-0000-7000-8000-0000000000f1');
  IF n <> 0 THEN RAISE EXCEPTION 'seeding twice produced % more items', n; END IF;
  RAISE NOTICE '   ok: the library seeds what applies, once, and invents nothing';

  -- A copy. Editing the tenant's row reaches nothing in the library, and the
  -- library is not reachable from the application at all — which is what
  -- stops one preset edit rewriting thousands of tenants' compliance data.
  UPDATE public.maintenance_items
     SET name = 'Annual inspection (Dave''s shop)', warn_within_days = 60
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'annual';

  SELECT name INTO item FROM public.maintenance_interval_templates
   WHERE code = 'annual' AND version = 1;
  IF item.name <> 'Annual inspection' THEN
    RAISE EXCEPTION 'editing a tenant item reached back into the library';
  END IF;

  SELECT template_code, template_version INTO item
    FROM public.maintenance_items
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'annual';
  IF item.template_version <> 1 THEN
    RAISE EXCEPTION 'the row does not record which template version seeded it';
  END IF;

  -- No foreign key back to the library: provenance, and nothing more.
  SELECT count(*) INTO m
    FROM pg_constraint c
    JOIN pg_class f ON f.oid = c.confrelid
   WHERE c.conrelid = 'public.maintenance_items'::regclass
     AND f.relname = 'maintenance_interval_templates';
  IF m <> 0 THEN
    RAISE EXCEPTION 'maintenance_items references the template library';
  END IF;
  RAISE NOTICE '   ok: instantiated rows are copies, with provenance and no link';
END
$t$;

-- ---------------------------------------------------------------------------
-- What the product does not know, it does not claim.
--
-- §11: do not infer "Airworthy" from the absence of a maintenance warning.
-- A freshly seeded annual has no compliance date behind it, and says so.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.maintenance_item_status
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'annual';

  IF s.ever_complied THEN
    RAISE EXCEPTION 'a seeded item claims a compliance date it never had';
  END IF;
  IF s.due_on <> current_date THEN
    RAISE EXCEPTION 'a seeded annual was dated %, not now', s.due_on;
  END IF;
  IF s.state <> 'due_soon' THEN
    RAISE EXCEPTION 'a seeded annual reads as %, expected due_soon', s.state;
  END IF;
  RAISE NOTICE '   ok: a seeded item is due now and admits it was never recorded';
END
$t$;

-- ---------------------------------------------------------------------------
-- 14 CFR 91.409 counts **calendar** months.
--
-- An annual signed on 14 March 2026 is good through 31 March 2027, not the
-- 14th. Getting this wrong grounds an aircraft a fortnight early — or, far
-- worse, declares an out-of-annual aeroplane airworthy.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE i record;
BEGIN
  INSERT INTO public.compliance_records
    (tenant_id, aircraft_id, maintenance_item_id, kind, title, method,
     complied_on, complied_at_hours, hours_meter, signed_by, signed_certificate,
     recorded_by)
  SELECT '01920000-0000-7000-8000-00000000000a',
         '01920000-0000-7000-8000-0000000000f1', mi.id,
         'inspection', 'Annual inspection', 'inspection',
         DATE '2026-03-14', 1100.0, 'tach', 'D. Mechanic', 'A&P/IA 1234567',
         '01920000-0000-7000-8000-0000000000a2'
    FROM public.maintenance_items mi
   WHERE mi.aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND mi.template_code = 'annual';

  SELECT due_on, last_complied_on INTO i
    FROM public.maintenance_items
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'annual';

  IF i.due_on <> DATE '2027-03-31' THEN
    RAISE EXCEPTION 'an annual signed 2026-03-14 came due %, not 2027-03-31', i.due_on;
  END IF;
  IF i.last_complied_on <> DATE '2026-03-14' THEN
    RAISE EXCEPTION 'the compliance date did not reach the item';
  END IF;
  RAISE NOTICE '   ok: compliance rolls the item forward by calendar months';
END
$t$;

-- ---------------------------------------------------------------------------
-- flight logged -> meters advance -> the item ticks down.
--
-- The oil change is seeded due at the tach reading the aircraft was at, so
-- the first compliance record gives it a real interval to count against.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE s record;
BEGIN
  INSERT INTO public.compliance_records
    (tenant_id, aircraft_id, maintenance_item_id, kind, title,
     complied_on, complied_at_hours, hours_meter, recorded_by)
  SELECT '01920000-0000-7000-8000-00000000000a',
         '01920000-0000-7000-8000-0000000000f1', mi.id,
         'other', 'Oil and filter change', current_date, 1100.0, 'tach',
         '01920000-0000-7000-8000-0000000000a2'
    FROM public.maintenance_items mi
   WHERE mi.aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND mi.template_code = 'oil_change';

  SELECT * INTO s FROM public.maintenance_item_status
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'oil_change';
  IF s.due_at_hours <> 1150.0 OR s.hours_remaining <> 50.0 OR s.state <> 'ok' THEN
    RAISE EXCEPTION 'oil change: due at %, % remaining, state %',
      s.due_at_hours, s.hours_remaining, s.state;
  END IF;

  -- 45 hours flown. Nothing here touches maintenance; the flight does.
  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2', current_date);
  INSERT INTO public.flight_meters (flight_id, tenant_id, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a', 1100.0, 1145.0);

  SELECT * INTO s FROM public.maintenance_item_status
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'oil_change';
  IF s.hours_remaining <> 5.0 OR s.state <> 'due_soon' THEN
    RAISE EXCEPTION 'after the flight: % remaining, state %',
      s.hours_remaining, s.state;
  END IF;
  RAISE NOTICE '   ok: a logged flight ticks the interval down, without being told';

  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2', current_date);
  INSERT INTO public.flight_meters (flight_id, tenant_id, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a', 1145.0, 1155.0);

  SELECT state INTO s FROM public.maintenance_item_status
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'oil_change';
  IF s.state <> 'overdue' THEN
    RAISE EXCEPTION 'an oil change past its hours reads as %', s.state;
  END IF;

  -- And it does not ground anything: an oil change is not airworthiness.
  IF NOT (SELECT available FROM public.aircraft_availability
           WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'an overdue oil change grounded the aircraft';
  END IF;
  RAISE NOTICE '   ok: overdue is not the same as grounded';
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.3: a grounded aircraft blocks new reservations. Two ways in, one view
-- out, and the booking path will never need to know which.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE a record;
BEGIN
  -- Way one: an overdue inspection that grounds.
  UPDATE public.maintenance_items
     SET due_on = current_date - 1
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND template_code = 'annual';

  SELECT * INTO a FROM public.aircraft_availability
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1';
  IF a.available THEN RAISE EXCEPTION 'an out-of-annual aircraft is bookable'; END IF;
  IF NOT (a.grounding_reasons::text LIKE '%Overdue:%Annual%') THEN
    RAISE EXCEPTION 'the reason does not name the inspection: %', a.grounding_reasons;
  END IF;
  RAISE NOTICE '   ok: an overdue annual grounds the aircraft, and says so';

  INSERT INTO public.compliance_records
    (tenant_id, aircraft_id, maintenance_item_id, kind, title,
     complied_on, complied_at_hours, hours_meter, signed_by, recorded_by)
  SELECT '01920000-0000-7000-8000-00000000000a',
         '01920000-0000-7000-8000-0000000000f1', mi.id,
         'inspection', 'Annual inspection', current_date, 1155.0, 'tach',
         'D. Mechanic', '01920000-0000-7000-8000-0000000000a2'
    FROM public.maintenance_items mi
   WHERE mi.aircraft_id = '01920000-0000-7000-8000-0000000000f1'
     AND mi.template_code = 'annual';

  IF NOT (SELECT available FROM public.aircraft_availability
           WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'signing the annual did not return the aircraft to service';
  END IF;
  RAISE NOTICE '   ok: the signoff returns it to service in the same breath';
END
$t$;

-- ---------------------------------------------------------------------------
-- Way two: a squawk. And the deferral, which is the whole reason an MEL
-- exists — a defect that is known, recorded, and flown with deliberately.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE a record;
BEGIN
  INSERT INTO public.squawks
    (id, tenant_id, aircraft_id, summary, details, severity, grounding,
     reported_by, found_on_flight_id)
  VALUES ('01920000-0000-7000-8000-0000000000d1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          'Left brake soft', 'Pedal travels most of the way before it bites.',
          'grounding', true, '01920000-0000-7000-8000-0000000000a2',
          '01920000-0000-7000-8000-0000000000c2');

  SELECT * INTO a FROM public.aircraft_availability
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1';
  IF a.available THEN RAISE EXCEPTION 'a grounding squawk did not ground it'; END IF;
  IF NOT (a.grounding_reasons::text LIKE '%Left brake soft%') THEN
    RAISE EXCEPTION 'the reason does not name the squawk: %', a.grounding_reasons;
  END IF;
  RAISE NOTICE '   ok: a grounding squawk blocks the aircraft, by name';

  -- Deferred under 91.213: the decision that it may fly. Recorded as its own
  -- row, because that record is what gets read back after an accident.
  INSERT INTO public.squawk_deferrals
    (tenant_id, squawk_id, basis, reference, expires_on, note, deferred_by)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000d1', 'far_91_213', NULL,
          current_date + 30, 'Second brake serviceable; placarded.',
          '01920000-0000-7000-8000-0000000000a2');
  UPDATE public.squawks SET status = 'deferred'
   WHERE id = '01920000-0000-7000-8000-0000000000d1';

  IF NOT (SELECT available FROM public.aircraft_availability
           WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'a deferred squawk still grounds the aircraft';
  END IF;

  -- Lifting the deferral grounds it again, and the row that authorised the
  -- flights in between is untouched.
  UPDATE public.squawks SET status = 'open'
   WHERE id = '01920000-0000-7000-8000-0000000000d1';
  IF (SELECT available FROM public.aircraft_availability
       WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'lifting the deferral did not ground it again';
  END IF;
  IF (SELECT count(*) FROM public.squawk_deferrals
       WHERE squawk_id = '01920000-0000-7000-8000-0000000000d1') <> 1 THEN
    RAISE EXCEPTION 'the deferral history did not survive the status change';
  END IF;
  RAISE NOTICE '   ok: a deferral clears the ground and leaves a record that stays';

  UPDATE public.squawks
     SET status = 'resolved', resolved_at = now(),
         resolved_by = '01920000-0000-7000-8000-0000000000a2',
         resolution_note = 'Master cylinder replaced; bled and tested.'
   WHERE id = '01920000-0000-7000-8000-0000000000d1';

  IF NOT (SELECT available FROM public.aircraft_availability
           WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1') THEN
    RAISE EXCEPTION 'resolving the squawk did not return the aircraft to service';
  END IF;
  RAISE NOTICE '   ok: resolving it returns the aircraft to service';
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.6: the records that get subpoenaed cannot be rewritten.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  BEGIN
    UPDATE public.compliance_records SET complied_on = current_date
     WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1';
    RAISE EXCEPTION 'a compliance record was edited';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a compliance record cannot be edited';
  END;

  BEGIN
    DELETE FROM public.compliance_records
     WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1';
    RAISE EXCEPTION 'a compliance record was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a compliance record cannot be deleted';
  END;

  BEGIN
    UPDATE public.squawks SET summary = 'Nothing to see here'
     WHERE id = '01920000-0000-7000-8000-0000000000d1';
    RAISE EXCEPTION 'the reported defect was rewritten';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: what was reported stays what was reported';
  END;

  BEGIN
    UPDATE public.squawk_deferrals SET expires_on = current_date + 365
     WHERE squawk_id = '01920000-0000-7000-8000-0000000000d1';
    RAISE EXCEPTION 'a deferral was extended in place';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: deferral history is append-only';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- A signature is not revisable. The rule depends on the row, so it is a
-- trigger rather than a column grant.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  INSERT INTO public.work_orders
    (id, tenant_id, aircraft_id, reference, description, performed_by,
     performed_on, parts, labor_hours, cost_cents, created_by)
  VALUES ('01920000-0000-7000-8000-0000000000e1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          'WO-2026-0412', 'Replace left brake master cylinder.',
          'Dave''s Aircraft Service', current_date,
          '[{"part_number": "10-63", "description": "Master cylinder", "qty": 1}]'::jsonb,
          2.5, 48750, '01920000-0000-7000-8000-0000000000a1');

  -- Editable while it is open.
  UPDATE public.work_orders SET labor_hours = 3.0
   WHERE id = '01920000-0000-7000-8000-0000000000e1';

  UPDATE public.work_orders
     SET status = 'closed', signoff_name = 'D. Mechanic',
         signoff_certificate = 'A&P 1234567', signoff_kind = 'a_and_p',
         signed_at = now()
   WHERE id = '01920000-0000-7000-8000-0000000000e1';

  BEGIN
    UPDATE public.work_orders SET cost_cents = 1
     WHERE id = '01920000-0000-7000-8000-0000000000e1';
    RAISE EXCEPTION 'a signed work order was edited';
  EXCEPTION WHEN SQLSTATE 'FS409' THEN
    RAISE NOTICE '   ok: a signed work order is closed to edits';
  END;

  -- Half a signature is not a record of anything.
  BEGIN
    INSERT INTO public.work_orders
      (tenant_id, aircraft_id, description, signoff_name)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f1', 'Oil change', 'D. Mechanic');
    RAISE EXCEPTION 'a signoff with no date was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a signature is a person and a date together';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.2's last loose end: engine time since overhaul, which 0006 declared and
-- left NULL with a note saying it arrives with this module.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE a record;
BEGIN
  SELECT engine_hours_since_overhaul INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.engine_hours_since_overhaul IS NOT NULL THEN
    RAISE EXCEPTION 'an engine with no overhaul on record reports % hours since one',
      a.engine_hours_since_overhaul;
  END IF;

  INSERT INTO public.compliance_records
    (tenant_id, aircraft_id, kind, title, complied_on, complied_at_hours,
     hours_meter, signed_by, recorded_by)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1', 'overhaul',
          'Engine overhaul, O-320-E2D', DATE '2024-06-01', 1000.0, 'tach',
          'Western Engines', '01920000-0000-7000-8000-0000000000a2');

  SELECT engine_hours_since_overhaul, tach INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.engine_hours_since_overhaul <> 155.0 THEN
    RAISE EXCEPTION 'tach % against an overhaul at 1000 gives % since overhaul',
      a.tach, a.engine_hours_since_overhaul;
  END IF;

  -- And it keeps up as the aircraft flies.
  INSERT INTO public.meter_readings (tenant_id, aircraft_id, tach, recorded_at)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1', 1200.0, now());

  SELECT engine_hours_since_overhaul INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.engine_hours_since_overhaul <> 200.0 THEN
    RAISE EXCEPTION 'after flying to 1200 tach it reports %',
      a.engine_hours_since_overhaul;
  END IF;
  RAISE NOTICE '   ok: engine time since overhaul is derived, not typed in';
END
$t$;

-- ---------------------------------------------------------------------------
-- §6.1 items 5 and 6, and the thing a view gets wrong silently.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  BEGIN
    INSERT INTO public.squawks
      (tenant_id, aircraft_id, summary, reported_by)
    VALUES ('01920000-0000-7000-8000-00000000000b',
            '01920000-0000-7000-8000-0000000000f1', 'Not mine',
            '01920000-0000-7000-8000-0000000000a2');
    RAISE EXCEPTION 'WITH CHECK did not reject a squawk for tenant B';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN
    RAISE NOTICE '   ok: cannot file a squawk into another tenant';
  END;

  BEGIN
    INSERT INTO public.maintenance_items
      (tenant_id, aircraft_id, name, due_on)
    VALUES ('01920000-0000-7000-8000-00000000000b',
            '01920000-0000-7000-8000-0000000000f1', 'Not mine', current_date);
    RAISE EXCEPTION 'WITH CHECK did not reject an item for tenant B';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN
    RAISE NOTICE '   ok: cannot add a maintenance item to another tenant';
  END;
END
$t$;

-- Tenant B's context, same transaction, same connection.
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
DO $t$
DECLARE
  n bigint;
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_items', 'squawks', 'squawk_deferrals',
                           'work_orders', 'compliance_records'] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION '%: % of tenant A''s rows are visible to tenant B', t, n;
    END IF;
  END LOOP;

  -- The views are the part that fails silently. A view runs with its
  -- **owner's** permissions unless it says otherwise, and the owner here is
  -- the DDL role — so without security_invoker, every booking path in the
  -- product would read every tenant's aircraft.
  SELECT count(*) INTO n FROM public.aircraft_availability;
  IF n <> 0 THEN
    RAISE EXCEPTION 'aircraft_availability leaked % rows across tenants', n;
  END IF;
  SELECT count(*) INTO n FROM public.maintenance_item_status;
  IF n <> 0 THEN
    RAISE EXCEPTION 'maintenance_item_status leaked % rows across tenants', n;
  END IF;
  RAISE NOTICE '   ok: the other tenant sees none of it, views included';
END
$t$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- Structure, outside the transaction, where the grants are real.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  t text;
  v text;
BEGIN
  -- The reloption, not just the behaviour: a view that loses it still
  -- returns rows, just more of them, which is the §1.2 failure mode again.
  FOREACH v IN ARRAY ARRAY['aircraft_availability', 'maintenance_item_status'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v
         AND c.reloptions @> ARRAY['security_invoker=true']
    ) THEN
      RAISE EXCEPTION '%: not security_invoker — it would read every tenant', v;
    END IF;
  END LOOP;
  RAISE NOTICE '   ok: both views run as the caller, so the policies stay in the path';

  -- §7.2: all of this is content. Reaching it takes a time-boxed, logged,
  -- tenant-consented grant, and that mechanism does not exist yet — so the
  -- correct amount of control-plane access is none.
  FOREACH t IN ARRAY ARRAY['maintenance_items', 'squawks', 'squawk_deferrals',
                           'work_orders', 'compliance_records',
                           'maintenance_item_status', 'aircraft_availability'] LOOP
    IF has_any_column_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role can read % — §7.2 puts it in the content tier', t;
    END IF;
  END LOOP;

  -- The library is the exception, and it is the exception because it holds
  -- no customer data at all.
  IF NOT has_table_privilege('admin_role', 'public.maintenance_interval_templates', 'SELECT') THEN
    RAISE EXCEPTION 'admin_role cannot read the preset library';
  END IF;
  RAISE NOTICE '   ok: the control plane reads the library and none of the records';

  -- §3.6, as grants rather than as intentions.
  IF has_table_privilege('app_role', 'public.compliance_records', 'UPDATE')
     OR has_table_privilege('app_role', 'public.compliance_records', 'DELETE') THEN
    RAISE EXCEPTION 'compliance_records is not append-only';
  END IF;
  IF has_table_privilege('app_role', 'public.squawk_deferrals', 'UPDATE')
     OR has_table_privilege('app_role', 'public.squawk_deferrals', 'DELETE') THEN
    RAISE EXCEPTION 'squawk_deferrals is not append-only';
  END IF;
  IF has_column_privilege('app_role', 'public.squawks', 'summary', 'UPDATE') THEN
    RAISE EXCEPTION 'app_role can rewrite what was reported';
  END IF;
  IF has_table_privilege('app_role', 'public.maintenance_items', 'DELETE')
     OR has_table_privilege('app_role', 'public.work_orders', 'DELETE') THEN
    RAISE EXCEPTION 'maintenance records can be hard-deleted — archiving is a status';
  END IF;
  IF has_column_privilege('app_role', 'public.aircraft',
                          'engine_hours_since_overhaul', 'UPDATE') THEN
    RAISE EXCEPTION 'app_role can write engine_hours_since_overhaul, a derived total';
  END IF;
  RAISE NOTICE '   ok: the append-only tables are append-only in the grants';
END
$t$;
