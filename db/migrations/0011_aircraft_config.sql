-- ===========================================================================
-- 0011_aircraft_config.sql — M2: what an aircraft costs and how it is read
--
-- V1_SCOPE M2 asks for five settings this schema does not have — billing
-- meter, wet or dry, a default rate, fuel capacity and units — and for a
-- third status. The rates are here rather than waiting for M6 because they
-- are properties of the aeroplane rather than of the ledger: what it costs
-- an hour and whether that includes fuel are things a club knows on the day
-- they add it, and M6 resolves a charge *against* them.
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
-- Home base stops being a foreign key
--
-- V1_SCOPE M2 says "home base (free-text airport identifier)", and it is
-- right. `aerodromes` holds twenty fields; there are some twenty thousand in
-- the United States alone, and the README has always said the real list is an
-- import job (§2.2) rather than a migration. A foreign key against a
-- reference table that is 0.1% complete does not protect anybody — it refuses
-- almost every true answer, which is exactly what it did: somebody typing
-- their own home field got a constraint violation.
--
-- The column, the table and the suggestions all stay. What goes is the part
-- that turned an incomplete list into a rule.
--
-- `type_code` keeps its key on purpose. It is not a label: `engine_type` on
-- the other side of it decides which maintenance presets an aircraft is
-- seeded with (§3.6), so an unrecognised designator would silently mean no
-- oil change. Designators are also a closed set that can actually be
-- imported, where every airfield on earth is not.
-- ---------------------------------------------------------------------------
ALTER TABLE public.aircraft DROP CONSTRAINT aircraft_home_base_fkey;

COMMENT ON COLUMN public.aircraft.home_base IS
  'An airport identifier as people say it — KPAO, 1C5, EGLL. Free text: the '
  'aerodrome table is a stub that suggests, and is not complete enough to '
  'refuse anything.';

-- ---------------------------------------------------------------------------
-- A third status
--
-- §3.3 already grounds an aircraft through `aircraft_availability` when a
-- squawk or an overdue inspection says so. This is the other way: an admin
-- deciding, for a reason the system has no row for — an insurance lapse, a
-- ferry flight, an owner taking it back for a month.
--
-- Separate from archiving, which is about the plan and the fleet list, and
-- separate from a squawk, which is about a defect. All three end in the same
-- place, which is the view below.
-- ---------------------------------------------------------------------------
ALTER TABLE public.aircraft DROP CONSTRAINT aircraft_status_check;
ALTER TABLE public.aircraft ADD CONSTRAINT aircraft_status_check
  CHECK (status IN ('active', 'grounded', 'archived', 'sold'));

-- ===========================================================================
-- What it costs, and what it holds
-- ===========================================================================

ALTER TABLE public.aircraft_config
  /**
   * Which meter the money is counted on. Frequently not the meter
   * maintenance runs on — Hobbs for billing and tach for engine intervals is
   * the common pairing (§3.7) — which is why these are two columns and not
   * one preference.
   */
  ADD COLUMN billing_meter      text NOT NULL DEFAULT 'hobbs',

  /**
   * §3.7: a wet rate includes fuel, so a pilot who buys fuel is credited
   * back against their charges; a dry rate excludes it and fuel is simply
   * their own cost with no ledger effect. This single column is what decides
   * whether `flight_fuel.fuel_added_cost_cents` produces a credit at all.
   */
  ADD COLUMN rate_basis         text NOT NULL DEFAULT 'dry',

  -- §3.7 rule 3: integer minor units, and a currency code even while USD is
  -- the only one. The effective-dated rate table arrives with M6; this is
  -- the number a club knows on the day they add the aeroplane, and what the
  -- first rate row will be seeded from.
  ADD COLUMN default_rate_cents integer,
  ADD COLUMN currency           char(3) NOT NULL DEFAULT 'USD',

  ADD COLUMN fuel_capacity      numeric(6, 1),
  ADD COLUMN fuel_units         text NOT NULL DEFAULT 'gallons',

  ADD CONSTRAINT aircraft_config_billing_meter_check
    CHECK (billing_meter IN ('hobbs', 'tach')),
  ADD CONSTRAINT aircraft_config_rate_basis_check
    CHECK (rate_basis IN ('wet', 'dry')),
  ADD CONSTRAINT aircraft_config_fuel_units_check
    CHECK (fuel_units IN ('gallons', 'litres')),
  ADD CONSTRAINT aircraft_config_rate_non_negative_check
    CHECK (default_rate_cents IS NULL OR default_rate_cents >= 0),
  ADD CONSTRAINT aircraft_config_fuel_capacity_check
    CHECK (fuel_capacity IS NULL OR fuel_capacity > 0);

COMMENT ON COLUMN public.aircraft_config.billing_meter IS
  'Hobbs or tach. Not `airframe`: airframe hours are a lifetime total that '
  'advances with whichever meter the aircraft actually has, and nobody bills '
  'against it.';

-- The existing grant on aircraft_config is table-wide UPDATE, so the new
-- columns are already writable by an admin through the API's `aircraft:
-- write` gate. Nothing here is derived, so nothing needs withholding.

-- ===========================================================================
-- An admin's grounding reaches the same view as everything else
-- ===========================================================================

CREATE OR REPLACE VIEW public.aircraft_availability
WITH (security_invoker = true) AS
SELECT
  a.id        AS aircraft_id,
  a.tenant_id,
  a.registration,
  a.status    AS aircraft_status,
  g.count     AS grounding_squawks,
  o.count     AS overdue_grounding_items,
  (a.status = 'active' AND g.count = 0 AND o.count = 0) AS available,
  -- Why not, in words. A club calling a member to cancel their Saturday
  -- needs to be able to say which squawk did it.
  array_remove(
    ARRAY[CASE
            WHEN a.status = 'grounded' THEN 'Grounded by an administrator'
            WHEN a.status <> 'active'  THEN format('Aircraft is %s', a.status)
          END],
    NULL) || g.reasons || o.reasons AS grounding_reasons
FROM public.aircraft a
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format('Grounding squawk: %s', s.summary)
                            ORDER BY s.reported_at), ARRAY[]::text[]) AS reasons
    FROM public.squawks s
   WHERE s.aircraft_id = a.id
     AND s.grounding
     -- Only 'open' grounds. A deferral is precisely the decision that the
     -- aircraft may fly with the defect — that is what an MEL and 14 CFR
     -- 91.213 are for — so a deferred squawk clears the ground while staying
     -- an open item on the log. Lifting the deferral is a status change back
     -- to 'open', and the aircraft is grounded again without the deferral
     -- row that authorised the flights in between being touched.
     AND s.status = 'open'
) AS g
CROSS JOIN LATERAL (
  SELECT count(*) AS count,
         coalesce(array_agg(format(CASE WHEN mis.ever_complied
                                        THEN 'Overdue: %s'
                                        ELSE 'Not recorded: %s' END, mis.name)
                            ORDER BY mis.name), ARRAY[]::text[]) AS reasons
    FROM public.maintenance_item_status mis
   WHERE mis.aircraft_id = a.id
     AND mis.grounds_aircraft
     AND mis.state = 'overdue'
) AS o;

COMMENT ON VIEW public.aircraft_availability IS
  '§3.3: the one place that decides whether an aircraft may be booked. Three '
  'ways in — an admin''s grounding, a grounding squawk, an overdue inspection '
  '— and one answer out, so the booking path never has to know which (§6.2).';
