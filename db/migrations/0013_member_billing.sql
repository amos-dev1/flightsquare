-- ===========================================================================
-- 0013_member_billing.sql — M6: what the pilot owes the club
--
-- §3.7, and its four rules in the order it puts them, which is the order of
-- how expensive they are to get wrong:
--
--   1. Charges snapshot the rate; they never reference it. When the club
--      raises the rate from $140 to $155 in March, February's flights must
--      still read $140 forever. A live join re-prices history the moment
--      anyone edits a rate, and the first the treasurer hears of it is a
--      member disputing a statement they already paid.
--   2. Charges are append-only. A correction is a reversing entry plus a new
--      charge, with actor and reason. This is money, and it will be disputed.
--   3. Money is integer minor units.
--   4. Rates are effective-dated, so a rate change is a new row.
--
-- **This is member billing.** Pilot → their club. Not platform billing,
-- which is the tenant → FlightSquare and lives in `plans` and
-- `subscriptions`. §3.7 opens by insisting the two never share a name, and
-- nothing in this file touches the other one.
--
-- **v1 produces statements and does not move money** (V1_SCOPE M6,
-- confirmed). Recording that Dave paid $400 by cheque is a manual
-- adjustment, which is the smallest thing that makes a ledger balance.
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
-- The rate stops being a column
--
-- 0011 put `default_rate_cents` on `aircraft_config`, before there was
-- anywhere better — and a single mutable column is exactly what §3.7 rule 4
-- forbids: editing it would silently re-price nothing at the time and
-- everything in a report later. It becomes the first effective-dated row of
-- the table below, dated to when the aircraft was added.
--
-- `billing_meter` and `rate_basis` stay on the config. §3.7 lists them on
-- the rate row, and the invariant it is protecting is "charges snapshot,
-- never reference" — which holds either way, because the charge records both
-- alongside the amount. They are operational settings a club changes about
-- once, and V1_SCOPE M2 asks for them exactly where they are.
-- ---------------------------------------------------------------------------

CREATE TABLE public.aircraft_rates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id    uuid NOT NULL,

  /** §3.7 rule 3: integer minor units. Never float, never NUMERIC in JS. */
  amount_cents   integer NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'USD',

  /** Rule 4: a change is a new row. There is no UPDATE grant below. */
  effective_from date NOT NULL DEFAULT current_date,

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aircraft_rates_amount_check CHECK (amount_cents >= 0),
  CONSTRAINT aircraft_rates_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT aircraft_rates_created_by_fkey
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX aircraft_rates_lookup_idx
  ON public.aircraft_rates (tenant_id, aircraft_id, effective_from DESC);

/**
 * §3.7's second layer: "member-specific rate for this aircraft → aircraft
 * default rate".
 *
 * Two layers today. A third — a member-category rate for students,
 * associates or instructors — drops in later without restructuring, which is
 * the point of resolving it the same way §1.4 resolves everything else.
 */
