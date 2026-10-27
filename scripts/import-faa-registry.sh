#!/usr/bin/env bash
# Load the FAA aircraft registry, so adding a US aircraft can suggest its year,
# type and serial number from the tail number alone.
#
#   ./scripts/import-faa-registry.sh                          # download and load
#   ./scripts/import-faa-registry.sh ReleasableAircraft.zip   # load a zip you already have
#
# The source is the FAA's Releasable Aircraft Database, refreshed daily:
# https://www.faa.gov/licenses_certificates/aircraft_certification/aircraft_registry/releasable_aircraft_download
# Two of its files are read: MASTER.txt (every registered N-number) and
# ACFTREF.txt (the make/model reference it points into).
#
# §2.2, as for aerodromes: reference data is written only by migrations and
# import jobs, so this runs as the owner, and can be re-run whenever the FAA
# publishes — weekly is plenty. Both tables are replaced wholesale inside one
# transaction: a deregistered aircraft should stop being suggested, and an
# upsert would keep it forever.
#
# What is deliberately not loaded: the registrant. MASTER.txt carries owners'
# names and addresses, and nothing in FlightSquare needs them (0045).
#
# The files are comma-separated with space-padded fields, a byte-order mark,
# a trailing comma on every line, and the odd literal quote inside a field
# (BABY ACE "D"). So: CSV with quoting switched off — no field ever contains
# a comma — and one extra column to absorb the trailing one.

. "$(dirname "$0")/lib.sh"

require_db

SOURCE="${1:-}"
DOWNLOADED=""

cleanup() { [ -n "$DOWNLOADED" ] && rm -f "$DOWNLOADED"; }
trap cleanup EXIT

if [ -z "$SOURCE" ]; then
  # A template mktemp understands on macOS and on the image's busybox alike.
  SOURCE="$(mktemp "${TMPDIR:-/tmp}/faa-registry.XXXXXX")"
  DOWNLOADED="$SOURCE"
  echo "→ downloading the registry from registry.faa.gov (about 70 MB)"
  # The FAA's server refuses requests without a browser-like user agent.
  if ! curl -fsSL --max-time 600 -A "Mozilla/5.0 (FlightSquare reference import)" \
      -o "$SOURCE" https://registry.faa.gov/database/ReleasableAircraft.zip; then
    echo "could not download the registry." >&2
    echo "Fetch it yourself and pass the path:" >&2
    echo "  curl -A 'Mozilla/5.0' -O https://registry.faa.gov/database/ReleasableAircraft.zip" >&2
    echo "  ./scripts/import-faa-registry.sh ReleasableAircraft.zip" >&2
    exit 1
  fi
fi

if [ ! -f "$SOURCE" ]; then
  echo "no such file: $SOURCE" >&2
  exit 1
fi
for member in MASTER.txt ACFTREF.txt; do
  if ! unzip -l "$SOURCE" "$member" >/dev/null 2>&1; then
    echo "$SOURCE does not contain $member — is it the FAA's ReleasableAircraft.zip?" >&2
    exit 1
  fi
done

echo "→ loading $(basename "$SOURCE")"

# One stream into psql, as the aerodrome import does: the schema, each COPY
# followed by its file, then the replacement. Staged into temporary tables
# that go when the transaction does.
{
  cat <<'SQL'
BEGIN;

CREATE TEMPORARY TABLE faa_acftref (
  code text, mfr text, model text, type_acft text, type_eng text, ac_cat text,
  build_cert_ind text, no_eng text, no_seats text, ac_weight text, speed text,
  tc_data_sheet text, tc_data_holder text, end_of_line text
) ON COMMIT DROP;

CREATE TEMPORARY TABLE faa_master (
  n_number text, serial_number text, mfr_mdl_code text, eng_mfr_mdl text,
  year_mfr text, type_registrant text, name text, street text, street2 text,
  city text, state text, zip_code text, region text, county text, country text,
  last_action_date text, cert_issue_date text, certification text,
  type_aircraft text, type_engine text, status_code text, mode_s_code text,
  fract_owner text, air_worth_date text, other_names_1 text, other_names_2 text,
  other_names_3 text, other_names_4 text, other_names_5 text,
  expiration_date text, unique_id text, kit_mfr text, kit_model text,
  mode_s_code_hex text, end_of_line text
) ON COMMIT DROP;

COPY faa_acftref FROM STDIN WITH (FORMAT csv, HEADER true, QUOTE E'\x01');
SQL
  unzip -p "$SOURCE" ACFTREF.txt
  printf '\\.\n'

  cat <<'SQL'
COPY faa_master FROM STDIN WITH (FORMAT csv, HEADER true, QUOTE E'\x01');
SQL
  unzip -p "$SOURCE" MASTER.txt
  printf '\\.\n'

  cat <<'SQL'

TRUNCATE public.faa_registrations, public.faa_aircraft_models;

INSERT INTO public.faa_aircraft_models (code, manufacturer, model, engine_count, seats)
SELECT DISTINCT ON (trim(code))
  trim(code),
  trim(mfr),
  trim(model),
  CASE WHEN trim(no_eng)   ~ '^[0-9]{1,3}$' THEN trim(no_eng)::smallint END,
  CASE WHEN trim(no_seats) ~ '^[0-9]{1,3}$' THEN nullif(trim(no_seats)::smallint, 0) END
FROM faa_acftref
WHERE trim(coalesce(code, '')) <> ''
  AND trim(coalesce(mfr, '')) <> ''
  AND trim(coalesce(model, '')) <> ''
ORDER BY trim(code);

-- The registrant's columns are read by COPY because they are in the file,
-- and go no further than this temporary table.
INSERT INTO public.faa_registrations
  (registration, serial_number, model_code, year_manufactured, kit_manufacturer, kit_model)
SELECT DISTINCT ON (upper(trim(n_number)))
  'N' || upper(trim(n_number)),
  nullif(trim(serial_number), ''),
  nullif(trim(mfr_mdl_code), ''),
  CASE WHEN trim(year_mfr) ~ '^(18|19|20)[0-9]{2}$' THEN trim(year_mfr)::smallint END,
  nullif(trim(kit_mfr), ''),
  nullif(trim(kit_model), '')
FROM faa_master
WHERE trim(coalesce(n_number, '')) <> ''
ORDER BY upper(trim(n_number));

COMMIT;

ANALYZE public.faa_aircraft_models;
ANALYZE public.faa_registrations;
SQL
} | psql_as "$OWNER_ROLE" -q -v ON_ERROR_STOP=1

count="$(printf '%s' 'SELECT count(*) FROM public.faa_registrations;' | psql_as "$OWNER_ROLE" -tAq)"
echo "✓ ${count} registrations."
