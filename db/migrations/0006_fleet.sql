-- ===========================================================================
-- 0006_fleet.sql — aircraft, and the meters everything downstream hangs off
--
-- Table classes (§2.2):
--   aircraft_types, aerodromes   global reference — no tenant_id, no RLS
--   aircraft, aircraft_config    tenant-scoped
--   meter_readings               tenant-scoped, append-only
--
-- aircraft_documents (§3.2) is deliberately absent. It is a table of pointers
-- into object storage, and there is no object storage yet; rows describing
-- attachments that cannot exist would be pre-building. It arrives with
-- `attachments` (§3.8).
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
-- Global reference (§2.2): shared, read-only to the application, no
-- tenant_id, **no RLS**. Written only by migrations and reference-data import
-- jobs, and never containing customer data.
--
-- This is the first time a table in this schema legitimately has no RLS, so
-- db/tests/030 gains an explicit allowlist rather than a blanket assertion.
-- The allowlist is the point: a table escapes RLS only by being named.
-- ===========================================================================

CREATE TABLE public.aircraft_types (
  code             text PRIMARY KEY,
  manufacturer     text NOT NULL,
  model            text NOT NULL,
  category         text NOT NULL,
  engine_type      text NOT NULL,
  engine_count     smallint NOT NULL DEFAULT 1,
  typical_seats    smallint,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aircraft_types_category_check
    CHECK (category IN ('airplane', 'rotorcraft', 'glider', 'lighter_than_air')),
  CONSTRAINT aircraft_types_engine_check
    CHECK (engine_type IN ('piston', 'turboprop', 'turbofan', 'turboshaft', 'electric', 'none'))
);

COMMENT ON TABLE public.aircraft_types IS
  'ICAO type designators. Global reference (§2.2): no tenant_id, no RLS, '
  'written by migrations and import jobs only. Seeded here with the types a '
  'Part 91 GA tenant is likely to fly; the full designator list is an import '
  'job, not a migration.';

