-- ===========================================================================
-- Flight corrections: fixing a number without editing one.
--
-- The claims worth proving, in the order they would hurt if they were wrong:
--
--   1. A correction moves the aeroplane's totals, including *downwards* —
--      which is the first thing in this product that ever has.
--   2. It reverses the money and re-charges at the snapshotted rate.
--   3. A pilot may correct their own flight only while nothing has been flown
--      since; after that the record belongs to an administrator.
--   4. Nothing is ever edited or deleted to make any of it happen.
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
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000a1';   -- alice, Admin

-- A wet aircraft billed on Hobbs at $140 an hour, and a known starting point.
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
INSERT INTO public.meter_readings
  (tenant_id, aircraft_id, hobbs, tach, recorded_at)
VALUES ('01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f1',
        1200.0, 1100.0, now() - interval '7 days');

-- Carol's flight, with a fat-fingered Hobbs: 1212.5 where she meant 1202.5.
INSERT INTO public.flights
  (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at, arrived_at)
VALUES ('01920000-0000-7000-8000-0000000000c1',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000000f1',
        '01920000-0000-7000-8000-0000000000a3',       -- carol's membership
        DATE '2026-02-14', now() - interval '2 days', 'KTRK');
INSERT INTO public.flight_meters
  (flight_id, tenant_id, hobbs_start, hobbs_end, tach_start, tach_end)
VALUES ('01920000-0000-7000-8000-0000000000c1',
        '01920000-0000-7000-8000-00000000000a',
        1200.0, 1212.5, 1100.0, 1102.0);

-- ---------------------------------------------------------------------------
-- A pilot corrects their own latest flight
-- ---------------------------------------------------------------------------
DO $t$
DECLARE a record;
BEGIN
  SELECT hobbs INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1212.5 THEN
    RAISE EXCEPTION 'the mistyped flight did not land: %', a.hobbs;
  END IF;

  -- Carol, a Pilot: `aircraft: read`, so she is nobody's administrator.
  SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';

  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at, arrived_at,
     supersedes_id, correction_reason)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a3',
          DATE '2026-02-14', now() - interval '2 days', 'KTRK',
          '01920000-0000-7000-8000-0000000000c1',
          'Hobbs read 1202.5, not 1212.5');
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c2',
          '01920000-0000-7000-8000-00000000000a',
          1200.0, 1202.5, 1100.0, 1102.0);

  RAISE NOTICE '   ok: a pilot may correct their own latest flight';
END
$t$;

-- ---------------------------------------------------------------------------
-- The totals follow it down.
--
-- The first thing in this product ever to lower a meter. Nothing was deleted
-- and nothing was updated to do it: the superseded flight's reading is still
-- in the log, it has simply stopped being the one that counts.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  a record;
  n bigint;
BEGIN
  SELECT hobbs, tach INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1202.5 THEN
    RAISE EXCEPTION 'the correction did not move the meters: %', a.hobbs;
  END IF;
  RAISE NOTICE '   ok: a correction winds the meters back down';

  SELECT count(*) INTO n FROM public.meter_readings
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the superseded flight lost its reading (% rows)', n;
  END IF;
  RAISE NOTICE '   ok: and the reading it replaced is still in the log';

  /*
    And the correction is not itself flagged for review.

    This is the one that would have made the feature useless. §8.2's gap
    notice compares a start against what the aeroplane is showing — and what
    it was showing was 1212.5, the very number being corrected. A correction
    starting at the true 1200.0 would have tripped it every single time, and
    every correction would have landed in the review queue.

    It does not, because the totals are recomputed when the `flights` row
    lands and before the meters do. By the time the comparison runs, the
    aeroplane reads what it did *before* the flight being corrected — which
    is exactly what a correction's start should be checked against.
  */
  SELECT needs_review INTO STRICT a FROM public.flights
   WHERE id = '01920000-0000-7000-8000-0000000000c2';
  IF a.needs_review THEN
    RAISE EXCEPTION 'the correction was flagged against the figure it corrects';
  END IF;
  RAISE NOTICE '   ok: and the correction is checked against the reading before it';

  -- The superseded flight keeps its own flag, if it had one. Being replaced
  -- is a stronger statement than being cleared, and nothing was edited to
  -- say so — the review queue simply stops returning it.
  IF NOT EXISTS (SELECT 1 FROM public.flights
                  WHERE id = '01920000-0000-7000-8000-0000000000c1') THEN
    RAISE EXCEPTION 'the superseded flight is gone';
  END IF;
