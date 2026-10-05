#!/usr/bin/env bash
# Print the sign-in code waiting for an address.
#
#   scripts/code.sh dana.whitfield@demo.flightsquare.test
#   npm run code -- dana.whitfield@demo.flightsquare.test
#
# MFA is mandatory (0039), and in development mail goes to a log transport that
# marks a message delivered without sending it — so without this, a sign-in
# cannot be completed on a laptop with no mail provider configured.
#
# **This is not a bypass.** It prints the real code, which is still single-use,
# still expires in ten minutes, and is still the only thing that will satisfy
# `/auth/mfa`. Nothing here weakens the check; it stands in for an inbox.
#
# Runs as the owner, which holds a read on the outbox for exactly this kind of
# errand. app_role cannot read the table at all — the bodies carry live
# single-use credentials, and an application that could read them back could
# read every code and reset in flight.

. "$(dirname "$0")/lib.sh"

require_db

email="${1:-}"
if [ -z "$email" ]; then
  echo "usage: scripts/code.sh <email>" >&2
  exit 1
fi

# A psql variable, not string interpolation. §6 forbids raw SQL interpolation
# and gives scripts no exception.
# A psql variable, not string interpolation. §6 forbids raw SQL interpolation
# and gives scripts no exception.
#
# The outbox alone, deliberately. Reporting whether the token is still
# spendable would mean reading `users` and `auth_tokens`, which sit behind two
# different `app.auth_bootstrap` levels and cannot both be open at once — a lot
# of machinery for a dev errand. The age says the same thing: a code older than
# ten minutes has expired, and signing in again queues a fresh one.
printf '%s' "
SELECT substring(o.subject from '[0-9]{6}') AS code,
       to_char(o.created_at, 'HH24:MI:SS') AS queued,
       date_trunc('second', now() - o.created_at) AS age,
       CASE WHEN o.created_at > now() - interval '10 minutes'
            THEN 'good' ELSE 'expired — sign in again' END AS state
  FROM public.outbox o
 WHERE o.kind = 'mfa_code'
   AND lower(o.to_email) = lower(:'email')
 ORDER BY o.created_at DESC
 LIMIT 1;
" | psql_as "$OWNER_ROLE" -v email="$email"
