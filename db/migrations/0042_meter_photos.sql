-- ===========================================================================
-- 0042 — a photograph of the meters, on the flight it belongs to
--
-- A club that has been burned by a fat-fingered Hobbs (§3.4: "people
-- fat-finger Hobbs constantly") wants the panel itself, not only what somebody
-- typed from it. Two changes:
--
-- `aircraft_config.require_meter_photos` — per aeroplane, set by an admin.
--
--   Configuration, not a branch (§1.3): it is a value on the aeroplane and the
--   same code reads it for every tenant. Per aircraft rather than per tenant
--   because the reason for it is usually one aeroplane — the one with the
--   Hobbs that sticks, or the leaseback whose owner wants proof.
--
--   **It is never a reason to refuse a flight.** §8.1 forbids tightening a
--   rule an old client would now fail, and every phone build already shipped
--   logs a flight with no photograph. §8.2 makes the same point from the other
--   side: the attachment is uploaded *after* its owner exists (§3.8), so at the
--   moment a flight is inserted its photograph cannot exist yet. The form asks
--   for it; a flight that arrives without one is shown to an admin as missing
--   one, which is §8.2's "a flag for the admin, never a rejection" applied to
--   a second fact.
--
-- `flights.meter_photos_requested` — whether *this* flight was asked for one.
--
--   Snapshotted when the flight is inserted, never read live off the setting.
--   An admin turning the setting on today did not ask last year's pilots for a
--   photograph, and reading the setting at display time would mark every past
--   flight on the aeroplane as missing one the moment the box was ticked. It is
--   the same reasoning as §3.7's rate snapshot: record what applied, not a
--   pointer to what applies now.
--
--   Set by a trigger rather than by the API handler, for 0041's reason: a rule
--   that exists only in a handler is a rule the next handler will not have.
--   Whatever a caller sends for it is overwritten, so a client cannot declare
--   its own flight exempt.
--
-- `attachments.flight_id` — the fourth owner.
--
--   §3.8: "A fourth owner is a migration; a fifth is where this shape stops
--   being the answer." This is the fourth. A nullable column with a composite
--   foreign key to `flights (tenant_id, id)`, so a photograph cannot name a
--   flight in another tenant, and the one-owner CHECK widened to include it.
--   Gated on `flights` at the API, as a defect photograph is on `squawks`.
--
--   `kind = 'meter_photo'`, so a list of a flight's files can say what each
--   one is and a later owner of a different sort of photograph does not have
--   to guess.
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

-- ---------------------------------------------------------------------------
-- The setting
-- ---------------------------------------------------------------------------

-- Defaulted off, so nothing is backfilled and no aeroplane starts asking for
-- a photograph nobody decided it needs.
ALTER TABLE public.aircraft_config
  ADD COLUMN require_meter_photos boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.aircraft_config.require_meter_photos IS
  'Ask for a photograph of the meters when a flight is logged on this '
  'aeroplane. A request made of the form, never a reason the API refuses a '
  'flight (§8.1, §8.2): one logged without is shown to an admin as missing it.';

-- ---------------------------------------------------------------------------
-- What each flight was asked for
-- ---------------------------------------------------------------------------

-- Defaulted false: every flight already logged was asked for nothing.
ALTER TABLE public.flights
  ADD COLUMN meter_photos_requested boolean NOT NULL DEFAULT false;

/*
  SECURITY INVOKER: it reads the aeroplane's configuration in the inserting
  caller's own tenant context, which app_role can already do, so it holds no
  privilege and is not a §2.3 helper. A configuration row it cannot see — no
  such aeroplane in this tenant — is "not asked", and the flight's own foreign
  key refuses the insert anyway.
*/
CREATE FUNCTION public.snapshot_meter_photo_request()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.meter_photos_requested := coalesce(
    (SELECT c.require_meter_photos
       FROM public.aircraft_config c
      WHERE c.aircraft_id = NEW.aircraft_id
        AND c.tenant_id = NEW.tenant_id),
    false);
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.snapshot_meter_photo_request() FROM PUBLIC;

CREATE TRIGGER flights_snapshot_meter_photo_request
  BEFORE INSERT ON public.flights
  FOR EACH ROW
  EXECUTE FUNCTION public.snapshot_meter_photo_request();

COMMENT ON COLUMN public.flights.meter_photos_requested IS
  'Whether the aeroplane asked for a photograph of the meters when this flight '
  'was logged — snapshotted by trigger at insert, never read live, so turning '
  'the setting on does not mark every past flight as missing one.';

-- ---------------------------------------------------------------------------
-- The fourth owner
-- ---------------------------------------------------------------------------

ALTER TABLE public.attachments
  ADD COLUMN flight_id uuid;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_flight_fkey
    FOREIGN KEY (tenant_id, flight_id)
    REFERENCES public.flights (tenant_id, id);

ALTER TABLE public.attachments
  DROP CONSTRAINT attachments_one_owner_check,
  ADD CONSTRAINT attachments_one_owner_check
    CHECK (num_nonnulls(squawk_id, compliance_record_id, aircraft_document_id, flight_id) <= 1);

ALTER TABLE public.attachments
  DROP CONSTRAINT attachments_kind_check,
  ADD CONSTRAINT attachments_kind_check CHECK (kind IN (
    'photo', 'invoice', 'logbook_entry', 'document', 'meter_photo'));

CREATE INDEX attachments_flight_idx
  ON public.attachments (tenant_id, flight_id, created_at DESC)
  WHERE flight_id IS NOT NULL;

COMMENT ON COLUMN public.attachments.flight_id IS
  'The flight this is a photograph of the meters for. The flight is written '
  'first and this names it — the offline queue orders the upload behind its '
  'owner (§3.8) — which is why a flight can exist without its photograph and '
  'why that is shown rather than refused.';
