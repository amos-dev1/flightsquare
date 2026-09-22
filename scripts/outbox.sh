#!/usr/bin/env bash
# Print what is in the mail queue.
#
#   scripts/outbox.sh          # the last 10, newest first
#   scripts/outbox.sh 40       # ... or however many
#
# The sender exists now (`npm run mail -w api`), but it only logs unless a
# transport is configured — so in development this is still how you read a
# verification or reset link, and it is also how you see what the worker did
# with a message: sent_at, attempts and the last error it hit.
#
# Runs as the owner, which holds a read for exactly this. app_role cannot
# read the table at all: the bodies carry live single-use links, and an
# application that could read them back could read every reset in flight.

. "$(dirname "$0")/lib.sh"

require_db

limit="${1:-10}"
case "$limit" in
  ''|*[!0-9]*) echo "usage: scripts/outbox.sh [count]" >&2; exit 1 ;;
esac

# Passed as a psql variable rather than pasted into the string. §6 forbids
# raw SQL interpolation and does not hand scripts an exception, even where
# the value has just been checked for digits.
printf '%s' "
SELECT created_at, to_email, kind, subject,
       coalesce(sent_at::text, 'not sent') AS sent,
       attempts, last_error, body
  FROM public.outbox
 ORDER BY created_at DESC
 LIMIT :limit;
" | psql_as "$OWNER_ROLE" -x -v limit="$limit"
