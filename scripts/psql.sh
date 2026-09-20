#!/usr/bin/env bash
# Interactive psql as any of the four roles. Default: app_role, because that
# is the one whose view of the world is worth checking.
#
#   scripts/psql.sh                    # app_role
#   scripts/psql.sh flightsquare_owner
#   scripts/psql.sh admin_role
#   scripts/psql.sh postgres

. "$(dirname "$0")/lib.sh"

require_db

role="${1:-app_role}"
dc exec -e PGPASSWORD="$(password_for "$role")" db \
  psql -U "$role" -d "$FS_DB_NAME"
