-- ===========================================================================
-- 0041_flight_corrections.sql — fixing a flight without editing one
--
-- A flight has never been correctable. `flight_meters` and `flight_fuel` carry
-- SELECT and INSERT and no UPDATE (0007:331-338), `meter_readings` the same,
-- and there is no DELETE grant on any of them — so a mistyped Hobbs has been
-- wrong forever, in the product whose own §3.4 says "people fat-finger Hobbs
-- constantly".
--
-- ---------------------------------------------------------------------------
-- Why a correction is a new flight
--
-- db/tests/090_flights.sql:160 already said what the remedy is: "The record is
-- immutable: a correction is a new flight or a reversing entry, never an edit
-- to what someone spent." This builds the first half.
--
-- A corrected flight is a **new flight row that supersedes the old one**, the
-- same shape as `meter_readings.supersedes_id` and
-- `compliance_records.supersedes_id`. Three things follow, and they are the
-- reason this is the cheap design rather than the elaborate one:
--
--   * No new grants. Every INSERT-only grant stays, and `record_flight_meters`,
--     `charge_for_flight` and `credit_fuel_for_flight` fire on the new row
--     exactly as they do on any other flight. Nothing is updated in place.
--
--   * It corrects what a field-edit could not: the wrong aeroplane, the wrong
--     pilot, the wrong date. That is why no delete is needed — "I logged this
--     on the wrong aircraft" is a correction, not a deletion.
--
--   * On a phone it is the same queued write. `packages/shared/src/offline.ts`
--     reads an unrecognised `kind` back *as a flight*, so adding a kind is a
--     live migration hazard; adding a field to the payload is not.
--
-- ---------------------------------------------------------------------------
-- Why no delete, said once
--
-- Four foreign keys with no ON DELETE clause already point at `flights` —
-- `meter_readings`, `squawks`, `flight_charges`, `fuel_credits` — so the
-- database refuses one. And `refresh_aircraft_meter_totals` has no DELETE
-- trigger, so a row that did vanish would leave `aircraft.hobbs`, `tach` and
-- `airframe_hours` stale while looking perfectly fine, which is the failure
-- 0007 opens by naming. A deletion is not a thing this schema can express
-- safely, and nothing here tries to teach it.
--
-- A flight that never happened is a correction carrying `logged_in_error`.
-- Its hours are nothing, its charge reverses, and the aeroplane's meters go
-- back to where they were — without the log ever claiming the flight was real.
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
-- The three columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.flights
  ADD COLUMN supersedes_id     uuid,
  ADD COLUMN correction_reason text,
  ADD COLUMN logged_in_error   boolean NOT NULL DEFAULT false;

ALTER TABLE public.flights
  ADD CONSTRAINT flights_supersedes_fkey
    FOREIGN KEY (tenant_id, supersedes_id)
    REFERENCES public.flights (tenant_id, id),

  -- Correcting twice is not twice as corrected (0035's phrasing, and its
  -- reasoning). A second correction supersedes the *correction*, which makes
  -- the history a chain rather than a set of rival claims about one flight.
  ADD CONSTRAINT flights_superseded_once UNIQUE (tenant_id, supersedes_id),

  -- A reason, and one that says something. §4.7 wanted the same of a void and
  -- for the same reason: "mistake" is not a record of why a number moved.
  ADD CONSTRAINT flights_correction_reason_check
    CHECK (supersedes_id IS NULL OR length(btrim(correction_reason)) >= 5),

  -- A reason on a flight that corrects nothing would be a note nobody can
  -- interpret, and `remarks` is where a note goes.
  ADD CONSTRAINT flights_reason_needs_correction_check
    CHECK (correction_reason IS NULL OR supersedes_id IS NOT NULL),

  -- "This did not happen" is only ever a statement about something already on
  -- the record.
  ADD CONSTRAINT flights_error_needs_correction_check
    CHECK (NOT logged_in_error OR supersedes_id IS NOT NULL),

  -- A flight cannot correct itself.
  ADD CONSTRAINT flights_supersedes_not_self_check
    CHECK (supersedes_id IS DISTINCT FROM id);

