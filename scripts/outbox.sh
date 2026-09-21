#!/usr/bin/env bash
# Print what would have been emailed.
#
#   scripts/outbox.sh          # the last 10, newest first
#   scripts/outbox.sh 40       # ... or however many
#
# v1 has no sender (M8). Every message is rendered by the API and queued in
# `outbox`, and this is how you read it — links included — so verification,
# invitation and password reset can all be walked end to end in development.
#
# Runs as the owner, because app_role deliberately cannot read this table:
# the bodies carry live single-use links, and an application that could read
# them back could read every reset link in flight.

. "$(dirname "$0")/lib.sh"

require_db

limit="${1:-10}"
case "$limit" in
  ''|*[!0-9]*) echo "usage: scripts/outbox.sh [count]" >&2; exit 1 ;;
esac

printf '%s' "
SELECT created_at, to_email, kind, subject, body
  FROM public.outbox
 ORDER BY created_at DESC
 LIMIT $limit;
" | psql_as "$OWNER_ROLE" -x