CREATE TABLE public.member_aircraft_rates (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),
  membership_id  uuid NOT NULL,
  aircraft_id    uuid NOT NULL,

  amount_cents   integer NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'USD',
  effective_from date NOT NULL DEFAULT current_date,

  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT member_aircraft_rates_amount_check CHECK (amount_cents >= 0),
  CONSTRAINT member_aircraft_rates_member_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.memberships (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT member_aircraft_rates_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT member_aircraft_rates_created_by_fkey
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX member_aircraft_rates_lookup_idx
  ON public.member_aircraft_rates (tenant_id, membership_id, aircraft_id, effective_from DESC);

-- ===========================================================================
-- The ledger
-- ===========================================================================

/**
 * What a flight cost the member who flew it.
 *
 * §3.7 rule 1, spelled out in columns: the hours, the rate *applied*, and
 * **which rule supplied it** — never a foreign key to a rate row that
 * somebody may edit next March. This is the same principle as §7.8's
 * entitlement inspector: record the resolved value and its source, not a
 * pointer.
 */
CREATE TABLE public.flight_charges (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  flight_id     uuid,
  membership_id uuid NOT NULL,

  /** Which meter was billed, and how much of it. Snapshotted, not joined. */
  meter         text NOT NULL,
  meter_hours   numeric(10, 1) NOT NULL,
  rate_cents    integer NOT NULL,
  /** 'member' or 'aircraft' — which layer of §3.7's chain answered. */
  rate_source   text NOT NULL,
  /** Snapshotted too: whether fuel was included changes what this means. */
  rate_basis    text NOT NULL,

  amount_cents  integer NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'USD',

  /**
   * Rule 2: a correction is a reversing entry and a new charge, never an
   * edit. This points at what is being undone, and both rows stay.
   */
  reverses_id   uuid REFERENCES public.flight_charges(id),
  reason        text,

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT flight_charges_meter_check CHECK (meter IN ('hobbs', 'tach')),
  CONSTRAINT flight_charges_source_check CHECK (rate_source IN ('member', 'aircraft')),
  CONSTRAINT flight_charges_basis_check CHECK (rate_basis IN ('wet', 'dry')),
  -- A reversal carries a reason; an ordinary charge does not need one.
  CONSTRAINT flight_charges_reversal_reason_check
    CHECK (reverses_id IS NULL OR reason IS NOT NULL),
  CONSTRAINT flight_charges_flight_fkey
    FOREIGN KEY (tenant_id, flight_id)
    REFERENCES public.flights (tenant_id, id),
  CONSTRAINT flight_charges_member_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT flight_charges_created_by_fkey
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX flight_charges_member_idx
  ON public.flight_charges (tenant_id, membership_id, created_at DESC);
CREATE INDEX flight_charges_flight_idx
  ON public.flight_charges (tenant_id, flight_id) WHERE flight_id IS NOT NULL;

/**
 * §3.7's wet-rate half: "a wet rate includes fuel, so a pilot who buys fuel
 * is credited back against their charges."
 *
 * A dry rate produces nothing here at all — the fuel is simply the pilot's
 * own cost with no ledger effect — which is why the basis is snapshotted
 * onto the charge rather than looked up when a statement is drawn.
 */
CREATE TABLE public.fuel_credits (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  flight_id     uuid,
  membership_id uuid NOT NULL,

  quantity      numeric(6, 1),
  amount_cents  integer NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'USD',

  reverses_id   uuid REFERENCES public.fuel_credits(id),
  reason        text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fuel_credits_flight_fkey
    FOREIGN KEY (tenant_id, flight_id)
    REFERENCES public.flights (tenant_id, id),
  CONSTRAINT fuel_credits_member_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX fuel_credits_member_idx
  ON public.fuel_credits (tenant_id, membership_id, created_at DESC);

/**
 * The line an admin writes by hand — and, in v1, the whole of how money
 * moving is recorded.
 *
 * "Dave paid $400 by cheque" is an adjustment. V1_SCOPE calls that the
 * smallest thing that makes the ledger balance, and it is: the treasurer
 * settles by whatever they already use, and this says what happened.
 *
 * Sign convention: positive increases what the member owes, negative reduces
 * it. A payment is therefore negative, and so is a goodwill write-off.
 */
CREATE TABLE public.ledger_adjustments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants(id),
  membership_id uuid NOT NULL,

  amount_cents  integer NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'USD',
  /** Not optional. An unexplained line in a ledger is an argument later. */
  reason        text NOT NULL,

  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ledger_adjustments_reason_check CHECK (length(btrim(reason)) > 0),
  CONSTRAINT ledger_adjustments_member_fkey
    FOREIGN KEY (tenant_id, membership_id)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT ledger_adjustments_created_by_fkey
    FOREIGN KEY (tenant_id, created_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX ledger_adjustments_member_idx
  ON public.ledger_adjustments (tenant_id, membership_id, created_at DESC);

-- ===========================================================================
-- Resolving a rate — §3.7's chain, and the same shape as §1.4's
--
--   member-specific rate for this aircraft → aircraft default rate
--
-- Two layers today; a third drops in without restructuring, which is why it
-- is written as a chain rather than as a coalesce of two columns.
--
-- Effective-dated on both: the rate that was in force on the day of the
-- flight, not the one in force when the statement is drawn. That difference
-- is the entire reason rule 4 exists.
-- ===========================================================================

CREATE FUNCTION public.resolve_rate(
  p_aircraft_id   uuid,
  p_membership_id uuid,
  p_on            date
)
RETURNS TABLE (amount_cents integer, currency char(3), rate_source text)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  -- Each branch parenthesised: an ORDER BY inside a UNION arm belongs to
  -- that arm, and without the brackets it would be read as ordering the
  -- union itself — which is a different query and a syntax error besides.
  SELECT r.amount_cents, r.currency, r.source
    FROM (
      (SELECT m.amount_cents, m.currency, 'member'::text AS source, 1 AS layer
         FROM public.member_aircraft_rates m
        WHERE m.aircraft_id = p_aircraft_id
          AND m.membership_id = p_membership_id
          AND m.effective_from <= p_on
        ORDER BY m.effective_from DESC, m.id DESC
        LIMIT 1)

      UNION ALL

      (SELECT a.amount_cents, a.currency, 'aircraft'::text, 2
         FROM public.aircraft_rates a
        WHERE a.aircraft_id = p_aircraft_id
          AND a.effective_from <= p_on
        ORDER BY a.effective_from DESC, a.id DESC
        LIMIT 1)
    ) r
   ORDER BY r.layer
   LIMIT 1
$$;

COMMENT ON FUNCTION public.resolve_rate(uuid, uuid, date) IS
  'Returns no row when the club has never set a rate for the aircraft, which '
  'is the ordinary state of a free tenant and of any aeroplane nobody has '
  'priced yet. No rate means no charge — never a charge of zero, which would '
  'claim somebody flew for nothing.';

-- ===========================================================================
-- The last arrow of the core loop (§3.4)
--
--   flight logged -> meters advance -> maintenance ticks down
--              └→ charge computed against the pilot (§3.7)
--
-- A §2.3 privileged helper, and it passes that section's question — could
-- app_role simply be granted what it needs? **No.** A role that could write
-- its own charges could write a smaller one, and the ledger would be a
-- suggestion. Charges are *generated*; the only hand-written line in this
-- schema is an adjustment, which says who wrote it and why.
--
-- It also has to write a charge against whoever *flew*, which is not always
-- whoever filled in the form — and the reading policy scopes a pilot to
-- their own rows, so the caller frequently cannot see the row being made.
-- ===========================================================================

CREATE FUNCTION public.charge_for_flight()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'ledger'
AS $$
DECLARE
  v_flight   public.flights%ROWTYPE;
  v_config   public.aircraft_config%ROWTYPE;
  v_rate     record;
  v_hours    numeric(10, 1);
BEGIN
  SELECT * INTO v_flight FROM public.flights f WHERE f.id = NEW.flight_id;
  SELECT * INTO v_config FROM public.aircraft_config c
   WHERE c.aircraft_id = v_flight.aircraft_id;

  -- No configuration, no billing. A solo owner who never set a rate is the
  -- ordinary case, not an error.
  IF v_config.aircraft_id IS NULL THEN
    RETURN NULL;
  END IF;

  v_hours := CASE v_config.billing_meter
               WHEN 'tach' THEN NEW.tach_hours
               ELSE NEW.hobbs_hours
             END;

  -- The billing meter was not read on this flight. §3.4 records what was
  -- actually read and derives nothing from the other meter, so there is
  -- nothing to bill and nothing to guess.
  IF v_hours IS NULL OR v_hours <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_rate
    FROM public.resolve_rate(v_flight.aircraft_id, v_flight.flown_by, v_flight.flight_date);

  -- Never a charge of zero: that would claim somebody flew for nothing,
  -- where the truth is that nobody has priced the aeroplane.
  IF v_rate.amount_cents IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.flight_charges
    (tenant_id, flight_id, membership_id, meter, meter_hours,
     rate_cents, rate_source, rate_basis, amount_cents, currency)
  VALUES (NEW.tenant_id, NEW.flight_id, v_flight.flown_by,
          v_config.billing_meter, v_hours,
          v_rate.amount_cents, v_rate.rate_source, v_config.rate_basis,
          -- Rounded to the minor unit here, once, in integer arithmetic.
          round(v_hours * v_rate.amount_cents)::integer,
          v_rate.currency);

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.charge_for_flight() FROM PUBLIC;

CREATE TRIGGER flight_meters_charge
  AFTER INSERT ON public.flight_meters
  FOR EACH ROW EXECUTE FUNCTION public.charge_for_flight();

/**
 * §3.7's wet-rate credit.
 *
 * Fuel is two things (§3.4), and only one of them reaches the ledger:
 * `fuel_remaining_after` is aircraft state and never money, while
 * `fuel_added_cost_cents` is an immutable record of what somebody spent.
 * Whether that spend comes back to them is the aircraft's rate basis, and
 * nothing else.
 */
CREATE FUNCTION public.credit_fuel_for_flight()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'ledger'
AS $$
DECLARE
  v_flight public.flights%ROWTYPE;
  v_basis  text;
BEGIN
  IF NEW.fuel_added_cost_cents IS NULL OR NEW.fuel_added_cost_cents = 0 THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_flight FROM public.flights f WHERE f.id = NEW.flight_id;
  SELECT c.rate_basis INTO v_basis
    FROM public.aircraft_config c WHERE c.aircraft_id = v_flight.aircraft_id;

  -- Dry: the fuel is the pilot's own cost and the ledger never hears of it.
  IF v_basis IS DISTINCT FROM 'wet' THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.fuel_credits
    (tenant_id, flight_id, membership_id, quantity, amount_cents, currency)
  VALUES (NEW.tenant_id, NEW.flight_id, v_flight.flown_by,
          NEW.fuel_added_qty, NEW.fuel_added_cost_cents, NEW.currency);

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.credit_fuel_for_flight() FROM PUBLIC;

CREATE TRIGGER flight_fuel_credit
  AFTER INSERT ON public.flight_fuel
  FOR EACH ROW EXECUTE FUNCTION public.credit_fuel_for_flight();

-- ===========================================================================
-- Row-level security — and the first place §4.4's scope does real work
-- ===========================================================================

ALTER TABLE public.aircraft_rates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aircraft_rates        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.member_aircraft_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_aircraft_rates FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.flight_charges        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.flight_charges        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.fuel_credits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fuel_credits          FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.ledger_adjustments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_adjustments    FORCE  ROW LEVEL SECURITY;

-- What the aeroplane costs is the club's price list, and every member may
-- read it: a pilot deciding whether to fly needs to know the rate.
CREATE POLICY tenant_isolation ON public.aircraft_rates
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

/**
 * §10 decision 3, finally load-bearing.
 *
 * `app.owns_row('charges', membership_id)` is 'all' for an Admin and 'own'
 * for a Pilot, so the same policy gives the treasurer every row and gives a
 * member their own — with no `WHERE` clause anywhere above it to forget.
 *
 * A member's private arrangement is scoped by `charges` rather than by
 * `rates`: what an aeroplane costs is the price list, but what *Dave* pays
 * for it is part of Dave's financial business, which is what that scope is
 * there to protect.
 */
CREATE POLICY tenant_isolation ON public.member_aircraft_rates
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id));

CREATE POLICY tenant_isolation ON public.flight_charges
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id));

