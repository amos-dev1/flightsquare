-- ===========================================================================
-- 0007_flights.sql — flight logging, and the loop the product hangs off
--
--   flight logged -> meters advance -> maintenance items tick down
--
-- The first arrow is a trigger rather than application code. A flight whose
-- meters did not reach the log would leave every downstream number wrong
-- while looking completely fine, so the API is not trusted to remember.
--
-- Scope (§3.4): this tracks the **aircraft**, not the pilot. No experience
-- totals, no currency, no landings, no approaches, no endorsements. flown_by
-- is the billing subject and the accountability record — who had the plane,
-- who owes for it — and not the seed of an experience log. The whole pilot-
-- logbook story is a CSV export so people can transcribe into their own.
--
-- Table classes (§2.2): all tenant-scoped.
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

-- flown_by points at a membership, so the composite target has to exist.
ALTER TABLE public.memberships
  ADD CONSTRAINT memberships_tenant_id_key UNIQUE (tenant_id, id);

-- ===========================================================================
-- Idempotency (§8.2)
--
-- "Every write carries an idempotency key." Sync retries, spotty
-- connections and app backgrounding all produce duplicate submissions, and
-- the post-flight screen is used in exactly the conditions that cause them —
-- standing at a tiedown on a rural field with one bar or none.
--
-- Replaying a key returns the first response rather than doing the work
-- again. Replaying it with a *different* payload is a client bug, and gets
-- told so rather than silently overwriting.
-- ===========================================================================

CREATE TABLE public.idempotency_keys (
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  key           text NOT NULL,
  endpoint      text NOT NULL,
  /** Hash of the request body, so a replay with new content is detectable. */
  fingerprint   text NOT NULL,
  status_code   smallint NOT NULL,
  response      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, key),
  CONSTRAINT idempotency_keys_key_format_check
    CHECK (length(key) BETWEEN 8 AND 200)
);

CREATE INDEX idempotency_keys_created_idx
  ON public.idempotency_keys (created_at);

COMMENT ON TABLE public.idempotency_keys IS
  'Retention is a later job: rows older than the longest plausible retry '
  'window can be swept. Nothing reads them after that, and a tenant under '
  'legal_hold (§7.4) is exempt like everything else.';

-- ===========================================================================
-- flights
-- ===========================================================================

