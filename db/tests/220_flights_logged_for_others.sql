-- ===========================================================================
-- Logging a flight for somebody else (0044).
--
-- `flown_by` is the billing subject, so naming another member is putting a
-- charge on their statement. A Pilot may name only themselves; an Admin
-- (`aircraft: write`) may name any member.
--
-- Memberships in tenant A, from 000_fixtures: ...a2 is alice (Admin), ...a3 is
-- carol (Pilot).
--
-- Runs as app_role, in a transaction that rolls back.
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

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000002c1',
        '01920000-0000-7000-8000-00000000000a', 'N906FO', 'C172');

DO $t$
BEGIN
  INSERT INTO public.flights (tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000002c1',
          '01920000-0000-7000-8000-0000000000a3',   -- carol
          DATE '2026-10-01');
  RAISE NOTICE '   ok: an Admin can log a flight for another member';
END
$t$;

SET LOCAL app.user_id = '01920000-0000-7000-8000-0000000000c1';   -- carol, Pilot

DO $t$
BEGIN
  INSERT INTO public.flights (tenant_id, aircraft_id, flown_by, flight_date)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000002c1',
          '01920000-0000-7000-8000-0000000000a3',   -- herself
          DATE '2026-10-02');
  RAISE NOTICE '   ok: a Pilot can log their own flight';

  BEGIN
    INSERT INTO public.flights (tenant_id, aircraft_id, flown_by, flight_date)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002c1',
            '01920000-0000-7000-8000-0000000000a2',   -- alice
            DATE '2026-10-03');
    RAISE EXCEPTION 'a Pilot logged a flight, and so a charge, against somebody else';
  EXCEPTION WHEN SQLSTATE 'FS403' THEN
    RAISE NOTICE '   ok: a Pilot cannot log a flight for somebody else';
  END;
END
$t$;
ROLLBACK;
