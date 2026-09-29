#!/usr/bin/env bash
# The reference-data import job §2.2 has always promised.
#
#   ./scripts/import-aerodromes.sh                 # download and load
#   ./scripts/import-aerodromes.sh airports.csv    # load a file you already have
#
# `aerodromes` shipped with twenty rows and a comment saying why: "the real
# list is tens of thousands of rows and belongs to an import job (§2.2), not
# to a migration someone has to read". This is that job.
#
# The source is OurAirports (https://ourairports.com/data/), which is public
# domain. Its column names are the ones the table was designed around —
# ident, name, municipality, iso_region, iso_country — which is why the
# mapping below is almost a straight copy.
#
# §2.2: a global reference table is "written only by migrations and
# reference-data import jobs", and `app_role` holds SELECT on it and nothing
# else. So this runs as the owner, like a migration does, and unlike a
# migration it can be run again whenever the source updates: every row is an
# upsert keyed on `ident`, inside one transaction.
#
# What is deliberately not loaded:
#
#   * Closed fields. A closed aerodrome is not somewhere a flight departs
#     from, and leaving them in makes every search noisier.
#   * Rows with no identifier, name or country — the three columns the table
#     will not accept as null.

. "$(dirname "$0")/lib.sh"

require_db

SOURCE="${1:-}"
DOWNLOADED=""

cleanup() { [ -n "$DOWNLOADED" ] && rm -f "$DOWNLOADED"; }
trap cleanup EXIT

if [ -z "$SOURCE" ]; then
  SOURCE="$(mktemp -t airports)"
  DOWNLOADED="$SOURCE"
  echo "→ downloading airports.csv from ourairports.com"
  if ! curl -fsSL --max-time 300 -o "$SOURCE" \
      https://davidmegginson.github.io/ourairports-data/airports.csv; then
    echo "could not download the dataset." >&2
    echo "Fetch it yourself and pass the path:" >&2
    echo "  curl -O https://davidmegginson.github.io/ourairports-data/airports.csv" >&2
    echo "  ./scripts/import-aerodromes.sh airports.csv" >&2
    exit 1
  fi
fi

if [ ! -f "$SOURCE" ]; then
  echo "no such file: $SOURCE" >&2
  exit 1
fi

echo "→ loading $(basename "$SOURCE")"

# One stream into psql: the schema, then `COPY ... FROM STDIN` and the CSV
# itself, then the upsert. psql reads the data lines that follow the COPY out
# of the same input, which is the only way to get a local file into a
# container-side psql without copying it in first.
#
# Staged into a temporary table rather than upserted row by row: eighty
# thousand statements would take minutes, and one COPY takes seconds. The
# scratch table goes when the transaction does.
{
  cat <<'SQL'
BEGIN;

CREATE TEMPORARY TABLE ourairports (
  id                text,
  ident             text,
  type              text,
  name              text,
  latitude_deg      text,
  longitude_deg     text,
  elevation_ft      text,
  continent         text,
  iso_country       text,
  iso_region        text,
  municipality      text,
  scheduled_service text,
  icao_code         text,
  iata_code         text,
  gps_code          text,
  local_code        text,
  home_link         text,
  wikipedia_link    text,
  keywords          text
) ON COMMIT DROP;

COPY ourairports FROM STDIN WITH (FORMAT csv, HEADER true);
SQL

  cat "$SOURCE"
  printf '\\.\n'

  cat <<'SQL'

INSERT INTO public.aerodromes
  (ident, icao_code, iata_code, name, municipality, region, country,
   latitude, longitude, elevation_ft)
SELECT
  ident, icao_code, iata_code, name, municipality, region, country,
  latitude, longitude, elevation_ft
FROM (
  -- One row per identifier. The source carries a few duplicates, and the
  -- primary key would refuse the whole batch rather than the row.
  SELECT DISTINCT ON (upper(trim(ident)))
    upper(trim(ident))                                              AS ident,
    -- OurAirports splits the four-letter ICAO code out from `ident`, which
    -- is whatever the field is actually called. gps_code is where older
    -- exports put it.
    nullif(upper(trim(coalesce(icao_code, gps_code, ''))), '')      AS icao_code,
    nullif(upper(trim(coalesce(iata_code, ''))), '')                AS iata_code,
    trim(name)                                                      AS name,
    nullif(trim(coalesce(municipality, '')), '')                    AS municipality,
    -- `iso_region` is "US-IL"; the table wants the part after the country.
    nullif(split_part(coalesce(iso_region, ''), '-', 2), '')        AS region,
    upper(trim(iso_country))                                        AS country,
    -- Guarded casts: one malformed coordinate in eighty thousand rows should
    -- cost that row its position, not the whole import.
    CASE WHEN latitude_deg  ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN round(latitude_deg::numeric,  6) END                  AS latitude,
    CASE WHEN longitude_deg ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN round(longitude_deg::numeric, 6) END                  AS longitude,
    CASE WHEN elevation_ft  ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN round(elevation_ft::numeric)::integer END             AS elevation_ft
  FROM ourairports
  WHERE trim(coalesce(ident, '')) <> ''
    AND trim(coalesce(name, '')) <> ''
    AND trim(coalesce(iso_country, '')) <> ''
    AND coalesce(type, '') <> 'closed'
  ORDER BY upper(trim(ident)), id
) AS loaded
ON CONFLICT (ident) DO UPDATE SET
  icao_code    = excluded.icao_code,
  iata_code    = excluded.iata_code,
  name         = excluded.name,
  municipality = excluded.municipality,
  region       = excluded.region,
  country      = excluded.country,
  latitude     = excluded.latitude,
  longitude    = excluded.longitude,
  elevation_ft = excluded.elevation_ft;

COMMIT;

-- The planner has just had its row count change by three orders of
-- magnitude, and the trigram indexes 0019 added are no use to it until it
-- knows that.
ANALYZE public.aerodromes;
SQL
} | psql_as "$OWNER_ROLE" -q

count="$(printf '%s' 'SELECT count(*) FROM public.aerodromes;' | psql_as "$OWNER_ROLE" -tAq)"
echo "✓ ${count} aerodromes."