CREATE TABLE public.aerodromes (
  ident        text PRIMARY KEY,
  icao_code    text,
  iata_code    text,
  name         text NOT NULL,
  municipality text,
  region       text,
  country      text NOT NULL,
  latitude     numeric(9, 6),
  longitude    numeric(9, 6),
  elevation_ft integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX aerodromes_icao_idx ON public.aerodromes (icao_code)
  WHERE icao_code IS NOT NULL;

COMMENT ON TABLE public.aerodromes IS
  'Keyed on the identifier people actually say — KPAO, 1C5 — because plenty '
  'of US fields have an FAA identifier and no ICAO code. Seeded thinly on '
  'purpose: the real list is tens of thousands of rows and belongs to an '
  'import job (§2.2), not to a migration someone has to read.';

-- ===========================================================================
-- aircraft
-- ===========================================================================

CREATE TABLE public.aircraft (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id),

  registration      text NOT NULL,
  type_code         text REFERENCES public.aircraft_types(code),
  serial_number     text,
  year_manufactured smallint,
  home_base         text REFERENCES public.aerodromes(ident),

  -- §5.5 and the deleted_at decision in §10: an application-facing "delete"
  -- is a status. An archived aircraft keeps its full flight and maintenance
  -- history and comes back on re-upgrade, so it must stay readable — which
  -- is exactly why hiding it at the database level would have been wrong.
  status            text NOT NULL DEFAULT 'active',
  ownership         text NOT NULL DEFAULT 'owned',

  -- ---- current totals -------------------------------------------------
  -- Maintained from meter_readings by a trigger, never written by the
  -- application: see the §2.3 helper below for why the column grants leave
  -- these out. §3.4 wants them materialised so nothing has to walk the whole
  -- reading history to answer "what's it at?".
  airframe_hours    numeric(10, 1),
  hobbs             numeric(10, 1),
  tach              numeric(10, 1),
  engine_hours_since_overhaul numeric(10, 1),
  cycles            integer,
  totals_updated_at timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  CONSTRAINT aircraft_status_check
    CHECK (status IN ('active', 'archived', 'sold')),
  CONSTRAINT aircraft_ownership_check
    CHECK (ownership IN ('owned', 'leased', 'leaseback', 'club_owned')),
  CONSTRAINT aircraft_registration_format_check
    CHECK (registration ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  CONSTRAINT aircraft_year_check
    CHECK (year_manufactured IS NULL OR year_manufactured BETWEEN 1900 AND 2100)
);

-- §3.2: registration is unique **per tenant, not globally**. A tail number is
-- unique in the real world, but two tenants legitimately track the same
-- aircraft — the concrete case is leaseback, where the owner tracks
-- maintenance and expenses while the club schedules it. Both are real records
-- against N123AB and neither is a duplicate. A global constraint here would
-- make the product unusable for the case it most needs to serve.
CREATE UNIQUE INDEX aircraft_tenant_registration_key
  ON public.aircraft (tenant_id, registration) WHERE deleted_at IS NULL;

-- §6.1 item 4: the index leads with tenant_id.
CREATE INDEX aircraft_tenant_status_idx
  ON public.aircraft (tenant_id, status) WHERE deleted_at IS NULL;

CREATE TRIGGER aircraft_set_updated_at BEFORE UPDATE ON public.aircraft
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- The composite target that lets aircraft_config and meter_readings carry
-- tenant_id without it being able to disagree with the aircraft's own. Same
-- pattern as role_bundle_permissions: the denormalisation is what keeps §1.1
-- literal, and the composite key is what keeps it honest.
ALTER TABLE public.aircraft ADD CONSTRAINT aircraft_tenant_id_key UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- aircraft_config — the per-aircraft settings the rest of the product reads.
-- ---------------------------------------------------------------------------
CREATE TABLE public.aircraft_config (
  aircraft_id       uuid PRIMARY KEY REFERENCES public.aircraft(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES public.tenants(id),

  seats             smallint,

  -- §3.4: which meter drives what is configuration, not hardcoded. Most
  -- tenants run engine and 100-hour intervals on tach and bill on Hobbs, but
  -- plenty do it differently and some aircraft have only one meter.
  maintenance_meter text NOT NULL DEFAULT 'tach',

  mel_reference     text,
  equipment         jsonb NOT NULL DEFAULT '{}'::jsonb,
  performance       jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT aircraft_config_maintenance_meter_check
    CHECK (maintenance_meter IN ('hobbs', 'tach', 'airframe')),
  -- The config and its aircraft cannot belong to different tenants.
  CONSTRAINT aircraft_config_tenant_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX aircraft_config_tenant_idx ON public.aircraft_config (tenant_id);

CREATE TRIGGER aircraft_config_set_updated_at
  BEFORE UPDATE ON public.aircraft_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ===========================================================================
-- meter_readings — append-only (§3.4)
--
-- People fat-finger Hobbs constantly, and the maintenance numbers downstream
-- need an audit trail rather than a silent overwrite. A correction is a new
-- row referencing the one it supersedes.
-- ===========================================================================

CREATE TABLE public.meter_readings (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL REFERENCES public.tenants(id),
  aircraft_id    uuid NOT NULL,

  hobbs          numeric(10, 1),
  tach           numeric(10, 1),
  airframe_hours numeric(10, 1),
  cycles         integer,

  -- §8.2: recorded-at and received-at are frequently different, sometimes by
  -- days, and the server orders by recorded-at rather than arrival. Two
  -- pilots flying the same aircraft on the same afternoon can sync in the
  -- wrong sequence, and that must not reorder the meters.
  recorded_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),

  source         text NOT NULL DEFAULT 'manual',
  recorded_by    uuid REFERENCES public.users(id),
  /** A correction points at the row it replaces; neither is ever deleted. */
  supersedes_id  uuid REFERENCES public.meter_readings(id),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT meter_readings_source_check
    CHECK (source IN ('manual', 'flight', 'maintenance', 'import')),
  -- A reading that records nothing is not a reading.
  CONSTRAINT meter_readings_has_a_value_check
    CHECK (num_nonnulls(hobbs, tach, airframe_hours, cycles) > 0),
  CONSTRAINT meter_readings_aircraft_fkey
    FOREIGN KEY (tenant_id, aircraft_id)
    REFERENCES public.aircraft (tenant_id, id)
);

CREATE INDEX meter_readings_aircraft_recorded_idx
  ON public.meter_readings (tenant_id, aircraft_id, recorded_at DESC);
CREATE INDEX meter_readings_supersedes_idx
  ON public.meter_readings (supersedes_id) WHERE supersedes_id IS NOT NULL;

-- ===========================================================================
-- §2.3 privileged helpers
--
-- Two triggers, and they are different shapes, so they get answered
-- separately against §2.3's own question — could app_role simply be granted
-- what it needs without also being able to abuse it?
--
--   refresh_aircraft_active_usage — no. It writes tenant_usage, and a role
--   that can write its own counters can set one to zero and walk past every
--   quota. Same answer as members.active, same family.
--
--   refresh_aircraft_meter_totals — no, for a different reason. The totals
--   are derived from an append-only log precisely so that the maintenance
--   numbers downstream have an audit trail (§3.4). If the application could
--   write them directly, the derivation would be a suggestion and the trail
--   would be optional. Granting UPDATE on those columns would not be a
--   convenience; it would delete the guarantee.
-- ===========================================================================

CREATE FUNCTION public.refresh_aircraft_active_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'usage'
AS $$
DECLARE v_tenant uuid := coalesce(NEW.tenant_id, OLD.tenant_id);
BEGIN
  INSERT INTO public.tenant_usage AS u (tenant_id, quota_key, current_value)
  VALUES (v_tenant, 'aircraft.active',
          (SELECT count(*) FROM public.aircraft a
            WHERE a.tenant_id = v_tenant
              AND a.status = 'active'
              AND a.deleted_at IS NULL))
  ON CONFLICT (tenant_id, quota_key)
  DO UPDATE SET current_value = EXCLUDED.current_value, updated_at = now();
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.refresh_aircraft_active_usage() FROM PUBLIC;

CREATE TRIGGER aircraft_refresh_usage
  AFTER INSERT OR UPDATE OR DELETE ON public.aircraft
  FOR EACH ROW EXECUTE FUNCTION public.refresh_aircraft_active_usage();

-- ---------------------------------------------------------------------------
-- Current totals: latest reading wins, per meter, ordered by recorded_at.
--
-- Per meter, because a reading may carry Hobbs and not tach — a fuel stop
-- logs one, an annual logs the other. Ordered by recorded_at rather than
-- arrival because §8.2 says readings arrive out of order and the gap is real
-- information. Superseded rows are skipped but never removed: a correction is
-- a new row pointing at the one it replaces, and both stay.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.refresh_aircraft_meter_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
SET app.auth_bootstrap = 'meters'
AS $$
DECLARE v_aircraft uuid := coalesce(NEW.aircraft_id, OLD.aircraft_id);
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
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.refresh_aircraft_meter_totals() FROM PUBLIC;

CREATE TRIGGER meter_readings_refresh_totals
  AFTER INSERT ON public.meter_readings
  FOR EACH ROW EXECUTE FUNCTION public.refresh_aircraft_meter_totals();

COMMENT ON COLUMN public.aircraft.engine_hours_since_overhaul IS
  'Not yet maintained: it is tach minus the last overhaul point, and overhaul '
  'records arrive with the maintenance module (§3.6). The column exists '
  'because §3.2 names it among the current totals.';

-- ===========================================================================
-- Row-level security
-- ===========================================================================

ALTER TABLE public.aircraft        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aircraft        FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.aircraft_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aircraft_config FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.meter_readings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meter_readings  FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.aircraft
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id() AND deleted_at IS NULL)
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.aircraft_config
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_isolation ON public.meter_readings
  FOR ALL TO app_role, flightsquare_owner
  USING      (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- The counting trigger reads aircraft; the totals trigger reads the log and
-- writes the aircraft row. Two levels, each as narrow as its job.
CREATE POLICY definer_usage ON public.aircraft
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'usage');

CREATE POLICY definer_meters_read ON public.meter_readings
  FOR SELECT TO flightsquare_owner
  USING (current_setting('app.auth_bootstrap', true) = 'meters');

CREATE POLICY definer_meters_write ON public.aircraft
  FOR UPDATE TO flightsquare_owner
  USING      (current_setting('app.auth_bootstrap', true) = 'meters')
  WITH CHECK (current_setting('app.auth_bootstrap', true) = 'meters');

-- §7.2 metadata tier: "aircraft (registration, type, status — not squawk or
-- log detail)". The row filter is a policy; the column filter is a grant,
-- below. meter_readings gets neither — a maintenance discrepancy history is
-- content, and content needs a time-boxed, logged, tenant-consented grant.
CREATE POLICY admin_read ON public.aircraft
  FOR SELECT TO admin_role USING (true);

