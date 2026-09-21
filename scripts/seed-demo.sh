#!/usr/bin/env bash
# Create a local account to sign in with.
#
#   scripts/seed-demo.sh                     # demo@flightsquare.local / demo
#   scripts/seed-demo.sh me@example.test my-club
#
# This exists because neither client has a signup screen yet — §9 says the web
# app will own signup and it does not, so the first account has to come from
# POST /auth/signup. It creates the tenant and its first user and stops there:
# aircraft, flights, maintenance and squawks are all things the UI can do, and
# clicking through them is the only way to find out whether it does them well.
#
# Re-running is not an error. The account either gets created or already
# exists, and either way this prints what to sign in with.

. "$(dirname "$0")/lib.sh"

# Quote a value as a JSON string. Backslash and double-quote are the only
# characters the values here can plausibly contain that would break the
# document — this is not worth a JSON encoder, but it is worth not building
# the body by bare interpolation either.
json_string() {
  printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

EMAIL="${1:-demo@flightsquare.local}"
SLUG="${2:-demo}"
NAME="${FS_DEMO_NAME:-Demo Flying Club}"
PASSWORD="${FS_DEMO_PASSWORD:-correct horse battery staple}"
API="${FS_API_URL:-http://127.0.0.1:3000}"

# Deliberately not an @vitest.test address. The API suite's cleanup deletes
# every user matching '%@vitest.test' but only tenants matching 'vitest-%', so
# a demo account on that domain leaves an orphaned membership behind and the
# next `npm test` dies on a foreign-key violation with nothing to point at.
case "$EMAIL" in
  *@vitest.test)
    echo "refusing $EMAIL: that domain belongs to the API test suite's cleanup," >&2
    echo "and an account there breaks the next npm test run." >&2
    exit 1 ;;
esac

# The same rules the API enforces (api/src/http/routes/signup.ts), checked
# here so a typo is a sentence rather than a schema validation dump.
if ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{1,62}$'; then
  echo "slug '$SLUG' must be 3-63 characters of a-z, 0-9 and -, starting alphanumeric" >&2
  exit 1
fi
if [ "${#PASSWORD}" -lt 12 ]; then
  echo "password must be at least 12 characters" >&2
  exit 1
fi

if ! curl -fsS "$API/health" >/dev/null 2>&1; then
  echo "no API at $API — start it first:" >&2
  echo "  npm run dev" >&2
  exit 1
fi

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# archetype 'solo' is not cosmetic: it gives this user exactly one membership,
# and the mobile sign-in screen has no tenant picker — it refuses anyone who
# belongs to more than one organisation and tells them to choose on the web.
status="$(
  curl -s -o "$body" -w '%{http_code}' -X POST "$API/auth/signup" \
    -H 'content-type: application/json' \
    --data-binary @- <<JSON
{
  "slug": $(json_string "$SLUG"),
  "name": $(json_string "$NAME"),
  "email": $(json_string "$EMAIL"),
  "password": $(json_string "$PASSWORD"),
  "archetype": "solo"
}
JSON
)"

case "$status" in
  201)
    echo "✓ created $NAME" ;;
  409)
    # Slug or email already taken. The API answers both identically on
    # purpose, and for this script they mean the same thing anyway.
    echo "· $EMAIL already exists" ;;
  429)
    echo "rate limited — signup allows 5 per hour per address." >&2
    echo "Wait, or restart the API to clear the limiter." >&2
    exit 1 ;;
  *)
    echo "signup failed with HTTP $status:" >&2
    cat "$body" >&2
    echo >&2
    exit 1 ;;
esac

cat <<TEXT

  Sign in at   http://127.0.0.1:3001     (npm run dev:web)
  or in the iOS Simulator                (npm run dev:mobile)

  email        $EMAIL
  password     $PASSWORD

Next: add an aircraft. Its standard maintenance intervals come with it, and
the screens have something to show from there on.
TEXT