CREATE POLICY tenant_isolation ON public.fuel_credits
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id));

CREATE POLICY tenant_isolation ON public.ledger_adjustments
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.owns_row('charges', membership_id));

-- The 'ledger' level: what the two generating triggers need, and no more.
-- They write against whoever flew, which is frequently not whoever filled in
-- the form, and the reading policy above would hide that row from them.
CREATE POLICY definer_ledger ON public.flight_charges
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'ledger');
CREATE POLICY definer_ledger ON public.fuel_credits
  FOR INSERT TO flightsquare_owner
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'ledger');

-- §7.2: a ledger is what a member paid and when. Content, and reaching it
-- takes a time-boxed, logged, tenant-consented grant that does not exist.

-- ===========================================================================
-- Privileges
--
-- Every table here is append-only. §3.7 rule 2 is not a convention to be
-- remembered — it is the absence of an UPDATE grant.
-- ===========================================================================

GRANT SELECT, INSERT ON public.aircraft_rates        TO app_role;
GRANT SELECT, INSERT ON public.member_aircraft_rates TO app_role;

-- Charges are generated by the trigger above. INSERT exists here only for a
-- correction — a reversing entry an admin writes with a reason — which the
-- API gates on `charges: write`.
GRANT SELECT, INSERT ON public.flight_charges TO app_role;
GRANT SELECT, INSERT ON public.fuel_credits   TO app_role;

GRANT SELECT, INSERT ON public.ledger_adjustments TO app_role;

-- ===========================================================================
-- The rate that was a column becomes the first row
-- ===========================================================================

SET LOCAL app.auth_bootstrap = 'on';

DO $backfill$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM public.tenants ORDER BY id LOOP
    PERFORM set_config('app.tenant_id', t.id::text, true);

    INSERT INTO public.aircraft_rates
      (tenant_id, aircraft_id, amount_cents, currency, effective_from)
    SELECT c.tenant_id, c.aircraft_id, c.default_rate_cents, c.currency,
           -- Dated to when the aeroplane was added, because that is when the
           -- number was true from. Dating it today would re-price every
           -- flight already logged, which is the exact failure rule 1 exists
           -- to prevent.
           (a.created_at AT TIME ZONE 'UTC')::date
      FROM public.aircraft_config c
      JOIN public.aircraft a ON a.id = c.aircraft_id
     WHERE c.tenant_id = t.id
       AND c.default_rate_cents IS NOT NULL;
  END LOOP;

  PERFORM set_config('app.tenant_id', '', true);
END
$backfill$;

RESET app.auth_bootstrap;

ALTER TABLE public.aircraft_config DROP COLUMN default_rate_cents;
