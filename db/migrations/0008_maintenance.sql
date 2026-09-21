-- ===========================================================================
-- 0008_maintenance.sql — the rest of the core loop, and the signal at the end
--
--   flight logged -> meters advance -> maintenance items tick down
--      -> item comes due, or a squawk grounds the aircraft
--      -> aircraft_availability blocks new reservations
--
-- 0007 built the first arrow. This builds the rest of the chain, including
-- the part nothing consumes yet: `aircraft_availability` exists before the
-- scheduler does because §3.3 says designing that signal later means finding
-- every booking path later. One view now, or an archaeology exercise then.
--
-- Table classes (§2.2):
--   maintenance_interval_templates   global reference — no tenant_id, no RLS
--   maintenance_items   squawks   squawk_deferrals
--   work_orders         compliance_records                   tenant-scoped
--
-- Everything here is §7.2 **content**: maintenance discrepancy history is
-- litigation-grade, so admin_role gets no policy and no grant on any of it.
-- Only the preset library, which is reference data and contains no customer
-- record at all, is readable from the control plane.
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

-- ===========================================================================
-- The preset library (§3.6)
--
-- Global reference (§2.2): shared, read-only to the application, no
-- tenant_id, no RLS. Adding an aircraft should not mean typing in fifteen
-- intervals from scratch.
--
-- Versioned, because §3.6 asks a tenant's row to record **which template
-- version seeded it** — provenance, and nothing more. There is deliberately
-- no foreign key from maintenance_items back to here: a tenant's items are
-- their own rows from the moment they are created, and a live link would
-- mean editing a preset silently rewrote thousands of tenants' compliance
-- data. That is the same class of bug as a mutable billing rate (§3.7), and
-- worse, because this one has regulatory consequences.
-- ===========================================================================

CREATE TABLE public.maintenance_interval_templates (
  code                 text NOT NULL,
  version              smallint NOT NULL DEFAULT 1,
  name                 text NOT NULL,
  description          text,
  regulatory_reference text,

  -- Which aircraft it applies to. 'all', or matched against the aircraft's
  -- type designator, engine type or category from public.aircraft_types.
  applies_to           text NOT NULL DEFAULT 'all',
  applies_value        text,

  /**
   * Instantiated automatically when an aircraft is added, or merely offered.
   *
   * The 100-hour is the case that forces the distinction: 14 CFR 91.409(b)
   * requires it only for aircraft carrying persons for hire or used for
   * flight instruction for hire. Seeding one onto a private owner's aeroplane
   * would invent an inspection the FAA does not require and then ground the
   * aircraft over it. A club that instructs adds it in one tap.
   */
  auto_instantiate     boolean NOT NULL DEFAULT true,

  interval_months      smallint,
  interval_hours       numeric(8, 1),
  interval_cycles      integer,
  /** NULL means "whichever meter this aircraft is configured against". */
  hours_meter          text,

  grounds_aircraft     boolean NOT NULL DEFAULT false,
  warn_within_days     smallint NOT NULL DEFAULT 30,
  warn_within_hours    numeric(6, 1) NOT NULL DEFAULT 10.0,

  created_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (code, version),

  CONSTRAINT maintenance_interval_templates_applies_check
    CHECK ((applies_to = 'all' AND applies_value IS NULL)
        OR (applies_to IN ('type_code', 'engine_type', 'category')
            AND applies_value IS NOT NULL)),
  CONSTRAINT maintenance_interval_templates_meter_check
    CHECK (hours_meter IS NULL OR hours_meter IN ('hobbs', 'tach', 'airframe')),
  CONSTRAINT maintenance_interval_templates_has_interval_check
    CHECK (num_nonnulls(interval_months, interval_hours, interval_cycles) > 0)
);

COMMENT ON TABLE public.maintenance_interval_templates IS
  'Suggested schedules keyed by aircraft and engine type (§3.6). Instantiated '
  'as a copy; never referenced. Written by migrations and reference-data '
  'import jobs only, and it holds no customer data.';

-- ===========================================================================
-- maintenance_items — the tenant's own rows, freely editable
-- ===========================================================================

