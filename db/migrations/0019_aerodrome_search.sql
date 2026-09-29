-- ===========================================================================
-- 0019_aerodrome_search.sql — making the aerodrome table survive its own data
--
-- 0006 seeded `aerodromes` with twenty rows and said why in the table's own
-- comment: "Seeded thinly on purpose: the real list is tens of thousands of
-- rows and belongs to an import job (§2.2), not to a migration someone has to
-- read." `scripts/import-aerodromes.sh` is that job, and this is what the
-- table needs before it arrives.
--
-- `GET /reference/aerodromes?q=` searches three ways:
--
--     ident        ILIKE 'q%'     -- prefix
--     name         ILIKE '%q%'    -- substring
--     municipality ILIKE '%q%'    -- substring
--
-- At twenty rows every one of those is a sequential scan and nobody notices.
-- At eighty thousand the two substring searches still are, on every keystroke
-- of a form that suggests as you type. A leading wildcard cannot use a B-tree
-- at all, which is what trigram indexes are for.
--
-- `pg_trgm` has been a *trusted* extension since PostgreSQL 13, so the
-- database owner can create it without superuser — which is the only reason
-- this belongs in a migration rather than in a note asking somebody to run
-- psql as postgres.
--
-- The `ident` prefix search gets a plain index with `text_pattern_ops`: a
-- prefix match does not need trigrams, and the primary key's default operator
-- class cannot serve `LIKE` because the database is not in the C locale.
--
-- `aerodromes` is a §2.2 global reference table — no tenant_id, no RLS, SELECT
-- only to app_role — and none of that changes here. Indexes are not grants.
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

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Substring search, which is the expensive half.
CREATE INDEX IF NOT EXISTS aerodromes_name_trgm_idx
  ON public.aerodromes USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS aerodromes_municipality_trgm_idx
  ON public.aerodromes USING gin (municipality gin_trgm_ops);

-- Prefix search on the identifier, case-insensitively. `lower()` rather than
-- a citext column: the stored value is what people typed on a chart, and
-- changing its type would change what comes back out.
CREATE INDEX IF NOT EXISTS aerodromes_ident_prefix_idx
  ON public.aerodromes (lower(ident) text_pattern_ops);

COMMENT ON INDEX public.aerodromes_name_trgm_idx IS
  'Serves the leading-wildcard ILIKE in GET /reference/aerodromes?q=, which '
  'no B-tree can. Pointless at twenty rows and load-bearing at eighty '
  'thousand — see scripts/import-aerodromes.sh.';
