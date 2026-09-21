-- ===========================================================================
-- 0014_route_is_free_text.sql — the last two keys into a 0.1% reference table
--
-- 0011 dropped `aircraft_home_base_fkey` because `aerodromes` holds twenty
-- fields out of some twenty thousand, and a foreign key against a list that
-- incomplete does not protect anybody: it refuses almost every true answer.
-- The same two keys survived on `flights`, and they fail in a worse place.
--
-- Logging a flight from KPAO to KHAF — a real pair, fifteen minutes apart —
-- is a 500. §3.4 is explicit that the post-flight screen is the most
-- important in the product and that when it is awkward people skip it, the
-- meters go stale, and every maintenance number downstream quietly becomes
-- wrong. A constraint that rejects the second-most-common destination on the
-- peninsula is that failure with a stack trace attached.
--
-- The route is documentation. Nothing computes against it: no leg distance,
-- no billing, no maintenance interval. `aircraft.type_code` keeps its key for
-- the reason 0011 gave — `engine_type` on the other side decides which
-- maintenance presets an aeroplane is seeded with — and nothing of the kind
-- hangs off a departure field.
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

ALTER TABLE public.flights DROP CONSTRAINT flights_departed_from_fkey;
ALTER TABLE public.flights DROP CONSTRAINT flights_arrived_at_fkey;

COMMENT ON COLUMN public.flights.departed_from IS
  'An airport identifier as people say it — KPAO, 1C5, EGLL. Free text, like '
  'aircraft.home_base: the aerodrome table suggests and does not refuse.';
COMMENT ON COLUMN public.flights.arrived_at IS
  'An airport identifier as people say it. Free text — see departed_from.';