END
$t$;

-- ---------------------------------------------------------------------------
-- §3.7 rule 2: the money is reversed, never rewritten.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  original record;
  reversal record;
  fresh    record;
BEGIN
  SELECT * INTO original FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c1'
     AND reverses_id IS NULL;
  SELECT * INTO reversal FROM public.flight_charges
   WHERE reverses_id = original.id;

  IF reversal.id IS NULL THEN
    RAISE EXCEPTION 'the corrected flight''s charge was not reversed';
  END IF;
  IF reversal.amount_cents <> -original.amount_cents THEN
    RAISE EXCEPTION 'the reversal is not the mirror image: % vs %',
                    reversal.amount_cents, original.amount_cents;
  END IF;
  IF reversal.reason IS NULL THEN
    RAISE EXCEPTION 'a reversal with no reason got past the CHECK';
  END IF;
  RAISE NOTICE '   ok: the charge is reversed, with the correction''s reason on it';

  -- 12.5 hours at $140 became 2.5 at $140 — the snapshotted rate, not a
  -- re-resolved one. §3.7 rule 1: February's flight reads February's price
  -- whichever direction the money is going.
  SELECT * INTO fresh FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c2';
  IF fresh.amount_cents <> 35000 OR fresh.rate_cents <> 14000 THEN
    RAISE EXCEPTION 'the corrected charge is wrong: % at %',
                    fresh.amount_cents, fresh.rate_cents;
  END IF;
  IF original.amount_cents + reversal.amount_cents <> 0 THEN
    RAISE EXCEPTION 'the pair does not net to nothing';
  END IF;
  RAISE NOTICE '   ok: and the new charge is 2.5 hours at the rate that applied then';
END
$t$;

-- ---------------------------------------------------------------------------
-- Somebody flies it, and the record stops being the pilot's to change.
--
-- Not a clock. The later flight's Hobbs *start* was read against this one's
-- end, so moving it now moves a number another pilot has already built on.
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';   -- alice
  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at)
  VALUES ('01920000-0000-7000-8000-0000000000c3',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2',       -- alice flew it
          DATE '2026-02-15', now() - interval '1 day');
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end)
  VALUES ('01920000-0000-7000-8000-0000000000c3',
          '01920000-0000-7000-8000-00000000000a', 1202.5, 1204.0);

  SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';   -- carol
  BEGIN
    INSERT INTO public.flights
      (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at,
       supersedes_id, correction_reason)
    VALUES ('01920000-0000-7000-8000-0000000000c4',
            '01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f1',
            '01920000-0000-7000-8000-0000000000a3',
            DATE '2026-02-14', now() - interval '2 days',
            '01920000-0000-7000-8000-0000000000c2',
            'Second thoughts about the tach');
    RAISE EXCEPTION 'a pilot corrected a flight somebody has flown since';
  EXCEPTION WHEN sqlstate 'FS403' THEN
    RAISE NOTICE '   ok: once it has been flown since, a pilot is refused';
  END;

  -- Somebody else's flight is refused whether or not anything is newer.
  BEGIN
    INSERT INTO public.flights
      (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at,
       supersedes_id, correction_reason)
    VALUES ('01920000-0000-7000-8000-0000000000c5',
            '01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f1',
            '01920000-0000-7000-8000-0000000000a2',
            DATE '2026-02-15', now(),
            '01920000-0000-7000-8000-0000000000c3',
            'Not mine to correct');
    RAISE EXCEPTION 'a pilot corrected somebody else''s flight';
  EXCEPTION WHEN sqlstate 'FS403' THEN
    RAISE NOTICE '   ok: and somebody else''s flight is never theirs to correct';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- An administrator may, and that is the whole of the escalation.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE a record;
