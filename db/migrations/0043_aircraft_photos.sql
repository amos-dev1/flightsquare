-- ===========================================================================
-- 0043 — a photograph of the aeroplane itself
--
-- An admin uploads one picture of the aircraft on its settings, and every
-- screen that names the aeroplane can show it: the fleet list, the aircraft
-- dashboard, the phone's home screen. A club with three white Cessnas is
-- the case for it — a tail number is easy to mistype and a photo is not.
--
-- `attachments.aircraft_id` — the fifth owner.
--
--   §3.8 said "a fourth owner is a migration; a fifth is where this shape stops
--   being the answer." This is the fifth, taken as a deliberate decision
--   (2026-10-21) rather than by drift: the alternatives were redesigning
--   ownership before the photograph, or a second file system beside
--   `attachments` with its own upload path and its own `storage.bytes`
--   trigger. Both cost more than one more nullable column, and §3.8 now says
--   the sixth is the redesign point.
--
--   The same shape as 0042: a composite foreign key to `aircraft (tenant_id,
--   id)`, so a photo cannot name an aeroplane in another tenant, and the
--   one-owner CHECK widened to five.
--
-- `kind = 'aircraft_photo'`, and only on an aircraft-owned row.
--
--   Tied both ways by a CHECK. Every earlier owner shares kinds — a squawk
--   photo and a document scan are both "whatever the file is" — but this one
--   is a single purpose, and the screens find "the aeroplane's picture" by
--   that pair. A defect photo that somehow named the aeroplane directly would
--   otherwise become its portrait.
--
-- Which photo is current is not stored. It is the newest active, uploaded
-- `aircraft_photo` on the aeroplane, and a replacement marks the one before it
-- removed. No pointer on `aircraft`, so §3.8's "the key points from the file
-- to the owner and never back" still holds, and an upload that lands while its
-- predecessor's removal fails still shows the right picture.
--
-- `refresh_attachments_usage` is untouched: it sums every completed row
-- regardless of owner, so the photo counts toward `storage.bytes`, and a
-- replaced one goes on counting because its bytes are still in the bucket
-- (§10, 2026-10-02).
--
-- Content tier (§7.2) like every other attachment; `admin_role` gets nothing
-- here and `db/tests/030` defaults to deny.
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

ALTER TABLE public.attachments
  ADD COLUMN aircraft_id uuid;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id);

ALTER TABLE public.attachments
  DROP CONSTRAINT attachments_one_owner_check,
  ADD CONSTRAINT attachments_one_owner_check
    CHECK (num_nonnulls(squawk_id, compliance_record_id, aircraft_document_id,
                        flight_id, aircraft_id) <= 1);

ALTER TABLE public.attachments
  DROP CONSTRAINT attachments_kind_check,
  ADD CONSTRAINT attachments_kind_check CHECK (kind IN (
    'photo', 'invoice', 'logbook_entry', 'document', 'meter_photo', 'aircraft_photo'));

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_aircraft_photo_check
    CHECK ((aircraft_id IS NOT NULL) = (kind = 'aircraft_photo'));

CREATE INDEX attachments_aircraft_idx
  ON public.attachments (tenant_id, aircraft_id, created_at DESC)
  WHERE aircraft_id IS NOT NULL;

COMMENT ON COLUMN public.attachments.aircraft_id IS
  'The aeroplane this is a picture of (0043), always with kind = aircraft_photo. '
  'The current picture is the newest active, uploaded one; a replacement marks '
  'its predecessor removed, and the predecessor still counts toward '
  'storage.bytes because its bytes are still in the bucket.';