CREATE TABLE public.maintenance_items (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id            uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id          uuid NOT NULL,

  name                 text NOT NULL,
  description          text,
  regulatory_reference text,

  -- §5.5 and §10: an application-facing "delete" is a status. An archived
  -- item keeps its compliance history, which is the whole point of it.
  status               text NOT NULL DEFAULT 'active',

  /** Feeds aircraft_availability when the item goes overdue (§3.3). */
  grounds_aircraft     boolean NOT NULL DEFAULT false,

  -- §3.6: an item can be due on more than one basis at once, and the
  -- earliest wins. The resolution lives in maintenance_item_status below,
  -- because "how much is left" needs the aircraft's current meters.
  due_on               date,
  due_at_hours         numeric(10, 1),
  due_at_cycles        integer,
  /** NULL means the aircraft's configured maintenance meter. */
  hours_meter          text,

  -- What to add when compliance lands. An item with no interval is a
  -- one-off — an AD with no recurrence, a deferred defect with a deadline.
  interval_months      smallint,
  interval_hours       numeric(8, 1),
  interval_cycles      integer,

  warn_within_days     smallint NOT NULL DEFAULT 30,
  warn_within_hours    numeric(6, 1) NOT NULL DEFAULT 10.0,

  last_complied_on     date,
  last_complied_hours  numeric(10, 1),
  last_complied_cycles integer,

  -- Provenance only. Not a foreign key, on purpose: see the library above.
  template_code        text,
  template_version     smallint,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT maintenance_items_status_check
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT maintenance_items_meter_check
    CHECK (hours_meter IS NULL OR hours_meter IN ('hobbs', 'tach', 'airframe')),
  -- An item due on nothing never comes due, which makes it a note, not an
  -- inspection. The product has somewhere else to put notes.
  CONSTRAINT maintenance_items_has_a_basis_check
    CHECK (num_nonnulls(due_on, due_at_hours, due_at_cycles) > 0),
  CONSTRAINT maintenance_items_provenance_check
    CHECK ((template_code IS NULL) = (template_version IS NULL)),
  CONSTRAINT maintenance_items_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT maintenance_items_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX maintenance_items_aircraft_idx
  ON public.maintenance_items (tenant_id, aircraft_id, due_on)
  WHERE status = 'active';

-- Makes seeding an aircraft from the library idempotent: instantiating twice
-- cannot produce two annuals.
CREATE UNIQUE INDEX maintenance_items_template_key
  ON public.maintenance_items (tenant_id, aircraft_id, template_code)
  WHERE template_code IS NOT NULL AND status = 'active';

CREATE TRIGGER maintenance_items_set_updated_at
  BEFORE UPDATE ON public.maintenance_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- work_orders — performed work, parts, A&P/IA signoff (§3.6)
--
-- Defined before squawks so a squawk can point at the order that closed it.
-- ===========================================================================

CREATE TABLE public.work_orders (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id         uuid NOT NULL,

  /** The shop's own number, so a tenant can match this to their paperwork. */
  reference           text,
  description         text NOT NULL,
  performed_by        text,
  performed_on        date,

  /**
   * Parts as jsonb rather than a table of their own.
   *
   * Nothing in the product queries across parts — the questions asked of a
   * work order are all "what happened to this aircraft on this date". A
   * parts table arrives the day someone needs "which aircraft have this
   * cylinder", and not before.
   */
  parts               jsonb NOT NULL DEFAULT '[]'::jsonb,
  labor_hours         numeric(6, 1),
  -- §3.7 rule 3: integer minor units, and a currency code even while USD is
  -- the only one. This is not member billing — it is what the tenant paid a
  -- shop — but the rule about money is the same rule.
  cost_cents          integer,
  currency            char(3) NOT NULL DEFAULT 'USD',

  status              text NOT NULL DEFAULT 'open',

  -- The signoff. Once this is set the row stops being editable — see the
  -- guard trigger below. §3.6: never UPDATE a signed compliance record.
  signoff_name        text,
  signoff_certificate text,
  signoff_kind        text,
  signed_at           timestamptz,

  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT work_orders_status_check
    CHECK (status IN ('open', 'closed')),
  CONSTRAINT work_orders_signoff_kind_check
    CHECK (signoff_kind IS NULL
           OR signoff_kind IN ('a_and_p', 'ia', 'repairman', 'owner', 'other')),
  -- A signature is a person and a date together. Half of one is not a record
  -- of anything, and it is the half that would be relied on later.
  CONSTRAINT work_orders_signoff_complete_check
    CHECK ((signed_at IS NULL AND signoff_name IS NULL AND signoff_kind IS NULL)
        OR (signed_at IS NOT NULL AND signoff_name IS NOT NULL
            AND signoff_kind IS NOT NULL)),
  CONSTRAINT work_orders_non_negative_check
    CHECK (coalesce(cost_cents, 0) >= 0 AND coalesce(labor_hours, 0) >= 0),
  CONSTRAINT work_orders_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT work_orders_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX work_orders_aircraft_idx
  ON public.work_orders (tenant_id, aircraft_id, performed_on DESC);

CREATE TRIGGER work_orders_set_updated_at
  BEFORE UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The guard.
--
-- SECURITY INVOKER, and not a §2.3 helper: it holds no privilege the
-- application lacks. It refuses something app_role could otherwise do, which
-- is the opposite shape. A column grant cannot express "editable until
-- signed", because the rule depends on the row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.refuse_signed_work_order_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    -- A custom SQLSTATE rather than insufficient_privilege: this is a
    -- refusal the caller should hear about as a conflict, and the API reads
    -- a genuine 42501 as "the API tried to write outside its tenant" and
    -- turns it into a 500. Same reason assert_quota carries FS402.
    RAISE EXCEPTION 'work order % was signed on % and cannot be edited',
                    OLD.id, OLD.signed_at
      USING ERRCODE = 'FS409',
            HINT = 'Record a correcting work order instead; a signature is not revisable.';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER work_orders_refuse_signed_edit
  BEFORE UPDATE ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.refuse_signed_work_order_edit();

-- ===========================================================================
-- squawks — a reported defect (§3.6)
--
-- §1.5 keeps this resource separate from `maintenance` and that separation is
-- the central permission line in the product: a pilot reports a defect
-- (squawks: write) but does not sign off work, close an item, or record
-- compliance (maintenance: read). Collapsing the two makes that inexpressible.
-- ===========================================================================

CREATE TABLE public.squawks (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id          uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id        uuid NOT NULL,

  summary            text NOT NULL,
  details            text,

  /**
   * Severity is how bad it is. `grounding` is whether the aircraft flies.
   *
   * They are two columns because they are two judgements: 'grounding'
   * severity always grounds, but a mechanic can also ground something
   * reported as minor once they have looked at it. The reverse implication
   * is the one that does not hold, and the CHECK says only that.
   */
  severity           text NOT NULL DEFAULT 'minor',
  grounding          boolean NOT NULL DEFAULT false,

  status             text NOT NULL DEFAULT 'open',

  reported_by        uuid NOT NULL,
  reported_at        timestamptz NOT NULL DEFAULT now(),
  /** §8.2: when it was reported and when it arrived are not the same clock. */
  received_at        timestamptz NOT NULL DEFAULT now(),
  /** Optional: found on this flight, so the post-flight screen can file one. */
  found_on_flight_id uuid,

  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text,
  work_order_id      uuid,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT squawks_severity_check
    CHECK (severity IN ('advisory', 'minor', 'major', 'grounding')),
  CONSTRAINT squawks_status_check
    CHECK (status IN ('open', 'deferred', 'resolved')),
  CONSTRAINT squawks_grounding_severity_check
    CHECK (severity <> 'grounding' OR grounding),
  CONSTRAINT squawks_resolution_check
    CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT squawks_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT squawks_reported_by_fkey
    FOREIGN KEY (tenant_id, reported_by)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT squawks_resolved_by_fkey
    FOREIGN KEY (tenant_id, resolved_by)
    REFERENCES public.memberships (tenant_id, id),
  CONSTRAINT squawks_flight_fkey
    FOREIGN KEY (tenant_id, found_on_flight_id)
    REFERENCES public.flights (tenant_id, id),
  CONSTRAINT squawks_work_order_fkey
    FOREIGN KEY (tenant_id, work_order_id)
    REFERENCES public.work_orders (tenant_id, id),
  CONSTRAINT squawks_tenant_id_key UNIQUE (tenant_id, id)
);

CREATE INDEX squawks_aircraft_idx
  ON public.squawks (tenant_id, aircraft_id, reported_at DESC);

-- The query aircraft_availability runs on every booking, so it gets an index
-- of its own rather than a filter over the whole log.
CREATE INDEX squawks_grounding_open_idx
  ON public.squawks (tenant_id, aircraft_id)
  WHERE grounding AND status <> 'resolved';

CREATE TRIGGER squawks_set_updated_at BEFORE UPDATE ON public.squawks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- squawk_deferrals — append-only
--
-- §7.2 names deferral history, alongside the squawk log and the compliance
-- records, as what gets subpoenaed after an accident. A pair of mutable
-- columns on the squawk would let that history be rewritten by the next
-- deferral; rows cannot be. Lifting a deferral is a status change on the
-- squawk, which leaves the row that recorded it exactly where it was.
-- ---------------------------------------------------------------------------
CREATE TABLE public.squawk_deferrals (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id   uuid NOT NULL REFERENCES public.tenants(id),
  squawk_id   uuid NOT NULL,

  basis       text NOT NULL,
  /** The MEL item number, or whatever the basis is identified by. */
  reference   text,
  expires_on  date,
  note        text,

  deferred_by uuid NOT NULL,
  deferred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT squawk_deferrals_basis_check
    CHECK (basis IN ('mel', 'cdl', 'far_91_213', 'other')),
  CONSTRAINT squawk_deferrals_squawk_fkey
    FOREIGN KEY (tenant_id, squawk_id)
    REFERENCES public.squawks (tenant_id, id),
  CONSTRAINT squawk_deferrals_deferred_by_fkey
    FOREIGN KEY (tenant_id, deferred_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX squawk_deferrals_squawk_idx
  ON public.squawk_deferrals (tenant_id, squawk_id, deferred_at DESC);

-- ===========================================================================
-- compliance_records — AD / SB compliance, append-only, never edited (§3.6)
--
-- This is the table that gets subpoenaed. A correction is a new row pointing
-- at the one it supersedes, with actor and timestamp; nothing here is ever
-- UPDATEd and nothing is ever hard-deleted. The grants below are the
-- enforcement — SELECT and INSERT, and that is the whole list.
-- ===========================================================================

CREATE TABLE public.compliance_records (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id         uuid NOT NULL,
  /** What it satisfied, if anything. Compliance can also stand alone. */
  maintenance_item_id uuid,
  work_order_id       uuid,

  kind                text NOT NULL,
  /** 'AD 2020-03-16', 'SB M20-123', or blank for a routine inspection. */
  reference           text,
  title               text NOT NULL,
  method              text,

  complied_on         date NOT NULL,
  complied_at_hours   numeric(10, 1),
  complied_at_cycles  integer,
  hours_meter         text,

  /** A recurring AD states its own next due point; it is not an interval. */
  next_due_on         date,
  next_due_at_hours   numeric(10, 1),

  signed_by           text,
  signed_certificate  text,

  /** A correction points at the row it replaces; neither is ever deleted. */
  supersedes_id       uuid REFERENCES public.compliance_records(id),
  note                text,

  recorded_by         uuid,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT compliance_records_kind_check
    CHECK (kind IN ('inspection', 'ad', 'sb', 'overhaul', 'repair', 'other')),
  CONSTRAINT compliance_records_method_check
    CHECK (method IS NULL
           OR method IN ('inspection', 'modification', 'replacement', 'recurring')),
  CONSTRAINT compliance_records_meter_check
    CHECK (hours_meter IS NULL OR hours_meter IN ('hobbs', 'tach', 'airframe')),
  CONSTRAINT compliance_records_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id),
  CONSTRAINT compliance_records_item_fkey
    FOREIGN KEY (tenant_id, maintenance_item_id)
    REFERENCES public.maintenance_items (tenant_id, id),
  CONSTRAINT compliance_records_work_order_fkey
    FOREIGN KEY (tenant_id, work_order_id)
    REFERENCES public.work_orders (tenant_id, id),
  CONSTRAINT compliance_records_recorded_by_fkey
    FOREIGN KEY (tenant_id, recorded_by)
    REFERENCES public.memberships (tenant_id, id)
);

CREATE INDEX compliance_records_aircraft_idx
  ON public.compliance_records (tenant_id, aircraft_id, complied_on DESC);
CREATE INDEX compliance_records_item_idx
  ON public.compliance_records (tenant_id, maintenance_item_id)
  WHERE maintenance_item_id IS NOT NULL;
CREATE INDEX compliance_records_supersedes_idx
  ON public.compliance_records (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- ===========================================================================
-- The second arrow: compliance rolls the item forward
--
-- SECURITY INVOKER, and not a §2.3 helper — it writes maintenance_items,
-- which app_role may write anyway (a tenant's items are their own rows and
-- are freely editable). It lives in the database for the same reason
-- record_flight_meters does: "the annual was signed, so the next one is due"
-- must not be something a caller can forget. An item that stayed overdue
-- after its inspection would ground an airworthy aircraft; one that silently
-- did not roll forward would clear a due inspection nobody performed.
-- ===========================================================================

CREATE FUNCTION public.apply_compliance_to_item()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.maintenance_item_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.maintenance_items i
     SET last_complied_on     = NEW.complied_on,
         last_complied_hours  = coalesce(NEW.complied_at_hours, i.last_complied_hours),
         last_complied_cycles = coalesce(NEW.complied_at_cycles, i.last_complied_cycles),

         -- A record that states its own next due point wins: a recurring AD
         -- says when it comes back, and that is not an interval anyone here
         -- gets to compute.
         due_on = CASE
           WHEN NEW.next_due_on IS NOT NULL THEN NEW.next_due_on
           WHEN i.interval_months IS NOT NULL THEN
             -- 14 CFR 91.409 counts *calendar* months: an annual signed on
             -- 14 March 2026 is good until 31 March 2027, not the 14th.
             -- Getting this wrong grounds an aircraft a fortnight early, or
             -- — far worse — declares an out-of-annual aeroplane airworthy.
             (date_trunc('month', NEW.complied_on
                                  + make_interval(months => i.interval_months))
              + interval '1 month - 1 day')::date
           ELSE i.due_on
         END,

         due_at_hours = CASE
           WHEN NEW.next_due_at_hours IS NOT NULL THEN NEW.next_due_at_hours
           WHEN i.interval_hours IS NOT NULL AND NEW.complied_at_hours IS NOT NULL
             THEN NEW.complied_at_hours + i.interval_hours
           ELSE i.due_at_hours
         END,

         due_at_cycles = CASE
           WHEN i.interval_cycles IS NOT NULL AND NEW.complied_at_cycles IS NOT NULL
             THEN NEW.complied_at_cycles + i.interval_cycles
           ELSE i.due_at_cycles
         END
   WHERE i.id = NEW.maintenance_item_id;

  RETURN NULL;
END
$$;

CREATE TRIGGER compliance_records_apply_to_item
  AFTER INSERT ON public.compliance_records
  FOR EACH ROW EXECUTE FUNCTION public.apply_compliance_to_item();

-- ---------------------------------------------------------------------------
-- aircraft.engine_hours_since_overhaul, which 0006 declared and left NULL
-- with a note saying it arrives here.
--
-- Same §2.3 helper as before, extended rather than joined by a new one: the
-- reason it is SECURITY DEFINER has not changed, and the answer to §2.3's
-- question is the one 0006 already wrote down — the totals come from an
-- append-only log so the maintenance numbers downstream have an audit trail,
-- and an application that could write them directly would make that trail
-- optional.
--
-- The overhaul point comes from a compliance record, so the owner needs to
-- read that table under the same narrow 'meters' level. Nothing else about
-- the function changes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_aircraft_meter_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'meters'
AS $$
DECLARE
  v_aircraft        uuid := coalesce(NEW.aircraft_id, OLD.aircraft_id);
  v_overhaul_hours  numeric(10, 1);
  v_overhaul_meter  text;
BEGIN
  UPDATE public.aircraft a
     SET hobbs = (
           SELECT r.hobbs FROM public.meter_readings r
            WHERE r.aircraft_id = v_aircraft AND r.hobbs IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         tach = (
           SELECT r.tach FROM public.meter_readings r
            WHERE r.aircraft_id = v_aircraft AND r.tach IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         airframe_hours = (
           SELECT r.airframe_hours FROM public.meter_readings r
            WHERE r.aircraft_id = v_aircraft AND r.airframe_hours IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         cycles = (
           SELECT r.cycles FROM public.meter_readings r
            WHERE r.aircraft_id = v_aircraft AND r.cycles IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM public.meter_readings s
                               WHERE s.supersedes_id = r.id)
            ORDER BY r.recorded_at DESC, r.id DESC LIMIT 1),
         totals_updated_at = now()
   WHERE a.id = v_aircraft;

  -- The last overhaul that has not itself been superseded, and the meter it
  -- was read against — usually tach, but the record says which rather than
  -- this function assuming.
  SELECT c.complied_at_hours, coalesce(c.hours_meter, 'tach')
    INTO v_overhaul_hours, v_overhaul_meter
    FROM public.compliance_records c
   WHERE c.aircraft_id = v_aircraft
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
   WHERE a.id = v_aircraft;

  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.refresh_aircraft_meter_totals() FROM PUBLIC;

-- An overhaul moves the number without any meter being read, so the record
-- landing has to recompute it too.
CREATE TRIGGER compliance_records_refresh_totals
  AFTER INSERT ON public.compliance_records
  FOR EACH ROW EXECUTE FUNCTION public.refresh_aircraft_meter_totals();

-- ===========================================================================
-- Resolution: what is due, and what that means for the aircraft
--
-- Both views are `security_invoker`, which is not optional. A view defaults
-- to running with its **owner's** permissions, and the owner here is the DDL
-- role — so without this, selecting from either view would read every
-- tenant's maintenance history through a table nobody granted. The policies
-- on the underlying tables are what make these safe, and security_invoker is
-- what keeps the policies in the path.
-- ===========================================================================

CREATE VIEW public.maintenance_item_status
WITH (security_invoker = true) AS
SELECT
  i.id   AS maintenance_item_id,
  i.tenant_id,
  i.aircraft_id,
  i.name,
  i.status,
  i.grounds_aircraft,
  i.due_on,
  i.due_at_hours,
  i.due_at_cycles,
  m.hours_meter,
  m.current_hours,
  i.template_code,
  i.last_complied_on,
  -- Seeded from the library and never confirmed, or a real compliance date
  -- behind it. The difference is the difference between "we have no record"
  -- and "it is overdue", and only one of those is a claim about the aircraft.
  (i.last_complied_on IS NOT NULL OR i.last_complied_hours IS NOT NULL)
    AS ever_complied,

  -- Remaining on each basis, NULL where the item is not due on that basis.
  -- §3.6: items can be due on more than one at once, and the earliest wins —
  -- which is what `state` below resolves.
  (i.due_on - current_date)             AS days_remaining,
  (i.due_at_hours - m.current_hours)    AS hours_remaining,
  (i.due_at_cycles - a.cycles)          AS cycles_remaining,

  CASE
    WHEN i.status <> 'active' THEN 'inactive'
    -- Due *on* a date means good through that date: 91.409 counts calendar
    -- months, so an annual due 31 March is legal on 31 March.
    WHEN (i.due_on IS NOT NULL AND i.due_on < current_date)
      OR (i.due_at_hours IS NOT NULL AND m.current_hours IS NOT NULL
          AND m.current_hours >= i.due_at_hours)
      OR (i.due_at_cycles IS NOT NULL AND a.cycles IS NOT NULL
          AND a.cycles >= i.due_at_cycles)
      THEN 'overdue'
    WHEN (i.due_on IS NOT NULL AND i.due_on - current_date <= i.warn_within_days)
      OR (i.due_at_hours IS NOT NULL AND m.current_hours IS NOT NULL
          AND i.due_at_hours - m.current_hours <= i.warn_within_hours)
      THEN 'due_soon'
    ELSE 'ok'
  END AS state
FROM public.maintenance_items i
JOIN public.aircraft a ON a.id = i.aircraft_id
LEFT JOIN public.aircraft_config cfg ON cfg.aircraft_id = a.id
CROSS JOIN LATERAL (
  SELECT meter,
         CASE meter
           WHEN 'hobbs'    THEN a.hobbs
           WHEN 'airframe' THEN a.airframe_hours
           ELSE a.tach
         END AS current_hours
    FROM (SELECT coalesce(i.hours_meter, cfg.maintenance_meter, 'tach') AS meter) s
) AS m(hours_meter, current_hours);

COMMENT ON VIEW public.maintenance_item_status IS
  'Due resolution for §3.6. Kept as a view rather than stored columns because '
  'every answer here depends on current_date and on meters that advance '
  'underneath it — a stored "overdue" flag is wrong the morning after it is '
  'written, and wrong silently.';

-- ---------------------------------------------------------------------------
-- aircraft_availability — the §3.3 signal, built before it has a consumer
--
-- "Design the signal now even though the maintenance module is thin — a
-- resolved aircraft_availability view the booking path consults — because
-- retrofitting it means finding every booking path later."
--
-- So the rule lives here, once, and the scheduler will ask this view rather
-- than querying squawks directly. §6.2's checklist already says so.
-- ---------------------------------------------------------------------------
CREATE VIEW public.aircraft_availability
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
    ARRAY[CASE WHEN a.status <> 'active'
               THEN format('Aircraft is %s', a.status) END],
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
  '§3.3: the one place that decides whether an aircraft may be booked. '
  'Booking paths consult this rather than querying squawks, so the rule '
  'exists once (§6.2). Existing future reservations are flagged for review '
  'rather than cancelled when this flips — the club needs to call those '
  'members — and that belongs to the scheduler, which does not exist yet.';

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE public.maintenance_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance_items  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.squawks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squawks            FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.squawk_deferrals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squawk_deferrals   FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.work_orders        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_orders        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.compliance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_records FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.maintenance_items
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.squawks
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.squawk_deferrals
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.work_orders
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.compliance_records
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The 'meters' level, exactly as narrow as 0006's: the totals trigger needs
-- to find the last overhaul, and nothing more.
CREATE POLICY definer_meters_read ON public.compliance_records
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'meters');

-- No admin_read policy on any of the five. §7.2 puts maintenance_items,
-- squawks, work_orders and compliance_records in the **content** tier by
-- name, and squawk_deferrals is the deferral history the same paragraph
-- names. Reaching them takes a time-boxed, logged, tenant-consented grant,
-- and that mechanism does not exist yet — so the correct amount of access
-- from the control plane is none, and the default posture is deny.

-- ===========================================================================
-- Privileges
-- ===========================================================================

-- A tenant's items are their own rows and are freely editable (§3.6). No
-- DELETE: archiving is a status, and an archived item keeps its history.
GRANT SELECT, INSERT, UPDATE ON public.maintenance_items TO app_role;

-- Everything about a squawk moves except what was reported. `summary` and
-- `reported_by` carry no UPDATE grant: the defect someone wrote down is the
-- record, and a correction is a new squawk rather than a rewrite of the one
-- an investigator will read.
GRANT SELECT, INSERT ON public.squawks TO app_role;
GRANT UPDATE (details, severity, grounding, status, resolved_at, resolved_by,
              resolution_note, work_order_id)
  ON public.squawks TO app_role;

-- Append-only: lifting a deferral is a status change on the squawk, which
-- leaves the row that recorded the deferral untouched.
GRANT SELECT, INSERT ON public.squawk_deferrals TO app_role;

-- Editable until signed, and then not at all — the guard trigger, because
-- the rule depends on the row rather than on the column.
GRANT SELECT, INSERT, UPDATE ON public.work_orders TO app_role;

-- §3.6, and the shortest grant list in the schema for the best reason: never
-- UPDATE a signed compliance record, and never hard-delete one.
GRANT SELECT, INSERT ON public.compliance_records TO app_role;

-- Reference data: readable by everyone, written only by migrations.
GRANT SELECT ON public.maintenance_interval_templates TO app_role, admin_role;

-- The views are read-only by nature and carry the policies of the tables
-- under them. admin_role gets neither, for the same reason it gets no policy.
GRANT SELECT ON public.maintenance_item_status TO app_role;
GRANT SELECT ON public.aircraft_availability   TO app_role;

-- ===========================================================================
-- Instantiation — a copy, never a reference (§3.6)
--
-- SECURITY INVOKER, so it runs with the caller's rights and the caller's
-- tenant context: an aircraft belonging to someone else is simply not
-- visible, and the function returns 0 without needing to know why. Not a §2.3
-- helper — it holds no privilege app_role lacks, and it takes an aircraft id
-- rather than a tenant id.
--
-- It lives in SQL rather than in the API so that one implementation serves
-- both test suites and both clients, and so that the applicability rules sit
-- next to the library they read.
--
-- **What it does not know is the point.** Adding an aircraft tells us nothing
-- about when its last annual was, so a seeded item is due *now* rather than
-- an interval from now. Dating the annual twelve months out would assert the
-- aircraft is in annual — which the §11 guideline puts plainly: do not infer
-- "Airworthy" from the absence of a warning. A seeded item therefore reads as
-- due today (due_soon), goes overdue tomorrow, and carries no compliance
-- date at all until someone records one; `ever_complied` in the status view
-- is what lets the UI say "not recorded" rather than "overdue".
-- ===========================================================================

CREATE FUNCTION public.instantiate_maintenance_templates(p_aircraft_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_aircraft   record;
  v_engine     text;
  v_category   text;
  v_inserted   integer;
BEGIN
  SELECT a.id, a.tenant_id, a.type_code, a.hobbs, a.tach, a.airframe_hours
    INTO v_aircraft
    FROM public.aircraft a
   WHERE a.id = p_aircraft_id;

  -- No row means the policy hid it: another tenant's aircraft, or none.
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT t.engine_type, t.category INTO v_engine, v_category
    FROM public.aircraft_types t
   WHERE t.code = v_aircraft.type_code;

  WITH latest AS (
    -- The newest version of each preset. Older versions stay in the library
    -- because a tenant's row records the one that seeded it.
    SELECT DISTINCT ON (t.code) t.*
      FROM public.maintenance_interval_templates t
     ORDER BY t.code, t.version DESC
  ),
  applicable AS (
    SELECT * FROM latest t
     WHERE t.auto_instantiate
       AND (t.applies_to = 'all'
         OR (t.applies_to = 'type_code'   AND t.applies_value = v_aircraft.type_code)
         OR (t.applies_to = 'engine_type' AND t.applies_value = v_engine)
         OR (t.applies_to = 'category'    AND t.applies_value = v_category))
  )
  INSERT INTO public.maintenance_items
    (tenant_id, aircraft_id, name, description, regulatory_reference,
     grounds_aircraft, due_on, due_at_hours, hours_meter,
     interval_months, interval_hours, interval_cycles,
     warn_within_days, warn_within_hours, template_code, template_version)
  SELECT
    v_aircraft.tenant_id,
    v_aircraft.id,
    t.name,
    t.description,
    t.regulatory_reference,
    t.grounds_aircraft,
    CASE WHEN t.interval_months IS NOT NULL THEN current_date END,
    CASE WHEN t.interval_hours IS NOT NULL
         THEN coalesce(CASE coalesce(t.hours_meter, 'tach')
                         WHEN 'hobbs'    THEN v_aircraft.hobbs
                         WHEN 'airframe' THEN v_aircraft.airframe_hours
                         ELSE v_aircraft.tach
                       END, 0) END,
    t.hours_meter,
    t.interval_months,
    t.interval_hours,
    t.interval_cycles,
    t.warn_within_days,
    t.warn_within_hours,
    t.code,
    t.version
  FROM applicable t
  -- Idempotent: seeding an aircraft twice cannot produce two annuals.
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END
$$;

REVOKE ALL ON FUNCTION public.instantiate_maintenance_templates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.instantiate_maintenance_templates(uuid) TO app_role;

-- ===========================================================================
-- The library itself
--
-- Part 91 general aviation, and no further. Every entry names the regulation
-- it comes from, or says plainly that it is a manufacturer recommendation
-- rather than a requirement — because a tenant reading "due" needs to know
-- whether the consequence is an unairworthy aeroplane or a shorter engine
-- life, and those are not the same fact.
--
-- The dates here are a starting point a tenant edits, which is exactly what
-- "instantiate a copy" means: from the moment these land as rows they are the
-- tenant's, and nothing in this table can reach them again.
-- ===========================================================================

INSERT INTO public.maintenance_interval_templates
  (code, version, name, description, regulatory_reference, applies_to,
   applies_value, auto_instantiate, interval_months, interval_hours,
   interval_cycles, hours_meter, grounds_aircraft, warn_within_days,
   warn_within_hours) VALUES

  ('annual', 1, 'Annual inspection',
   'Required every 12 calendar months for any aircraft operated under Part 91. '
   'An aircraft out of annual is not airworthy.',
   '14 CFR 91.409(a)(1)', 'all', NULL, true, 12, NULL, NULL, NULL, true, 45, 10.0),

  ('100_hour', 1, '100-hour inspection',
   'Required only for aircraft carrying persons for hire or used for flight '
   'instruction for hire. Not required for private operation — add it if the '
   'aircraft instructs or is rented with an instructor.',
   '14 CFR 91.409(b)', 'all', NULL, false, NULL, 100.0, NULL, 'tach', true, 30, 10.0),

  ('elt_inspection', 1, 'ELT inspection',
   'Emergency locator transmitter inspected every 12 calendar months.',
   '14 CFR 91.207(d)', 'all', NULL, true, 12, NULL, NULL, NULL, false, 30, 10.0),

  ('elt_battery', 1, 'ELT battery replacement',
   'Replaced after one cumulative hour of use or when half of its useful life '
   'has expired. Set this to the expiry marked on the battery itself — the '
   'five-year interval here is a placeholder, not a rule.',
   '14 CFR 91.207(c)', 'all', NULL, true, 60, NULL, NULL, NULL, false, 60, 10.0),

  ('transponder', 1, 'Transponder check',
   'Required every 24 calendar months before the transponder may be used.',
   '14 CFR 91.413', 'all', NULL, true, 24, NULL, NULL, NULL, false, 45, 10.0),

  ('pitot_static', 1, 'Pitot-static and altimeter check',
   'Required every 24 calendar months for IFR operation. A VFR-only aircraft '
   'can archive this item.',
   '14 CFR 91.411', 'all', NULL, true, 24, NULL, NULL, NULL, false, 45, 10.0),

  ('vor_check', 1, 'VOR accuracy check',
   'Required within the preceding 30 days for IFR operation using VOR.',
   '14 CFR 91.171', 'all', NULL, false, 1, NULL, NULL, NULL, false, 7, 10.0),

  ('oil_change', 1, 'Oil and filter change',
   'Typical piston interval; follow the engine manufacturer''s schedule, which '
   'is often shorter for an engine that flies infrequently.',
   NULL, 'engine_type', 'piston', true, 4, 50.0, NULL, 'tach', false, 14, 5.0),

  ('spark_plugs', 1, 'Spark plug service',
   'Cleaning, gapping and rotation. Manufacturer recommendation, not a '
   'regulatory requirement.',
   NULL, 'engine_type', 'piston', false, NULL, 100.0, NULL, 'tach', false, 30, 10.0),

  ('engine_overhaul', 1, 'Engine overhaul (TBO)',
   'Manufacturer time between overhauls. For Part 91 operation this is a '
   'recommendation rather than a limit: reaching TBO does not make an aircraft '
   'unairworthy, and it is not a reason to ground one.',
   NULL, 'engine_type', 'piston', false, NULL, 2000.0, NULL, 'tach', false, 90, 100.0);
