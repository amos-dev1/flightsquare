#!/usr/bin/env bash
# Everything, at once, reachable from a phone on the same Wi-Fi.
#
#   ./scripts/dev.sh            # bind to the LAN, print what to point a phone at
#   ./scripts/dev.sh --local    # 127.0.0.1 only, as before
#
# Five processes: the database (compose), the API, the web app, the mail
# sender and the maintenance sweep. Stopping this stops all of them.
#
# The reason it exists is the reason M9 is not the next milestone: almost
# everything in this product can be exercised at home, including Stripe (test
# mode, via `stripe listen`) and real email (set FS_MAIL_API_KEY). The line
# where a deployment becomes unavoidable is a device that is not on your
# network — TestFlight, and a club member at their own airfield.

. "$(dirname "$0")/lib.sh"

# ---------------------------------------------------------------------------
# Where this machine can be reached
#
# Four separate variables have to agree, and two of them are not obvious:
# FS_WEB_URL is what email links are built from, and FS_API_PUBLIC_URL is what
# the billing stub's checkout and portal URLs are built from. Point a phone at
# a LAN address and leave those two at 127.0.0.1 and a verification link opens
# on a host that phone has never heard of.
# ---------------------------------------------------------------------------
lan_address() {
  for interface in en0 en1 en2; do
    address="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
    if [ -n "$address" ]; then printf '%s' "$address"; return 0; fi
  done
  # Linux, or a Mac on something unusual.
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}' | head -1
}

if [ "${1:-}" = "--local" ]; then
  HOST=127.0.0.1
else
  HOST="$(lan_address)"
  if [ -z "$HOST" ]; then
    echo "could not work out this machine's LAN address; falling back to 127.0.0.1" >&2
    echo "(a phone will not be able to reach it — use --local to silence this)" >&2
    HOST=127.0.0.1
  fi
fi

export FS_API_HOST=0.0.0.0          # the API binds loopback by default
export FS_LAN_HOST="$HOST"          # web/next.config.ts trusts this origin
export FS_API_URL="http://$HOST:3000"
export FS_API_PUBLIC_URL="http://$HOST:3000"
export FS_WEB_URL="http://$HOST:3001"
export EXPO_PUBLIC_API_URL="http://$HOST:3000"

require_db

pids=()
stop() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop INT TERM EXIT

start() {
  local label="$1"; shift
  ( "$@" 2>&1 | sed "s/^/[$label] /" ) &
  pids+=($!)
}

start api   npm run dev -w api
start web   npm run dev -w web
start mail  npm run mail -w api
start sweep npm run sweep -w api

cat <<BANNER

  FlightSquare is up.

    web      http://$HOST:3001
    api      http://$HOST:3000

  On a phone on this Wi-Fi: open the web app at the address above, or run
  the app with

    EXPO_PUBLIC_API_URL=http://$HOST:3000 npx expo start   (from mobile/)

  Mail is logged, not sent — ./scripts/outbox.sh reads it. Set
  FS_MAIL_API_KEY to send for real. Stripe runs on the stub unless
  FS_STRIPE_SECRET_KEY is set; with it, forward webhooks here:

    stripe listen --forward-to $HOST:3000/webhooks/stripe

  Ctrl-C stops everything.

BANNER

wait
