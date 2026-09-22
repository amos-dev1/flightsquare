#!/usr/bin/env bash
# Apply db/roles.sql to a database that already exists.
#
# initdb only runs on an empty data directory, so a role added after somebody
# has a database — mail_role in M8, say — never reaches them. This is that
# path: every statement in roles.sql is idempotent, so running it is safe
# whether the roles are there or not.
#
#   scripts/roles.sh
#
# Superuser, because creating a role needs one and nothing else here does.

. "$(dirname "$0")/lib.sh"

require_db

dc exec -T -e PGPASSWORD="$(password_for postgres)" db \
  psql -v ON_ERROR_STOP=1 -U postgres -d "$FS_DB_NAME" \
    -v db="$FS_DB_NAME" \
    -v owner_password="$FS_OWNER_PASSWORD" \
    -v app_password="$FS_APP_PASSWORD" \
    -v admin_password="$FS_ADMIN_PASSWORD" \
    -v mail_password="$FS_MAIL_PASSWORD" \
    -v scheduler_password="$FS_SCHEDULER_PASSWORD" \
    -f - < "$ROOT/db/roles.sql"

echo "✓ roles applied."