BEGIN
  SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000a1';   -- alice

  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at,
     supersedes_id, correction_reason)
  VALUES ('01920000-0000-7000-8000-0000000000c4',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a3',
          DATE '2026-02-14', now() - interval '2 days',
          '01920000-0000-7000-8000-0000000000c2',
          'Tach was 1102.4, confirmed against the panel');
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end, tach_start, tach_end)
  VALUES ('01920000-0000-7000-8000-0000000000c4',
          '01920000-0000-7000-8000-00000000000a',
          1200.0, 1202.5, 1100.0, 1102.4);
  RAISE NOTICE '   ok: an administrator may correct it where the pilot could not';

  -- The later flight still rules the Hobbs: correcting a flight in the middle
  -- of the history does not reach past the flights that came after it.
  SELECT hobbs, tach INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1204.0 THEN
    RAISE EXCEPTION 'correcting an earlier flight moved the current Hobbs: %', a.hobbs;
  END IF;
  IF a.tach <> 1102.4 THEN
    RAISE EXCEPTION 'the corrected tach did not take: %', a.tach;
  END IF;
  RAISE NOTICE '   ok: and the later flight keeps the Hobbs it set';
END
$t$;

-- ---------------------------------------------------------------------------
-- A flight that never happened
--
-- The one case a correction cannot express by replacing numbers, so it says
-- so instead. No meters, so no reading and no charge — and the aeroplane
-- falls back to the figure before it.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  a record;
  n bigint;
BEGIN
  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at,
     supersedes_id, correction_reason, logged_in_error)
  VALUES ('01920000-0000-7000-8000-0000000000c6',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2',
          DATE '2026-02-15', now() - interval '1 day',
          '01920000-0000-7000-8000-0000000000c3',
          'Entered twice from the phone', true);

  SELECT hobbs INTO a FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF a.hobbs <> 1202.5 THEN
    RAISE EXCEPTION 'a flight logged in error left the meters where it put them: %',
                    a.hobbs;
  END IF;
  RAISE NOTICE '   ok: a flight logged in error returns the meters to before it';

  SELECT count(*) INTO n FROM public.flight_charges
   WHERE flight_id = '01920000-0000-7000-8000-0000000000c6';
  IF n <> 0 THEN
    RAISE EXCEPTION 'a flight that did not happen was charged for';
  END IF;
  RAISE NOTICE '   ok: and is charged for nothing';
END
$t$;

-- ---------------------------------------------------------------------------
-- Logged against the wrong aeroplane
--
-- The case a field-edit could never express, and the one that most justifies
-- replacing the whole flight. Two aeroplanes' totals move, which is why the
-- correction recomputes the one it came *from* as well as the one it goes to:
-- a recompute keyed only on the new reading would leave the first aeroplane
-- showing hours it never flew, and every maintenance countdown on it would be
-- computed from that number.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  was record;
  now_ record;
BEGIN
  INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
  VALUES ('01920000-0000-7000-8000-0000000000f2',
          '01920000-0000-7000-8000-00000000000a', 'N456CD', 'C172');
  INSERT INTO public.meter_readings
    (tenant_id, aircraft_id, hobbs, recorded_at)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f2', 900.0, now() - interval '7 days');

  -- A flight on the wrong aeroplane, and the correction that moves it.
  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at)
  VALUES ('01920000-0000-7000-8000-0000000000d1',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f1',
          '01920000-0000-7000-8000-0000000000a2', DATE '2026-02-16', now());
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end)
  VALUES ('01920000-0000-7000-8000-0000000000d1',
          '01920000-0000-7000-8000-00000000000a', 1202.5, 1206.0);

  SELECT hobbs INTO was FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  IF was.hobbs <> 1206.0 THEN
    RAISE EXCEPTION 'the misfiled flight did not land: %', was.hobbs;
  END IF;

  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, recorded_at,
     supersedes_id, correction_reason)
  VALUES ('01920000-0000-7000-8000-0000000000d2',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000000f2',       -- the other aeroplane
          '01920000-0000-7000-8000-0000000000a2', DATE '2026-02-16', now(),
          '01920000-0000-7000-8000-0000000000d1',
          'Flown in N456CD, not N123AB');
  INSERT INTO public.flight_meters
    (flight_id, tenant_id, hobbs_start, hobbs_end)
  VALUES ('01920000-0000-7000-8000-0000000000d2',
          '01920000-0000-7000-8000-00000000000a', 900.0, 903.5);

  SELECT hobbs INTO was  FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f1';
  SELECT hobbs INTO now_ FROM public.aircraft
   WHERE id = '01920000-0000-7000-8000-0000000000f2';

  -- Back to 1202.5: the last reading on N123AB that nothing supersedes, which
  -- by this point in the test is the administrator's correction. The flight
  -- that was moved away takes its hours with it.
  IF was.hobbs <> 1202.5 THEN
    RAISE EXCEPTION 'the aeroplane it was taken off still shows the hours: %', was.hobbs;
  END IF;
  IF now_.hobbs <> 903.5 THEN
    RAISE EXCEPTION 'the aeroplane it moved to did not get them: %', now_.hobbs;
  END IF;
  RAISE NOTICE '   ok: moving a flight between aeroplanes corrects both their totals';
