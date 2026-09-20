#!/usr/bin/env bash
# Apply pending migrations as the owner role.
#
# Forward-only (CLAUDE.md §6): each file runs once, inside a single
# transaction, and its checksum is recorded. Editing a migration that has
# already been applied is an error, not a silent no-op.

. "$(dirname "$0")/lib.sh"

require_db

psql_as "$OWNER_ROLE" -q <<'SQL'
SET client_min_messages = warning;
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user
);
SQL

applied_any=0

for file in "$ROOT"/db/migrations/*.sql; do
  version="$(basename "$file" .sql)"
  checksum="$(shasum -a 256 "$file" | cut -d' ' -f1)"

  recorded="$(printf '%s' \
    "SELECT checksum FROM public.schema_migrations WHERE version = :'version';" \
    | psql_as "$OWNER_ROLE" -tAq -v version="$version")"

  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$checksum" ]; then
      echo "✗ $version was modified after it was applied." >&2
      echo "  Migrations are forward-only — add a new migration instead." >&2
      exit 1
    fi
    echo "· $version (already applied)"
    continue
  fi

  echo "→ $version"
  {
    cat "$file"
    echo
    echo "INSERT INTO public.schema_migrations (version, checksum)"
    echo "VALUES (:'version', :'checksum');"
  } | psql_as "$OWNER_ROLE" -q -1 -v version="$version" -v checksum="$checksum"
  applied_any=1
done

if [ "$applied_any" -eq 0 ]; then
  echo "nothing to apply."
else
  echo "✓ migrations applied."
fi