-- ===========================================================================
-- Privileges
-- ===========================================================================

GRANT SELECT, INSERT ON public.aircraft TO app_role;
-- The totals are absent by design: they are derived from an append-only log,
-- and an application that can write them directly makes that log optional.
GRANT UPDATE (registration, type_code, serial_number, year_manufactured,
              home_base, status, ownership)
  ON public.aircraft TO app_role;

GRANT SELECT, INSERT, UPDATE ON public.aircraft_config TO app_role;

-- Append-only (§3.4): a correction is a new row, never an edit.
GRANT SELECT, INSERT ON public.meter_readings TO app_role;

-- Global reference is readable by everyone and written only by migrations.
GRANT SELECT ON public.aircraft_types, public.aerodromes TO app_role, admin_role;

-- §7.2, column by column: identity and status, never operating detail.
GRANT SELECT (id, tenant_id, registration, type_code, serial_number,
              year_manufactured, home_base, status, ownership, created_at)
  ON public.aircraft TO admin_role;

-- ===========================================================================
-- Reference seed
--
-- Enough to fly a Part 91 GA tenant on day one, and no more. The full ICAO
-- designator list and the ~20,000 US aerodromes belong to an import job
-- (§2.2) — putting them in a migration would mean nobody ever reads this
-- file again.
-- ===========================================================================