COMMENT ON COLUMN public.flights.supersedes_id IS
  'The flight this one corrects. §3.4 makes the meters append-only, so a '
  'correction is a new flight that replaces an old one and both rows stay — '
  'never an edit to what was written down.';
COMMENT ON COLUMN public.flights.logged_in_error IS
  'This flight did not happen: a double entry, or one logged against the '
  'wrong person. Carries no meters, so it earns no charge and the aeroplane''s '
  'totals fall back to the reading before it.';

CREATE INDEX flights_supersedes_idx
  ON public.flights (tenant_id, supersedes_id)
  WHERE supersedes_id IS NOT NULL;

-- INSERT only, like every other column on this table that matters. A
-- correction of a correction is another row; there is nothing here to edit.
GRANT INSERT (supersedes_id, correction_reason, logged_in_error)
  ON public.flights TO app_role;

-- ---------------------------------------------------------------------------
-- `fuel_credits` gets the constraint it was missed out of
--
-- `flight_charges` has carried `CHECK (reverses_id IS NULL OR reason IS NOT
-- NULL)` since 0013 and `fuel_credits` never did, although it has the same two
-- columns. Nothing had ever written a credit reversal, so nothing noticed.
-- This change is the first thing that writes one.
-- ---------------------------------------------------------------------------

ALTER TABLE public.fuel_credits
  ADD CONSTRAINT fuel_credits_reversal_reason_check
    CHECK (reverses_id IS NULL OR reason IS NOT NULL);

-- The ledger triggers read before they write now — `apply_flight_correction`
-- has to see the charge it is mirroring. The INSERT half of this policy has
-- been here since 0013; the SELECT half mirrors `definer_meters_read` on
-- `meter_readings`, and is narrower than relying on the caller's own scope.
CREATE POLICY definer_ledger_read ON public.flight_charges
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'ledger');
CREATE POLICY definer_ledger_read ON public.fuel_credits
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'ledger');

-- ===========================================================================
-- The totals, recomputed from a log that now has two ways of saying "ignore
-- this row"
--
-- `refresh_aircraft_meter_totals` already picks, per meter, the latest reading
-- that nothing supersedes. A corrected flight needs its reading to stop
-- counting too — and the cheapest honest way to say so is a second anti-join,
-- not a retraction row.
--
-- A retraction written into `meter_readings` would have to carry a value
-- (`has_a_value_check`), so it would have to claim the aeroplane was read at
-- some figure when the point is that it was not. That is 0035's argument about
-- `complied_on` in a different table, and it lands the same way.
--
-- Split into a callable function because a correction recomputes on the
-- `flights` insert, where there is no reading to hang a trigger on. Same
-- shape as `recompute_item_from_compliance` in 0035, and for the same reason.
-- ===========================================================================

