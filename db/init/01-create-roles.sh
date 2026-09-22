#!/bin/sh
# Runs once, as the container superuser, on an empty data directory.
#
# Passwords are passed to psql as -v variables and referenced as :'name', so
# psql does the literal quoting. CLAUDE.md §6 forbids raw SQL string
# interpolation, and that rule does not get an exception for setup scripts.
set -e

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v db="$POSTGRES_DB" \
     -v owner_password="$FS_OWNER_PASSWORD" \
     -v app_password="$FS_APP_PASSWORD" \
     -v admin_password="$FS_ADMIN_PASSWORD" \
     -v mail_password="$FS_MAIL_PASSWORD" \
     -v scheduler_password="$FS_SCHEDULER_PASSWORD" \
     -f /opt/flightsquare/db/roles.sql