END
$t$;

-- ---------------------------------------------------------------------------
-- What the shape refuses
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  -- Correcting twice is not twice as corrected: the second one supersedes
  -- the correction, so the history is a chain and not rival claims.
  BEGIN
    INSERT INTO public.flights
      (id, tenant_id, aircraft_id, flown_by, flight_date,
       supersedes_id, correction_reason)
    VALUES ('01920000-0000-7000-8000-0000000000c7',
            '01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f1',
            '01920000-0000-7000-8000-0000000000a3',
            DATE '2026-02-14',
            '01920000-0000-7000-8000-0000000000c2',
            'Correcting the same flight again');
    RAISE EXCEPTION 'one flight was corrected twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '   ok: a flight can only be superseded once';
  END;

  -- "fixed" is not a record of why a meter moved.
  BEGIN
    INSERT INTO public.flights
      (id, tenant_id, aircraft_id, flown_by, flight_date,
       supersedes_id, correction_reason)
    VALUES ('01920000-0000-7000-8000-0000000000c8',
            '01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f1',
            '01920000-0000-7000-8000-0000000000a3',
            DATE '2026-02-14',
            '01920000-0000-7000-8000-0000000000c4', 'oops');
    RAISE EXCEPTION 'a correction with no real reason was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: a correction needs a reason that says something';
  END;

  -- §6: an error never leaks cross-tenant existence, and the row is not
  -- visible to begin with.
  BEGIN
    INSERT INTO public.flights
      (id, tenant_id, aircraft_id, flown_by, flight_date,
       supersedes_id, correction_reason)
    VALUES ('01920000-0000-7000-8000-0000000000c9',
            '01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000000f1',
            '01920000-0000-7000-8000-0000000000a3',
            DATE '2026-02-14',
            '01920000-0000-7000-8000-0000000000b9',   -- tenant B's namespace
            'Reaching into another club');
    RAISE EXCEPTION 'a correction named a flight outside the tenant';
  EXCEPTION WHEN sqlstate 'FS404' THEN
    RAISE NOTICE '   ok: a flight in another tenant is not there to correct';
  END;

  -- The correction is itself append-only. Nothing walks it back by editing.
  BEGIN
    UPDATE public.flights SET supersedes_id = NULL
     WHERE id = '01920000-0000-7000-8000-0000000000c2';
    RAISE EXCEPTION 'a correction was unmade by an edit';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: and a correction cannot be edited away';
  END;

  BEGIN
    DELETE FROM public.flights
     WHERE id = '01920000-0000-7000-8000-0000000000c1';
    RAISE EXCEPTION 'a flight was deleted';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE '   ok: and no flight can be deleted at all';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- The grant shape, asserted from the catalog
--
-- 0007 grants UPDATE on five columns — route, remarks and the review flag —
-- and on nothing else. The cheap thing a future PATCH would do is widen that
-- list, and the two new columns are exactly the ones it would be tempting to
-- add. This is the test that stops it, in the shape 140_member_billing uses.
-- ---------------------------------------------------------------------------
DO $t$
DECLARE c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['supersedes_id', 'correction_reason', 'logged_in_error']
  LOOP
    IF has_column_privilege('app_role', 'public.flights', c, 'UPDATE') THEN
      RAISE EXCEPTION 'flights.% can be edited — a correction is a new row', c;
    END IF;
    IF NOT has_column_privilege('app_role', 'public.flights', c, 'INSERT') THEN
      RAISE EXCEPTION 'flights.% cannot be written at all', c;
    END IF;
  END LOOP;
  RAISE NOTICE '   ok: the correction columns are insert-only, like the meters';

  IF has_table_privilege('app_role', 'public.flights', 'DELETE') THEN
    RAISE EXCEPTION 'app_role gained DELETE on flights';
  END IF;
  RAISE NOTICE '   ok: and nothing gained DELETE along the way';
END
$t$;

ROLLBACK;