/*
  SECURITY INVOKER, deliberately, and it is what keeps §2.3's list closed.

  Both callers are already definer functions owned by flightsquare_owner, so
  this body runs elevated without being a door of its own: app_role holds no
  EXECUTE on it, and if it somehow called it the UPDATE below would fail on
  the missing column grant rather than succeed. A definer function taking an
  id would have been a helper that can be aimed, which §2.3 calls a bypass
  wearing a different hat.

  `recompute_item_from_compliance` in 0035 is the same shape for the same
  reason.
*/
CREATE FUNCTION public.recompute_aircraft_totals(p_aircraft uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prev           text := current_setting('app.auth_bootstrap', true);
  v_overhaul_hours numeric(10, 1);
  v_overhaul_meter text;
BEGIN
  PERFORM set_config('app.auth_bootstrap', 'meters', true);

  /*
    Two anti-joins, and they mean different things.

    The first is a reading corrected in place on the meter log: somebody
    mistyped a figure and recorded it again (§3.4).

    The second is a reading whose *flight* was corrected. The reading itself
    was never disputed — the flight it belongs to was replaced, and a replaced
    flight's meters are not where the aeroplane is. This covers a corrected
    flight and a logged-in-error one identically, because both are a flight
    with something newer pointing at it.
  */
  UPDATE public.aircraft a
     SET hobbs = (
           SELECT r.hobbs FROM public.meter_readings r
            WHERE r.aircraft_id = p_aircraft AND r.hobbs IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM public.flights f
                               WHERE f.supersedes_id = r.flight_id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         tach = (
           SELECT r.tach FROM public.meter_readings r
            WHERE r.aircraft_id = p_aircraft AND r.tach IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM public.flights f
                               WHERE f.supersedes_id = r.flight_id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         airframe_hours = (
           SELECT r.airframe_hours FROM public.meter_readings r
            WHERE r.aircraft_id = p_aircraft AND r.airframe_hours IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM public.flights f
                               WHERE f.supersedes_id = r.flight_id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         cycles = (
           SELECT r.cycles FROM public.meter_readings r
            WHERE r.aircraft_id = p_aircraft AND r.cycles IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
              AND NOT EXISTS (SELECT 1 FROM public.flights f
                               WHERE f.supersedes_id = r.flight_id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         totals_updated_at = now()
   WHERE a.id = p_aircraft;

  -- The last overhaul that has not itself been superseded, and the meter it
  -- was read against — usually tach, but the record says which rather than
  -- this function assuming.
  SELECT c.complied_at_hours, coalesce(c.hours_meter, 'tach')
    INTO v_overhaul_hours, v_overhaul_meter
    FROM public.compliance_records c
   WHERE c.aircraft_id = p_aircraft
     AND c.kind = 'overhaul'
     AND c.complied_at_hours IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.compliance_records s
                      WHERE s.supersedes_id = c.id)
   ORDER BY c.complied_on DESC, c.id DESC
   LIMIT 1;

  -- Second statement rather than another CASE in the first: it reads the
  -- totals the first one just wrote, which is exactly what "since overhaul"
  -- means. NULL until an overhaul is recorded — a zero would claim the
  -- engine was rebuilt this morning.
  UPDATE public.aircraft a
     SET engine_hours_since_overhaul = CASE
           WHEN v_overhaul_hours IS NULL THEN NULL
           ELSE greatest(
             coalesce(CASE v_overhaul_meter
                        WHEN 'hobbs'    THEN a.hobbs
                        WHEN 'airframe' THEN a.airframe_hours
                        ELSE a.tach
                      END, v_overhaul_hours) - v_overhaul_hours, 0)
         END
   WHERE a.id = p_aircraft;

  PERFORM set_config('app.auth_bootstrap', coalesce(v_prev, ''), true);
END
$$;

REVOKE ALL ON FUNCTION public.recompute_aircraft_totals(uuid) FROM PUBLIC;

COMMENT ON FUNCTION public.recompute_aircraft_totals(uuid) IS
  'The body behind refresh_aircraft_meter_totals, callable so a correction '
  'can recompute on the `flights` insert where there is no reading to hang a '
  'trigger on. A full recompute over the whole reading log, so it is correct '
  'whether a total moves up or down — a correction is the first thing in this '
  'product that moves one down.';

-- The trigger keeps its name and its signature; its body is now one line.
CREATE OR REPLACE FUNCTION public.refresh_aircraft_meter_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.recompute_aircraft_totals(coalesce(NEW.aircraft_id, OLD.aircraft_id));
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.refresh_aircraft_meter_totals() FROM PUBLIC;

-- ===========================================================================
-- Who may correct what
--
-- §1.1: the database is the thing standing between people and data, so this is
-- a trigger and not a check in a route. The rule the product settled on:
--
--   a member may correct their own flight while it is still the latest one on
--   that aeroplane; after somebody else has flown it, only an admin may.
--
-- The line is not a clock, and that is the point. Once a later flight exists,
-- its Hobbs *start* was read against this flight's end — so changing this one
-- moves a number another pilot has already built on, and that is a different
-- act from fixing your own typo before anyone noticed.
--
-- It replaces V1_SCOPE.md's 24-hour window, which was both looser (inside it
-- you could still move a figure the next pilot had flown against) and tighter
-- (a wrong Hobbs found at the annual — the one most worth fixing — was frozen).
--
-- `aircraft: write` is the admin test, and it is the same one
-- `assert_booking_is_allowed` already uses two migrations earlier. It is also
-- what `POST /aircraft/:id/meter-readings` is gated on, so correcting a meter
-- by correcting a flight and correcting it directly now need the same thing.
-- Not the `scope` column: `role_bundle_permissions` is keyed per resource, not
-- per level, so narrowing `flights` to 'own' would narrow *reading* too, and
-- 0010 is explicit that a club's flights are shared by design.
-- ===========================================================================

CREATE FUNCTION public.assert_flight_correction_allowed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_target public.flights%ROWTYPE;
  v_newer  timestamptz;
BEGIN
  SELECT * INTO v_target
    FROM public.flights f
   WHERE f.id = NEW.supersedes_id AND f.tenant_id = NEW.tenant_id;

  -- RLS has already decided this: a flight in another tenant is not visible,
  -- so the row simply is not there. Saying "not found" rather than naming it
  -- keeps §6's rule that an error never leaks cross-tenant existence.
  IF v_target.id IS NULL THEN
    RAISE EXCEPTION 'no such flight to correct'
      USING ERRCODE = 'FS404';
  END IF;

  -- An admin may correct anything, including a flight from years ago.
  IF app.permission_level('aircraft') = 'write' THEN
    RETURN NEW;
  END IF;

  IF v_target.flown_by IS DISTINCT FROM app.current_membership_id() THEN
    RAISE EXCEPTION 'that is somebody else''s flight'
      USING ERRCODE = 'FS403',
            HINT = 'An administrator can correct any flight.';
  END IF;

  /*
    Is anything newer standing on this aeroplane?

    By `recorded_at` rather than `flight_date`, because `recorded_at` is what
    the reading log orders by — it is the ordering that decides whose figure
    the aeroplane is currently showing.

    Superseded flights do not count: they have already been replaced. Neither
    do logged-in-error ones, which assert that nothing happened and carry no
    meters for anybody to have built on.
  */
  SELECT max(f.recorded_at) INTO v_newer
    FROM public.flights f
   WHERE f.tenant_id = NEW.tenant_id
     AND f.aircraft_id = v_target.aircraft_id
     AND f.id <> v_target.id
     AND f.recorded_at > v_target.recorded_at
     AND NOT f.logged_in_error
     AND NOT EXISTS (SELECT 1 FROM public.flights s WHERE s.supersedes_id = f.id);

  IF v_newer IS NOT NULL THEN
    RAISE EXCEPTION 'this aircraft has been flown since: correcting it now is an administrator''s to make'
      USING ERRCODE = 'FS403',
            HINT = 'The next pilot read their start against this flight''s end.';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.assert_flight_correction_allowed() FROM PUBLIC;

CREATE TRIGGER flights_check_correction
  BEFORE INSERT ON public.flights
  FOR EACH ROW WHEN (NEW.supersedes_id IS NOT NULL)
  EXECUTE FUNCTION public.assert_flight_correction_allowed();

-- ===========================================================================
-- What a correction does to the money and the meters
--
-- A §2.3 privileged helper, passing that section's question for exactly the
-- reason `charge_for_flight` does: a role that could write its own charges
-- could write a smaller one, and the ledger would be a suggestion. It reverses
-- against whoever *flew*, which is frequently not whoever is correcting.
--
-- The new flight's own charge is not written here — `charge_for_flight` writes
-- it on the new `flight_meters` row, unchanged. A logged-in-error correction
-- has no `flight_meters` row at all, so it earns no charge and no reading,
-- which falls out rather than being special-cased.
-- ===========================================================================

CREATE FUNCTION public.apply_flight_correction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_prev   text := current_setting('app.auth_bootstrap', true);
  v_charge public.flight_charges%ROWTYPE;
  v_credit public.fuel_credits%ROWTYPE;
BEGIN
  PERFORM set_config('app.auth_bootstrap', 'ledger', true);

  /*
    The charge on the flight being replaced, if it earned one and if nobody
    has already taken it back by hand through `POST /charges/:id/reverse`.
    A reversal is itself a charge row, so both halves are excluded.
  */
  SELECT * INTO v_charge
    FROM public.flight_charges c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.flight_id = NEW.supersedes_id
     AND c.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.flight_charges r WHERE r.reverses_id = c.id)
   ORDER BY c.id
   LIMIT 1;

  IF v_charge.id IS NOT NULL THEN
    -- The mirror image, so the pair nets to nothing and the statement shows
    -- both halves of what happened (§3.7 rule 2). The rate is the one that
    -- was snapshotted, never today's: rule 1 keeps February's flight at
    -- February's price whichever direction the money is going.
    INSERT INTO public.flight_charges
      (tenant_id, flight_id, membership_id, meter, meter_hours,
       rate_cents, rate_source, rate_basis, amount_cents, currency,
       reverses_id, reason, created_by)
    VALUES (v_charge.tenant_id, v_charge.flight_id, v_charge.membership_id,
            v_charge.meter, -v_charge.meter_hours,
            v_charge.rate_cents, v_charge.rate_source, v_charge.rate_basis,
            -v_charge.amount_cents, v_charge.currency,
            v_charge.id, NEW.correction_reason, app.current_membership_id());
  END IF;

  SELECT * INTO v_credit
    FROM public.fuel_credits c
   WHERE c.tenant_id = NEW.tenant_id
     AND c.flight_id = NEW.supersedes_id
     AND c.reverses_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.fuel_credits r WHERE r.reverses_id = c.id)
   ORDER BY c.id
   LIMIT 1;

  IF v_credit.id IS NOT NULL THEN
    INSERT INTO public.fuel_credits
      (tenant_id, flight_id, membership_id, quantity, amount_cents, currency,
       reverses_id, reason, created_by)
    VALUES (v_credit.tenant_id, v_credit.flight_id, v_credit.membership_id,
            -v_credit.quantity, -v_credit.amount_cents, v_credit.currency,
            v_credit.id, NEW.correction_reason, app.current_membership_id());
  END IF;

  PERFORM set_config('app.auth_bootstrap', coalesce(v_prev, ''), true);

  /*
    The superseded flight's reading stops counting the moment this row exists,
    so the totals are recomputed here.

    For an ordinary correction they are recomputed a second time a moment
    later, when `record_flight_meters` writes the new reading. That is not
    waste: between the two, `aircraft.hobbs` reads as the figure *before* the
    flight being corrected, which is exactly what the new flight's start
    should be checked against. §8.2's "does not meet the last reading" flag
    therefore compares a correction to where the aeroplane actually was.

    For a logged-in-error correction this is the only recompute, because
    nothing follows it.
  */
  PERFORM public.recompute_aircraft_totals(NEW.aircraft_id);

  -- A correction of a flight on another aeroplane — somebody logged it
  -- against the wrong one — leaves the first aeroplane's totals to fix too.
  PERFORM public.recompute_aircraft_totals(
    (SELECT f.aircraft_id FROM public.flights f WHERE f.id = NEW.supersedes_id));

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.apply_flight_correction() FROM PUBLIC;

CREATE TRIGGER flights_apply_correction
  AFTER INSERT ON public.flights
  FOR EACH ROW WHEN (NEW.supersedes_id IS NOT NULL)
  EXECUTE FUNCTION public.apply_flight_correction();
