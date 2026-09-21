-- ===========================================================================
-- Member billing: the four rules of §3.7, in the order it puts them.
--
-- The one that matters most is the first: a charge snapshots the rate and
-- never references it, so raising the rate in March leaves February alone.
-- Everything else here is in service of a statement nobody can argue with.
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

BEGIN;
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000a';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice, Admin

-- A wet aircraft billed on Hobbs at $140 an hour, from the first of January.
INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'N123AB', 'C172');
INSERT INTO public.aircraft_config
  (aircraft_id, tenant_id, billing_meter, maintenance_meter, rate_basis)
VALUES ('01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-00000000000a', 'hobbs', 'tach', 'wet');
INSERT INTO public.aircraft_rates
  (tenant_id, aircraft_id, amount_cents, effective_from)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f1', 14000, DATE '2026-01-01');

-- ---------------------------------------------------------------------------
-- The last arrow of the core loop: a flight becomes a charge.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE c record;
BEGIN
  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a3',    -- carol flew it
          DATE '2026-02-14');
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c1',
          '01920000-0000-7000-8000-00000000000a',
          1200.0, 1202.5, 1100.0, 1102.0);

  SELECT * INTO c FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';

  IF c.id IS NULL THEN RAISE EXCEPTION 'logging a flight produced no charge'; END IF;

  -- Billed on Hobbs, which is not the meter maintenance runs on. §3.7 says
  -- that pairing is the common one, and the two columns exist to keep it.
  IF c.meter <> 'hobbs' OR c.meter_hours <> 2.5 THEN
    RAISE EXCEPTION 'billed % hours of %', c.meter_hours, c.meter;
  END IF;

  -- 2.5 hours at $140 is $350.00, in integer minor units and nothing else.
  IF c.amount_cents <> 35000 THEN
    RAISE EXCEPTION 'charged % cents, expected 35000', c.amount_cents;
  END IF;
  IF pg_typeof(c.amount_cents)::text <> 'integer' THEN
    RAISE EXCEPTION 'money is %, not integer minor units', pg_typeof(c.amount_cents);
  END IF;

  -- And it is charged to whoever flew, not to whoever typed it in.
  IF c.membership_id <> '01920000-0000-7000-8000-0000000000a3' THEN
    RAISE EXCEPTION 'the charge went to the wrong member';
  END IF;
  IF c.rate_source <> 'aircraft' THEN
    RAISE EXCEPTION 'the charge does not say which rule priced it';
  END IF;
  RAISE NOTICE '   ok: a logged flight charges whoever flew it, on the billing meter';
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.7 rule 1, which is the whole reason this table has no foreign key to a
-- rate: "When the club raises the rate from $140 to $155 in March,
-- February's flights must still read $140 forever."
-- ---------------------------------------------------------------------------
DO $t$
DECLARE c record;
BEGIN
  INSERT INTO public.aircraft_rates
    (tenant_id, aircraft_id, amount_cents, effective_from)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1', 15500, DATE '2026-03-01');

  SELECT * INTO c FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';

  IF c.rate_cents <> 14000 OR c.amount_cents <> 35000 THEN
    RAISE EXCEPTION 'February was re-priced by a March rate: % cents', c.amount_cents;
  END IF;
  RAISE NOTICE '   ok: raising the rate leaves what is already charged alone';

  -- A March flight gets the March rate, because the chain is dated.
  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a3', DATE '2026-03-15');
  INSERT INTO public.flight_meters (flight_id, tenant_id, hobbs_start, hobbs_end)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a', 1202.5, 1204.5);

  SELECT * INTO c FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c2';
  IF c.rate_cents <> 15500 OR c.amount_cents <> 31000 THEN
    RAISE EXCEPTION 'the March flight was priced at % cents', c.amount_cents;
  END IF;
  RAISE NOTICE '   ok: a later flight gets the rate in force on its own day';
END
$t$;