INSERT INTO public.aircraft_types
  (code, manufacturer, model, category, engine_type, engine_count, typical_seats) VALUES
  ('C150', 'Cessna',    '150',              'airplane', 'piston', 1, 2),
  ('C152', 'Cessna',    '152',              'airplane', 'piston', 1, 2),
  ('C172', 'Cessna',    '172 Skyhawk',      'airplane', 'piston', 1, 4),
  ('C175', 'Cessna',    '175 Skylark',      'airplane', 'piston', 1, 4),
  ('C177', 'Cessna',    '177 Cardinal',     'airplane', 'piston', 1, 4),
  ('C182', 'Cessna',    '182 Skylane',      'airplane', 'piston', 1, 4),
  ('C185', 'Cessna',    '185 Skywagon',     'airplane', 'piston', 1, 6),
  ('C206', 'Cessna',    '206 Stationair',   'airplane', 'piston', 1, 6),
  ('C210', 'Cessna',    '210 Centurion',    'airplane', 'piston', 1, 6),
  ('C310', 'Cessna',    '310',              'airplane', 'piston', 2, 6),
  ('P28A', 'Piper',     'PA-28 Cherokee',   'airplane', 'piston', 1, 4),
  ('P28R', 'Piper',     'PA-28R Arrow',     'airplane', 'piston', 1, 4),
  ('P32R', 'Piper',     'PA-32R Saratoga',  'airplane', 'piston', 1, 6),
  ('PA18', 'Piper',     'PA-18 Super Cub',  'airplane', 'piston', 1, 2),
  ('PA24', 'Piper',     'PA-24 Comanche',   'airplane', 'piston', 1, 4),
  ('PA34', 'Piper',     'PA-34 Seneca',     'airplane', 'piston', 2, 6),
  ('BE33', 'Beechcraft','33 Debonair',      'airplane', 'piston', 1, 4),
  ('BE35', 'Beechcraft','35 Bonanza',       'airplane', 'piston', 1, 4),
  ('BE36', 'Beechcraft','36 Bonanza',       'airplane', 'piston', 1, 6),
  ('BE58', 'Beechcraft','58 Baron',         'airplane', 'piston', 2, 6),
  ('BE76', 'Beechcraft','76 Duchess',       'airplane', 'piston', 2, 4),
  ('SR20', 'Cirrus',    'SR20',             'airplane', 'piston', 1, 4),
  ('SR22', 'Cirrus',    'SR22',             'airplane', 'piston', 1, 4),
  ('DA40', 'Diamond',   'DA40 Diamond Star','airplane', 'piston', 1, 4),
  ('DA42', 'Diamond',   'DA42 Twin Star',   'airplane', 'piston', 1, 4),
  ('M20P', 'Mooney',    'M20 (piston)',     'airplane', 'piston', 1, 4),
  ('AA5',  'Grumman',   'AA-5 Tiger',       'airplane', 'piston', 1, 4),
  ('RV7',  'Van''s',    'RV-7',             'airplane', 'piston', 1, 2),
  ('RV10', 'Van''s',    'RV-10',            'airplane', 'piston', 1, 4),
  ('CH7A', 'Champion',  '7 Citabria',       'airplane', 'piston', 1, 2),
  ('S22T', 'Cirrus',    'SR22T',            'airplane', 'piston', 1, 4),
  ('TBM9', 'Daher',     'TBM 900',          'airplane', 'turboprop', 1, 6),
  ('R22',  'Robinson',  'R22',              'rotorcraft', 'piston', 1, 2),
  ('R44',  'Robinson',  'R44',              'rotorcraft', 'piston', 1, 4);