CREATE TABLE public.flights (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id   uuid NOT NULL,

  /** §3.4: the billing subject and the accountability record. */
  flown_by      uuid NOT NULL,

  flight_date   date NOT NULL,
  departed_from text REFERENCES public.aerodromes(ident),
  arrived_at    text REFERENCES public.aerodromes(ident),
  remarks       text,

  -- §8.2: a Hobbs start that does not match the previous flight's end is a
  -- **flag for the admin, never a rejection**. The gap is real information —
  -- usually a maintenance run or an unlogged flight — and refusing the entry
  -- would throw that information away along with the flight.
  needs_review  boolean NOT NULL DEFAULT false,
  review_reason text,

  -- §8.2: recorded-at and received-at are frequently different, sometimes by
  -- days. An entry made at the tiedown syncs when the phone finds signal.
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  received_at   timestamptz NOT NULL DEFAULT now(),

  created_by    uuid REFERENCES public.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT flights_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT flights_flown_by_fkey
    FOREIGN KEY (tenant_id, flown_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX flights_tenant_aircraft_idx
  ON public.flights (tenant_id, aircraft_id, flight_date DESC);
CREATE INDEX flights_tenant_member_idx
  ON public.flights (tenant_id, flown_by, flight_date DESC);
CREATE INDEX flights_needs_review_idx
  ON public.flights (tenant_id) WHERE needs_review;

CREATE TRIGGER flights_set_updated_at BEFORE UPDATE ON public.flights
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flights ADD CONSTRAINT flights_tenant_id_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- flight_meters
--
-- §3.4: Hobbs and tach are recorded **as read**, and neither is derived from
-- the other. They run at different rates by design, and the difference
-- between them is real data about how the aircraft was flown.
--
-- The hours are generated columns rather than something the client sends:
-- an end minus a start is not a fact anyone observed, and a client-computed
-- duration is a client-asserted duration (§8.2).
-- ---------------------------------------------------------------------------
CREATE TABLE public.flight_meters (
  flight_id   uuid PRIMARY KEY REFERENCES public.flights(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),

  hobbs_start numeric(10, 1),
  hobbs_end   numeric(10, 1),
  tach_start  numeric(10, 1),
  tach_end    numeric(10, 1),

  hobbs_hours numeric(10, 1) GENERATED ALWAYS AS (hobbs_end - hobbs_start) STORED,
  tach_hours  numeric(10, 1) GENERATED ALWAYS AS (tach_end - tach_start) STORED,

  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT flight_meters_hobbs_order_check
    CHECK (hobbs_start IS NULL OR hobbs_end IS NULL OR hobbs_end >= hobbs_start),
  CONSTRAINT flight_meters_tach_order_check
    CHECK (tach_start IS NULL OR tach_end IS NULL OR tach_end >= tach_start),
  -- A flight that advanced no meter did not happen as far as this product is
  -- concerned: advancing the meters is what a flight record is *for*.
  CONSTRAINT flight_meters_has_a_meter_check
    CHECK (hobbs_end IS NOT NULL OR tach_end IS NOT NULL),
  CONSTRAINT flight_meters_flight_fkey
    FOREIGN KEY (tenant_id, flight_id)
    REFERENCES public.flights (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX flight_meters_tenant_idx ON public.flight_meters (tenant_id);

-- ---------------------------------------------------------------------------
-- flight_fuel
--
-- §3.4 is emphatic that fuel is **two different things and must not be one
-- field**:
--
--   fuel_remaining_after is aircraft *state*. Latest reading wins; it tells
--   the next pilot what they are walking out to. It is never computed by
--   arithmetic across flights — pilots estimate, gauges lie, and someone
--   always tops off without logging it.
--
--   fuel_added_qty / fuel_added_cost is a *transaction*. It is an immutable
--   record of what someone spent, and it feeds member billing when the
--   aircraft is on a wet rate.
--
-- Fuel level is not a maintenance interval despite sitting next to them on
-- the form. It is current state with an optional low-level alert, and it
-- never grounds an aircraft on its own.
-- ---------------------------------------------------------------------------
CREATE TABLE public.flight_fuel (
  flight_id            uuid PRIMARY KEY REFERENCES public.flights(id) ON DELETE CASCADE,
  tenant_id            uuid NOT NULL REFERENCES public.tenants(id),

  /** State. */
  fuel_remaining_after numeric(6, 1),

  /** Transaction. */
  fuel_added_qty       numeric(6, 1),
  -- §3.7 rule 3: money is integer minor units. Never float, and a currency
  -- code even while USD is the only one.
  fuel_added_cost_cents integer,
  currency             char(3) NOT NULL DEFAULT 'USD',
  receipt_reference    text,

  created_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT flight_fuel_cost_needs_quantity_check
    CHECK (fuel_added_cost_cents IS NULL OR fuel_added_qty IS NOT NULL),
  CONSTRAINT flight_fuel_non_negative_check
    CHECK (coalesce(fuel_remaining_after, 0) >= 0
           AND coalesce(fuel_added_qty, 0) >= 0
           AND coalesce(fuel_added_cost_cents, 0) >= 0),
  CONSTRAINT flight_fuel_flight_fkey
    FOREIGN KEY (tenant_id, flight_id)
    REFERENCES public.flights (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX flight_fuel_tenant_idx ON public.flight_fuel (tenant_id);

-- A flight's meters land in the same append-only log as every other reading.
ALTER TABLE public.meter_readings
  ADD COLUMN flight_id uuid REFERENCES public.flights(id);

CREATE INDEX meter_readings_flight_idx
  ON public.meter_readings (flight_id) WHERE flight_id IS NOT NULL;

-- ===========================================================================
-- The first arrow of the core loop, as a trigger.
--
-- Not a §2.3 helper: SECURITY INVOKER, because app_role already holds every
-- grant this needs. It exists here rather than in the API because "flight
-- logged -> meters advance" must not be something a caller can forget. A
-- flight whose meters never reached the log leaves every maintenance number
-- downstream wrong while the flight itself looks perfectly fine.
-- ===========================================================================

CREATE FUNCTION public.record_flight_meters()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_flight     public.flights%ROWTYPE;
  v_prev_hobbs numeric(10, 1);
  v_prev_tach  numeric(10, 1);
  v_reason     text;
BEGIN
  SELECT * INTO v_flight FROM public.flights f WHERE f.id = NEW.flight_id;

  -- Read the aircraft's current totals *before* this flight's reading lands,
  -- so the comparison is against what the last pilot left behind.
  SELECT a.hobbs, a.tach INTO v_prev_hobbs, v_prev_tach
    FROM public.aircraft a WHERE a.id = v_flight.aircraft_id;

  -- §8.2: a start that does not meet the previous end is a flag for the
  -- admin, never a rejection. The gap is real information — usually a
  -- maintenance run or an unlogged flight — and refusing the entry would
  -- discard that information along with the flight nobody would then log.
  --
  -- format() builds a message, not SQL; §6's rule is about queries.
  IF NEW.hobbs_start IS NOT NULL AND v_prev_hobbs IS NOT NULL
     AND NEW.hobbs_start <> v_prev_hobbs THEN
    v_reason := format('Hobbs started at %s; the last reading was %s.',
                       NEW.hobbs_start, v_prev_hobbs);
  ELSIF NEW.tach_start IS NOT NULL AND v_prev_tach IS NOT NULL
     AND NEW.tach_start <> v_prev_tach THEN
    v_reason := format('Tach started at %s; the last reading was %s.',
                       NEW.tach_start, v_prev_tach);
  END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE public.flights f
       SET needs_review = true, review_reason = v_reason
     WHERE f.id = NEW.flight_id;
  END IF;

  -- Into the same append-only log as every other reading, which is what
  -- makes the correction path (supersedes_id) work for flights too.
  INSERT INTO public.meter_readings
    (tenant_id, aircraft_id, hobbs, tach, recorded_at, source, recorded_by, flight_id)
  VALUES (NEW.tenant_id, v_flight.aircraft_id, NEW.hobbs_end, NEW.tach_end,
          v_flight.recorded_at, 'flight', v_flight.created_by, NEW.flight_id);

  RETURN NULL;
END
$$;

CREATE TRIGGER flight_meters_record_reading
  AFTER INSERT ON public.flight_meters
  FOR EACH ROW EXECUTE FUNCTION public.record_flight_meters();

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE public.flights          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flights          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.flight_meters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_meters    FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.flight_fuel      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_fuel      FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_keys FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.flights
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.flight_meters
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.flight_fuel
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.idempotency_keys
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- No admin_role policy on any of these. §7.2 puts flights and flight_meters
-- squarely in the **content** tier: reaching them takes a time-boxed, logged,
-- tenant-consented grant, and that mechanism does not exist yet. Default
-- posture is deny, so silence here is the correct amount of access.

-- ===========================================================================
-- Privileges
-- ===========================================================================

GRANT SELECT, INSERT ON public.flights TO app_role;
-- Route and remarks are correctable. The review flag is writable because
-- clearing it — "I checked, the gap was an oil change" — is the admin action
-- it exists to prompt.
GRANT UPDATE (departed_from, arrived_at, remarks, needs_review, review_reason)
  ON public.flights TO app_role;

-- Insert-only. A wrong Hobbs is corrected by a new meter_reading that
-- supersedes the old one (§3.4), never by editing what was written down.
GRANT SELECT, INSERT ON public.flight_meters TO app_role;

-- Insert-only for the same reason, and one more: fuel_added_cost is an
-- immutable record of what someone spent, and it will be disputed (§3.7).
GRANT SELECT, INSERT ON public.flight_fuel TO app_role;

GRANT SELECT, INSERT ON public.idempotency_keys TO app_role;