-- ---------------------------------------------------------------------------
-- The member-specific override — §3.7's first layer.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE c record;
BEGIN
  INSERT INTO public.member_aircraft_rates
    (tenant_id, membership_id, aircraft_id, amount_cents, effective_from)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000a3',
          '01920000-0000-7000-8000-0000000000f1', 12500, DATE '2026-04-01');

  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c3',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a3', DATE '2026-04-10');
  INSERT INTO public.flight_meters (flight_id, tenant_id, hobbs_start, hobbs_end)
  VALUES ('01920000-0000-7000-8000-0000000000c3',
          '01920000-0000-7000-8000-00000000000a', 1204.5, 1206.5);

  SELECT * INTO c FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c3';
  IF c.rate_cents <> 12500 OR c.rate_source <> 'member' THEN
    RAISE EXCEPTION 'the member rate did not win: % from %', c.rate_cents, c.rate_source;
  END IF;

  -- And the charge says which rule answered, so a statement can explain
  -- itself without anybody going back to the rate tables.
  RAISE NOTICE '   ok: a member rate beats the aircraft rate, and says so';

  -- Somebody else on the same aeroplane still pays the club rate.
  INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-0000000000c4',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2', DATE '2026-04-11');
  INSERT INTO public.flight_meters (flight_id, tenant_id, hobbs_start, hobbs_end)
  VALUES ('01920000-0000-7000-8000-0000000000c4',
          '01920000-0000-7000-8000-00000000000a', 1206.5, 1207.5);

  SELECT * INTO c FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c4';
  IF c.rate_source <> 'aircraft' OR c.rate_cents <> 15500 THEN
    RAISE EXCEPTION 'one member''s rate leaked onto another''s flight';
  END IF;
  RAISE NOTICE '   ok: an override belongs to the member it was written for';
END
$t$;

-- ---------------------------------------------------------------------------
-- Wet and dry — §3.7's other half.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE f record;
BEGIN
  INSERT INTO public.flight_fuel
    (flight_id, tenant_id, fuel_remaining_after, fuel_added_qty, fuel_added_cost_cents)
  VALUES ('01920000-0000-7000-8000-0000000000c3',
          '01920000-0000-7000-8000-00000000000a', 22.5, 31.4, 20410);

  SELECT * INTO f FROM public.fuel_credits
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c3';
  IF f.amount_cents <> 20410 THEN
    RAISE EXCEPTION 'a wet aircraft did not credit the fuel back: %', f.amount_cents;
  END IF;
  RAISE NOTICE '   ok: on a wet rate, fuel a pilot buys comes back to them';

  -- Turn the aeroplane dry and the ledger stops hearing about fuel at all.
  UPDATE public.aircraft_config SET rate_basis = 'dry'
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000000f1';

  INSERT INTO public.flight_fuel
    (flight_id, tenant_id, fuel_added_qty, fuel_added_cost_cents)
  VALUES ('01920000-0000-7000-8000-0000000000c4',
          '01920000-0000-7000-8000-00000000000a', 20.0, 13000);

  IF EXISTS (SELECT 1 FROM public.fuel_credits
              WHERE flight_id = '01920000-0000-7000-8000-0000000000c4') THEN
    RAISE EXCEPTION 'a dry aircraft credited fuel to the ledger';
  END IF;
  RAISE NOTICE '   ok: on a dry rate, fuel is the pilot''s own cost';
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.7 rule 2: append-only. A correction is a reversal and a new charge.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  BEGIN
    UPDATE public.flight_charges SET amount_cents = 1
     WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
    RAISE EXCEPTION 'a charge was edited';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a charge cannot be edited';
  END;

  BEGIN
    DELETE FROM public.flight_charges
     WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
    RAISE EXCEPTION 'a charge was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: a charge cannot be deleted';
  END;

  -- The correction: a reversing entry that names what it undoes and why,
  -- and then whatever the right charge was.
  INSERT INTO public.flight_charges
    (tenant_id, flight_id, membership_id, meter, meter_hours, rate_cents,
     rate_source, rate_basis, amount_cents, reverses_id, reason, created_by)
  SELECT c.tenant_id, c.flight_id, c.membership_id, c.meter, -c.meter_hours,
         c.rate_cents, c.rate_source, c.rate_basis, -c.amount_cents,
         c.id, 'Hobbs was misread; corrected from the tach',
         '01920000-0000-7000-8000-0000000000a2'
    FROM public.flight_charges c
   WHERE c.flight_id = '01920000-0000-7000-8000-0000000000c1'
     AND c.reverses_id IS NULL;

  SELECT count(*) INTO n FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
  IF n <> 2 THEN RAISE EXCEPTION 'the reversal did not leave both rows'; END IF;

  SELECT sum(amount_cents) INTO n FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
  IF n <> 0 THEN RAISE EXCEPTION 'the reversal did not net to nothing: %', n; END IF;
  RAISE NOTICE '   ok: a correction is a reversing entry, and both rows stay';

  -- A reversal without a reason is a line nobody can explain later.
  BEGIN
    INSERT INTO public.flight_charges
      (tenant_id, flight_id, membership_id, meter, meter_hours, rate_cents,
       rate_source, rate_basis, amount_cents, reverses_id)
    SELECT c.tenant_id, c.flight_id, c.membership_id, c.meter, 0, c.rate_cents,
           c.rate_source, c.rate_basis, 0, c.id
      FROM public.flight_charges c
     WHERE c.flight_id = '01920000-0000-7000-8000-0000000000c2' LIMIT 1;
    RAISE EXCEPTION 'an unexplained reversal was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a reversal has to say why';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- §10 decision 3, doing the job it was built for.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.flight_charges;
  IF n < 4 THEN RAISE EXCEPTION 'the admin cannot see the whole ledger'; END IF;
  RAISE NOTICE '   ok: the treasurer reads every row';