INSERT INTO public.aerodromes
  (ident, icao_code, iata_code, name, municipality, region, country,
   latitude, longitude, elevation_ft) VALUES
  ('KPAO', 'KPAO', 'PAO', 'Palo Alto Airport',            'Palo Alto',   'CA', 'US',  37.461111, -122.115000,    7),
  ('KSQL', 'KSQL', 'SQL', 'San Carlos Airport',           'San Carlos',  'CA', 'US',  37.511944, -122.249722,    5),
  ('KRHV', 'KRHV', 'RHV', 'Reid-Hillview Airport',        'San Jose',    'CA', 'US',  37.332778, -121.819444,  135),
  ('KHWD', 'KHWD', 'HWD', 'Hayward Executive Airport',    'Hayward',     'CA', 'US',  37.659167, -122.121667,   52),
  ('KLVK', 'KLVK', 'LVK', 'Livermore Municipal Airport',  'Livermore',   'CA', 'US',  37.693333, -121.819722,  400),
  ('KCCR', 'KCCR', 'CCR', 'Buchanan Field',               'Concord',     'CA', 'US',  37.989722, -122.056944,   26),
  ('KAPC', 'KAPC', 'APC', 'Napa County Airport',          'Napa',        'CA', 'US',  38.213056, -122.280833,   35),
  ('KTRK', 'KTRK', 'TRK', 'Truckee Tahoe Airport',        'Truckee',     'CA', 'US',  39.320000, -120.139722, 5901),
  ('KBED', 'KBED', 'BED', 'Laurence G. Hanscom Field',    'Bedford',     'MA', 'US',  42.470000,  -71.289000,  133),
  ('KTEB', 'KTEB', 'TEB', 'Teterboro Airport',            'Teterboro',   'NJ', 'US',  40.850000,  -74.060833,    9),
  ('KFRG', 'KFRG', 'FRG', 'Republic Airport',             'Farmingdale', 'NY', 'US',  40.728889,  -73.413333,   82),
  ('KADS', 'KADS', 'ADS', 'Addison Airport',              'Dallas',      'TX', 'US',  32.968611,  -96.836389,  644),
  ('KEGE', 'KEGE', 'EGE', 'Eagle County Regional Airport','Eagle',       'CO', 'US',  39.642500, -106.917778, 6548),
  ('KBJC', 'KBJC', 'BJC', 'Rocky Mountain Metropolitan',  'Denver',      'CO', 'US',  39.908889, -105.117222, 5673),
  ('KPWK', 'KPWK', 'PWK', 'Chicago Executive Airport',    'Chicago',     'IL', 'US',  42.114167,  -87.901389,  647),
  ('KSUS', 'KSUS', 'SUS', 'Spirit of St. Louis Airport',  'St. Louis',   'MO', 'US',  38.662222,  -90.652000,  463),
  ('KPDK', 'KPDK', 'PDK', 'DeKalb-Peachtree Airport',     'Atlanta',     'GA', 'US',  33.875556,  -84.302000, 1003),
  ('KHIO', 'KHIO', 'HIO', 'Portland-Hillsboro Airport',   'Hillsboro',   'OR', 'US',  45.540278, -122.949722,  208),
  ('KBFI', 'KBFI', 'BFI', 'Boeing Field',                 'Seattle',     'WA', 'US',  47.530000, -122.302000,   21),
  ('KDVT', 'KDVT', 'DVT', 'Phoenix Deer Valley Airport',  'Phoenix',     'AZ', 'US',  33.688333, -112.083056, 1478);
