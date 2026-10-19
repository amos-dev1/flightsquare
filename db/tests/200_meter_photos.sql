-- ===========================================================================
-- Meter photographs (0042): a flight as the fourth attachment owner, and the
-- setting that asks for one.
--
-- §3.8 makes the composite foreign key the reason an owner is a column and not
-- a polymorphic pair, so the thing worth proving is that a photograph cannot
-- name another tenant's flight — by policy when it carries their tenant id,
-- and by the key when it carries its own.
--
-- Runs as app_role, in transactions that roll back.
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

INSERT INTO public.aircraft (id, tenant_id, registration, type_code)
VALUES ('01920000-0000-7000-8000-0000000002a1',
        '01920000-0000-7000-8000-00000000000a', 'N904AT', 'C172');

-- The admin's half: one column on the aeroplane's configuration, off unless
-- somebody turns it on.
INSERT INTO public.aircraft_config (aircraft_id, tenant_id)
VALUES ('01920000-0000-7000-8000-0000000002a1',
        '01920000-0000-7000-8000-00000000000a');

DO $t$
BEGIN
  IF (SELECT require_meter_photos FROM public.aircraft_config
       WHERE aircraft_id = '01920000-0000-7000-8000-0000000002a1') THEN
    RAISE EXCEPTION 'a new aeroplane asks for meter photographs nobody chose';
  END IF;
  UPDATE public.aircraft_config SET require_meter_photos = true
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000002a1';
  RAISE NOTICE '   ok: off by default, and an admin can turn it on';
END
$t$;

INSERT INTO public.flights (id, tenant_id, aircraft_id, flown_by, flight_date, arrived_at)
VALUES ('01920000-0000-7000-8000-0000000002a2',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000002a1',
        '01920000-0000-7000-8000-0000000000a3',
        DATE '2026-03-01', 'KTRK');

-- A flight logged before the setting was on, by turning it off and back:
-- each flight carries what it was asked for at the time, whatever it claims.
DO $t$
BEGIN
  IF NOT (SELECT meter_photos_requested FROM public.flights
           WHERE id = '01920000-0000-7000-8000-0000000002a2') THEN
    RAISE EXCEPTION 'a flight logged with the setting on was not asked for a photograph';
  END IF;

  UPDATE public.aircraft_config SET require_meter_photos = false
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000002a1';
  INSERT INTO public.flights
    (id, tenant_id, aircraft_id, flown_by, flight_date, meter_photos_requested)
  VALUES ('01920000-0000-7000-8000-0000000002a4',
          '01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000002a1',
          '01920000-0000-7000-8000-0000000000a3',
          DATE '2026-03-02', true);
  IF (SELECT meter_photos_requested FROM public.flights
       WHERE id = '01920000-0000-7000-8000-0000000002a4') THEN
    RAISE EXCEPTION 'a caller set meter_photos_requested itself';
  END IF;

  -- Turning it back on does not reach back into the one logged while off.
  UPDATE public.aircraft_config SET require_meter_photos = true
   WHERE aircraft_id = '01920000-0000-7000-8000-0000000002a1';
  IF (SELECT meter_photos_requested FROM public.flights
       WHERE id = '01920000-0000-7000-8000-0000000002a4') THEN
    RAISE EXCEPTION 'the setting reached back into a flight already logged';
  END IF;
  RAISE NOTICE '   ok: each flight keeps what it was asked for when it was logged';
END
$t$;

INSERT INTO public.squawks (id, tenant_id, aircraft_id, summary, reported_by)
VALUES ('01920000-0000-7000-8000-0000000002a3',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000002a1',
        'Hobbs sticks below 1500 rpm',
        '01920000-0000-7000-8000-0000000000a2');

DO $t$
BEGIN
  -- A flight is never refused for having no photograph: the setting is a
  -- request the form makes, and the flight above went in without one (§8.1).
  INSERT INTO public.attachments
    (tenant_id, flight_id, kind, storage_key, content_type, byte_size)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000002a2', 'meter_photo',
          'a/meter-photo-200.jpg', 'image/jpeg', 1);
  RAISE NOTICE '   ok: a photograph names the flight it was taken after';

  BEGIN
    INSERT INTO public.attachments
      (tenant_id, flight_id, squawk_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002a2',
            '01920000-0000-7000-8000-0000000002a3', 'meter_photo',
            'a/meter-photo-two-owners.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'a photograph was stored belonging to a flight and a squawk';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: and one owner still means one';
  END;

  BEGIN
    INSERT INTO public.attachments
      (tenant_id, flight_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002a2', 'selfie',
            'a/meter-photo-unknown-kind.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'an attachment kind nobody declared was accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: the kind is from a closed list';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- Another tenant's flight, both ways round.
-- ---------------------------------------------------------------------------
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000b1';

DO $t$
DECLARE msg text;
BEGIN
  -- Carrying tenant A's id: the policy refuses it (§6.1 item 6).
  BEGIN
    INSERT INTO public.attachments
      (tenant_id, flight_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002a2', 'meter_photo',
            'a/meter-photo-into-a.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'a meter photograph was written into another tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'rejected, but not by RLS: %', msg;
    END IF;
    RAISE NOTICE '   ok: WITH CHECK refuses another tenant''s id';
  END;

  -- Carrying its own id but naming A's flight: the composite key refuses it,
  -- which is the reason §3.8 has keys rather than an (owner_type, owner_id).
  BEGIN
    INSERT INTO public.attachments
      (tenant_id, flight_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000b',
            '01920000-0000-7000-8000-0000000002a2', 'meter_photo',
            'a/meter-photo-naming-a.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'a photograph in B named a flight in A';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE '   ok: and the key refuses naming a flight in another tenant';
  END;

  -- §6.1 item 5: B sees none of A's photographs.
  IF EXISTS (SELECT 1 FROM public.attachments WHERE flight_id IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant B can see tenant A''s meter photographs';
  END IF;
  RAISE NOTICE '   ok: a tenant sees no other tenant''s meter photographs';
END
$t$;
ROLLBACK;
