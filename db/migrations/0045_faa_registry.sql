-- ===========================================================================
-- 0045 — the FAA aircraft registry, as reference data
--
-- Adding an aeroplane asks for its year, type and serial number, and for a
-- US-registered one all three are already public: the FAA publishes its
-- whole registry as a daily download (the "Releasable Aircraft Database").
-- These tables hold the parts of it worth suggesting, loaded by
-- scripts/import-faa-registry.sh, so typing a tail number on the add form can
-- fill the rest in.
--
-- Global reference (§2.2), like `aerodromes`: no tenant_id, no RLS, read-only
-- to the application, written only by migrations and the import job. Never
-- customer data — and deliberately never the registrant: MASTER.txt carries
-- owners' names and addresses, and the FAA lets private owners ask for those
-- to be withheld from broad dissemination. Nothing here needs them, so they
-- are not loaded at all.
--
-- Imported rather than called per request, so no third party learns which
-- tail numbers our tenants track, and a registry outage never reaches the
-- add form.
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

-- ACFTREF.txt: one row per FAA make/model/series code.
CREATE TABLE public.faa_aircraft_models (
  code          text PRIMARY KEY,
  manufacturer  text NOT NULL,
  model         text NOT NULL,
  engine_count  smallint,
  seats         smallint
);

COMMENT ON TABLE public.faa_aircraft_models IS
  'FAA aircraft reference (ACFTREF.txt): make and model per FAA code. Global '
  'reference (§2.2), loaded by scripts/import-faa-registry.sh.';

-- MASTER.txt, aircraft fields only: no registrant, no address.
CREATE TABLE public.faa_registrations (
  -- With its N, as it is painted and as `aircraft.registration` holds it.
  registration       text PRIMARY KEY,
  serial_number      text,
  model_code         text,
  year_manufactured  smallint,
  -- Amateur-built aeroplanes are registered under the builder's name as
  -- manufacturer; the kit is what says what they are.
  kit_manufacturer   text,
  kit_model          text,
  imported_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.faa_registrations IS
  'FAA registry (MASTER.txt), aircraft fields only — never the registrant. '
  'Global reference (§2.2), replaced wholesale by scripts/import-faa-registry.sh.';

/*
  FAA make and model to ICAO type designator.

  The registry names a type the way the type certificate does — CESSNA 172S,
  PIPER PA-28-181 — and `aircraft.type_code` is an ICAO designator with a
  foreign key to `aircraft_types`. These rules bridge the two, and are
  consulted at lookup time rather than baked in at import, so a rule added by
  a later migration applies to every registration at once.

  Deliberately conservative: a rule exists only where the FAA model clearly is
  the designator's aeroplane. Retractable and turbo variants with designators
  of their own (172RG is C72R, PA-28RT is P28T, a turbo Mooney is M20T) are
  left unmapped rather than suggested wrongly — a blank Type is a question,
  a wrong one is an answer somebody might not check. Patterns are matched
  against the upper-cased, trimmed FAA text, kit fields first.
*/
CREATE TABLE public.faa_type_rules (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manufacturer_pattern  text NOT NULL,
  model_pattern         text NOT NULL,
  type_code             text NOT NULL REFERENCES public.aircraft_types(code)
);

COMMENT ON TABLE public.faa_type_rules IS
  'Regex rules from FAA make/model to an ICAO designator in aircraft_types. '
  'Global reference (§2.2); first match by id wins.';

INSERT INTO public.faa_type_rules (manufacturer_pattern, model_pattern, type_code) VALUES
  ('^CESSNA',                              '^A?150[A-M]?$',                 'C150'),
  ('^CESSNA',                              '^A?152$',                       'C152'),
  ('^CESSNA',                              '^F?172[A-HJ-NP-S]?$',           'C172'),
  ('^CESSNA',                              '^175[A-C]?$',                   'C175'),
  ('^CESSNA',                              '^177[AB]?$',                    'C177'),
  ('^CESSNA',                              '^182[A-HJ-NP-T]?$',             'C182'),
  ('^CESSNA',                              '^A?185[A-F]?$',                 'C185'),
  ('^CESSNA',                              '^[PU]?206[A-H]?$',              'C206'),
  ('^CESSNA',                              '^210[A-HJ-NR]?$',               'C210'),
  ('^CESSNA',                              '^310[A-R]?$',                   'C310'),
  ('^(NEW )?PIPER',                        '^PA-28(-1[4-8][01](FL)?|S-1[68]0)?$', 'P28A'),
  ('^(NEW )?PIPER',                        '^PA-28R-(180|200|201)$',        'P28R'),
  ('^(NEW )?PIPER',                        '^PA-32R-30[01]$',               'P32R'),
  ('^(NEW )?PIPER',                        '^PA-18(-[0-9]+)?$',             'PA18'),
  ('^(NEW )?PIPER',                        '^PA-24(-[0-9]+)?$',             'PA24'),
  ('^(NEW )?PIPER',                        '^PA-34(-[0-9]+[A-Z]*)?$',       'PA34'),
  ('^(BEECH|RAYTHEON|HAWKER BEECH|TEXTRON AVIATION)', '^[A-G]?33[A-C]?$',  'BE33'),
  ('^(BEECH|RAYTHEON|HAWKER BEECH|TEXTRON AVIATION)', '^[A-Z]?35[AB]?( BONANZA)?$', 'BE35'),
  ('^(BEECH|RAYTHEON|HAWKER BEECH|TEXTRON AVIATION)', '^A?36$',            'BE36'),
  ('^(BEECH|RAYTHEON|HAWKER BEECH|TEXTRON AVIATION)', '^58$',              'BE58'),
  ('^(BEECH|RAYTHEON|HAWKER BEECH|TEXTRON AVIATION)', '^76$',              'BE76'),
  ('^CIRRUS',                              '^SR20$',                        'SR20'),
  ('^CIRRUS',                              '^SR22$',                        'SR22'),
  ('^CIRRUS',                              '^SR22T$',                       'S22T'),
  ('^DIAMOND',                             '^DA ?40',                       'DA40'),
  ('^DIAMOND',                             '^DA ?42',                       'DA42'),
  ('^MOONEY',                              '^M20[A-GJRS]?$',                'M20P'),
  ('^(GRUMMAN|AMERICAN|GULFSTREAM AMERICAN)', '^AA-5[ABC]?$',               'AA5'),
  ('^VAN',                                 '^RV-?7A?$',                     'RV7'),
  ('^VAN',                                 '^RV-?10$',                      'RV10'),
  ('^(CHAMPION|AMERICAN CHAMPION|BELLANCA)', '^(7ECA|7GCAA|7KCAB)',         'CH7A'),
  ('^(DAHER|SOCATA)',                      '^TBM ?9',                       'TBM9'),
  ('^ROBINSON',                            '^R22',                          'R22'),
  ('^ROBINSON',                            '^R44',                          'R44');

GRANT SELECT ON public.faa_aircraft_models, public.faa_registrations, public.faa_type_rules
  TO app_role, admin_role;
