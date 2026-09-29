-- ===========================================================================
-- 0018_flight_detail.sql — three things the post-flight form had nowhere to put
--
-- §3.4 calls the post-flight entry the most important screen in the product,
-- and it has been asking for less than a pilot standing at the tiedown
-- already knows. Three columns, no new tables, nothing derived.
--
-- `flights.category` — personal, business or maintenance.
--
--   Descriptive only, and deliberately so. It is *not* wired to billing: a
--   maintenance flight produces the same charge today that it did yesterday.
--   §3.7 makes charges append-only and snapshot their rate, so a rule that
--   silently suppresses one is the kind of thing a treasurer discovers months
--   later from a member's statement. If a club wants maintenance flights
--   uncharged that is a member-billing decision with a reversing-entry story
--   attached, taken on purpose rather than inherited from a dropdown.
--
--   It is also not the start of a pilot logbook (§3.4). It says what the
--   *aeroplane* was doing, which is why "maintenance" is the member of the
--   set that earns the column: a ferry flight to the avionics shop is not a
--   member taking the aircraft out, and the difference matters when somebody
--   reads the meters back.
--
-- `flight_fuel.fuel_remaining_before` — what was in the tanks at start-up.
--
--   §3.4 keeps fuel as *state*: latest reading wins, and it is never computed
--   by arithmetic across flights, "because pilots estimate, gauges lie, and
--   someone always tops off without logging it". That last clause is exactly
--   why this column is worth having. The form suggests the last recorded
--   reading; when the pilot corrects it, the difference is the unlogged
--   uplift, recorded rather than silently absorbed. Still a reading, still
--   never summed.
--
-- `flight_fuel.fuel_price_cents` — what a gallon cost.
--
--   The price is what is on the pump and what a pilot can read off a receipt;
--   the total is arithmetic. §3.7 rule 3 keeps money in integer minor units,
--   and §8.2 keeps the client out of computing anything that matters — a
--   charge is money — so the API multiplies and `fuel_added_cost_cents` stays
--   the authoritative total that §3.7's wet-rate credit already reads.
--
--   Per *unit*, whatever `aircraft_config.fuel_units` says that unit is.
--
-- All three are nullable: every flight already logged is still a valid flight,
-- and §8.1 makes the API additive-only.
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
-- What the aeroplane was doing
-- ---------------------------------------------------------------------------

ALTER TABLE public.flights
  ADD COLUMN category text
    CONSTRAINT flights_category_check
    CHECK (category IN ('personal', 'business', 'maintenance'));

COMMENT ON COLUMN public.flights.category IS
  'What the aeroplane was doing: personal, business or maintenance. '
  'Descriptive. Nothing computes against it — in particular it does not '
  'change what the pilot is charged (§3.7), which is a decision to take '
  'deliberately rather than to inherit from a dropdown.';

-- ---------------------------------------------------------------------------
-- Fuel: one more reading, and the price behind the total
-- ---------------------------------------------------------------------------

ALTER TABLE public.flight_fuel
  ADD COLUMN fuel_remaining_before numeric(6, 1),
  -- §3.7 rule 3: integer minor units. A price, not a total — the total is
  -- `fuel_added_cost_cents`, which the API derives so no client has to.
  ADD COLUMN fuel_price_cents integer
    CONSTRAINT flight_fuel_price_non_negative CHECK (fuel_price_cents >= 0);

COMMENT ON COLUMN public.flight_fuel.fuel_remaining_before IS
  'What the tanks read at start-up. State, like fuel_remaining_after, and '
  'never summed across flights (§3.4). Where it disagrees with the previous '
  'flight''s reading, the difference is fuel somebody added without logging '
  'it — which is information, not an error.';

COMMENT ON COLUMN public.flight_fuel.fuel_price_cents IS
  'Price per unit of fuel_units, in integer minor units (§3.7 rule 3). The '
  'total lives in fuel_added_cost_cents and is derived from this and '
  'fuel_added_qty by the API, never by a client (§8.2).';

-- ---------------------------------------------------------------------------
-- Grants
--
-- The application writes flights and their fuel on the post-flight path, so
-- the new columns need naming in the same INSERT grants the existing ones
-- have. Nothing gains UPDATE: a correction is a new row (§3.4).
-- ---------------------------------------------------------------------------

GRANT INSERT (category) ON public.flights TO app_role;
GRANT INSERT (fuel_remaining_before, fuel_price_cents) ON public.flight_fuel TO app_role;
