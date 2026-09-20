#!/usr/bin/env bash
# Run the database test suite.
#
# Fixtures load as the container superuser — seeding is deliberately
# out-of-band, since there is no legitimate in-app path that writes rows for
# two different tenants (that is the property under test). Every assertion
# file then runs on a connection opened AS app_role, not as a superuser with
# SET ROLE, so what the tests exercise is exactly what the application gets.

. "$(dirname "$0")/lib.sh"

require_db

if ! printf '%s' "SELECT 1 FROM public.schema_migrations WHERE version = '0002_auth_functions';" \
   | psql_as "$OWNER_ROLE" -tAq | grep -q 1; then
  echo "migrations are not applied — run scripts/migrate.sh first" >&2
  exit 1
fi

echo "── fixtures ──────────────────────────────────────────────"
psql_as postgres -q < "$ROOT/db/tests/000_fixtures.sql"

failed=0
for file in "$ROOT"/db/tests/*.sql; do
  name="$(basename "$file" .sql)"
  case "$name" in 000_*) continue ;; esac

  echo
  echo "── $name ──────────────────────────────────────────────"
  if psql_as app_role -q < "$file"; then
    echo "   PASS"
  else
    echo "   FAIL"
    failed=1
  fi
done

echo
if [ "$failed" -eq 0 ]; then
  echo "✓ all database tests passed."
else
  echo "✗ database tests failed." >&2
  exit 1
fi