END
$t$;

SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';   -- carol, Pilot
DO $t$
DECLARE
  n     bigint;
  mine  bigint;
BEGIN
  SELECT count(*) INTO n FROM public.flight_charges;
  SELECT count(*) INTO mine FROM public.flight_charges
   WHERE membership_id = '01920000-0000-7000-8000-0000000000a3';

  IF n <> mine THEN
    RAISE EXCEPTION 'a pilot sees % charges, of which % are hers', n, mine;
  END IF;
  IF n = 0 THEN RAISE EXCEPTION 'a pilot cannot see her own charges'; END IF;
  RAISE NOTICE '   ok: a pilot reads her own ledger and nobody else''s';

  -- Including the private arrangement behind it: what the club charges is
  -- the price list, and what *Dave* pays is Dave's business.
  SELECT count(*) INTO n FROM public.member_aircraft_rates;
  IF n <> 1 THEN
    RAISE EXCEPTION 'a pilot sees % member rates, expected only her own', n;
  END IF;

  -- The club's price list, though, everybody reads: a pilot deciding
  -- whether to fly needs to know what it costs.
  SELECT count(*) INTO n FROM public.aircraft_rates;
  IF n < 2 THEN RAISE EXCEPTION 'a pilot cannot read the club''s rates'; END IF;
  RAISE NOTICE '   ok: the price list is shared, the arrangement is not';
END
$t$;
ROLLBACK;

-- ---------------------------------------------------------------------------
-- Shape, where the grants are real.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['flight_charges', 'fuel_credits', 'ledger_adjustments',
                           'aircraft_rates', 'member_aircraft_rates'] LOOP
    -- §3.7 rule 2 and rule 4 are both the absence of an UPDATE grant rather
    -- than a convention somebody has to remember.
    IF has_table_privilege('app_role', 'public.' || t, 'UPDATE')
       OR has_table_privilege('app_role', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION '% is not append-only', t;
    END IF;

    -- §7.2: a ledger is what a member paid and when.
    IF has_any_column_privilege('admin_role', 'public.' || t, 'SELECT') THEN
      RAISE EXCEPTION 'admin_role can read % — that is content', t;
    END IF;
  END LOOP;
  RAISE NOTICE '   ok: the ledger is append-only and out of the control plane';
END
$t$;
