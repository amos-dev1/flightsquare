-- ===========================================================================
-- Aircraft photographs (0043): the aeroplane as the fifth attachment owner.
--
-- As in 200, the thing worth proving is that a photo cannot name another
-- tenant's aeroplane — by policy when it carries their tenant id, and by the
-- composite key when it carries its own — plus the CHECK that ties the kind
-- to the owner both ways.
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
VALUES ('01920000-0000-7000-8000-0000000002b1',
        '01920000-0000-7000-8000-00000000000a', 'N905AP', 'C172');

INSERT INTO public.squawks (id, tenant_id, aircraft_id, summary, reported_by)
VALUES ('01920000-0000-7000-8000-0000000002b2',
        '01920000-0000-7000-8000-00000000000a',
        '01920000-0000-7000-8000-0000000002b1',
        'Left nav light out',
        '01920000-0000-7000-8000-0000000000a2');

DO $t$
BEGIN
  INSERT INTO public.attachments
    (tenant_id, aircraft_id, kind, storage_key, content_type, byte_size)
  VALUES ('01920000-0000-7000-8000-00000000000a',
          '01920000-0000-7000-8000-0000000002b1', 'aircraft_photo',
          'a/aircraft-photo-210.jpg', 'image/jpeg', 1);
  RAISE NOTICE '   ok: a photograph names the aeroplane it is of';

  BEGIN
    INSERT INTO public.attachments
      (tenant_id, aircraft_id, squawk_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002b1',
            '01920000-0000-7000-8000-0000000002b2', 'aircraft_photo',
            'a/aircraft-photo-two-owners.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'a photograph was stored belonging to an aeroplane and a squawk';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: one owner still means one, at five';
  END;

  BEGIN
    INSERT INTO public.attachments
      (tenant_id, aircraft_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002b1', 'photo',
            'a/aircraft-photo-wrong-kind.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'an aeroplane-owned file was stored as something other than its picture';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: an aeroplane-owned file is always its picture';
  END;

  BEGIN
    INSERT INTO public.attachments
      (tenant_id, squawk_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002b2', 'aircraft_photo',
            'a/aircraft-photo-on-squawk.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'a defect photo was filed as the aeroplane''s picture';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '   ok: and its picture is always aeroplane-owned';
  END;
END
$t$;

-- ---------------------------------------------------------------------------
-- Another tenant's aeroplane, both ways round.
-- ---------------------------------------------------------------------------
SET LOCAL app.tenant_id = '01920000-0000-7000-8000-00000000000b';
SET LOCAL app.user_id   = '01920000-0000-7000-8000-0000000000b1';

DO $t$
DECLARE msg text;
BEGIN
  -- Carrying tenant A's id: the policy refuses it (§6.1 item 6).
  BEGIN
    INSERT INTO public.attachments
      (tenant_id, aircraft_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000a',
            '01920000-0000-7000-8000-0000000002b1', 'aircraft_photo',
            'a/aircraft-photo-into-a.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'an aircraft photograph was written into another tenant';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT;
    IF msg NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'rejected, but not by RLS: %', msg;
    END IF;
    RAISE NOTICE '   ok: WITH CHECK refuses another tenant''s id';
  END;

  -- Carrying its own id but naming A's aeroplane: the composite key refuses it.
  BEGIN
    INSERT INTO public.attachments
      (tenant_id, aircraft_id, kind, storage_key, content_type, byte_size)
    VALUES ('01920000-0000-7000-8000-00000000000b',
            '01920000-0000-7000-8000-0000000002b1', 'aircraft_photo',
            'a/aircraft-photo-naming-a.jpg', 'image/jpeg', 1);
    RAISE EXCEPTION 'a photograph in B named an aeroplane in A';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE '   ok: and the key refuses naming an aeroplane in another tenant';
  END;

  -- §6.1 item 5: B sees none of A's photographs.
  IF EXISTS (SELECT 1 FROM public.attachments WHERE aircraft_id IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant B can see tenant A''s aircraft photographs';
  END IF;
  RAISE NOTICE '   ok: a tenant sees no other tenant''s aircraft photographs';
END
$t$;
ROLLBACK;
