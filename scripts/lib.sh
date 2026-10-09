# Shared helpers. Sourced, not executed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

# Defaults mirror docker-compose.yml, so .env is optional for local dev.
: "${POSTGRES_PASSWORD:=postgres}"
: "${FS_OWNER_PASSWORD:=owner_dev_password}"
: "${FS_APP_PASSWORD:=app_dev_password}"
: "${FS_ADMIN_PASSWORD:=admin_dev_password}"
: "${FS_MAIL_PASSWORD:=mail_dev_password}"
: "${FS_SCHEDULER_PASSWORD:=scheduler_dev_password}"
: "${FS_DB_NAME:=flightsquare}"

OWNER_ROLE=flightsquare_owner

dc() { docker compose --project-directory "$ROOT" "$@"; }

password_for() {
  case "$1" in
    postgres)            printf '%s' "$POSTGRES_PASSWORD" ;;
    flightsquare_owner)  printf '%s' "$FS_OWNER_PASSWORD" ;;
    app_role)            printf '%s' "$FS_APP_PASSWORD" ;;
    admin_role)          printf '%s' "$FS_ADMIN_PASSWORD" ;;
    mail_role)           printf '%s' "$FS_MAIL_PASSWORD" ;;
    scheduler_role)      printf '%s' "$FS_SCHEDULER_PASSWORD" ;;
    *) echo "unknown role: $1" >&2; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Two things that are not in every image
#
# These scripts run on a developer's macOS laptop and inside an alpine
# container, and the two disagree about which coreutils they ship. Neither
# difference is interesting enough to deserve a package in the image, and both
# cost a deploy to discover: a missing command exits 127 from inside a Fargate
# task, which is a CloudWatch round trip away from telling you why.
# ---------------------------------------------------------------------------

# sha256 of a file, as bare hex.
#
# `sha256sum` on Linux and alpine, `shasum -a 256` on macOS, which has the
# second and not the first. Same algorithm and same output either way, which
# matters: `schema_migrations.checksum` holds values computed by whichever one
# ran first, and §6 treats a changed checksum as an error rather than a no-op.
fs_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# A password nobody keeps.
#
# node rather than `openssl rand`: the alpine node image links OpenSSL into
# node and ships no CLI binary for it, and node is already a hard requirement
# of every script here.
fs_random_secret() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))'
}

# Direct mode: a managed database reached over the network, not a container
# on this machine.
#
# `DATABASE_URL` is how the deployed migration task is given the owner's
# credentials, and Secrets Manager hands them over as the whole secret in JSON
# — `{"username":…,"password":…,"host":…,"port":…,"dbname":…}` — not as a
# libpq URL. The name is the stack's; the shape is AWS's.
#
# One login, several roles. The managed master is the only account with a
# password here, so `psql_as <role>` connects as the master and asks the server
# to become that role for the session. `current_user` then reports the role,
# which is what every migration's opening guard checks, and objects are created
# owned by it.
fs_direct_mode() { [ -n "${DATABASE_URL:-}" ]; }

# Read one field of DATABASE_URL, which arrives in two shapes.
#
# A Secrets Manager secret is JSON — that is how the deployed tasks receive it,
# injected whole by ECS. A laptop or a CI service container hands over the
# ordinary libpq URI instead. Both are accepted because insisting on JSON broke
# the one that was already in use: .github/workflows/ci.yml passes
# `postgres://postgres:postgres@localhost:5432/...`, and parsing that as JSON
# fails on the first character.
fs_db_field() {
  node -e '
    const raw = process.env.DATABASE_URL ?? "";
    const k = process.argv[1];
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      let u;
      try { u = new URL(raw); } catch {
        console.error("DATABASE_URL is neither JSON nor a postgres:// URL");
        process.exit(1);
      }
      v = {
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        host: u.hostname,
        port: u.port || "5432",
        // Leading slash off; an empty path means the default database.
        dbname: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
      };
    }
    const out = v[k] ?? v[{dbname:"database"}[k] ?? k];
    if (out === undefined) { console.error(`DATABASE_URL has no ${k}`); process.exit(1); }
    process.stdout.write(String(out));
  ' "$1"
}

# psql_as <role> [psql args...]   — SQL is fed on stdin.
psql_as() {
  local role="$1"; shift

  if fs_direct_mode; then
    local master host port dbname
    master="$(fs_db_field username)"
    host="$(fs_db_field host)"
    port="$(fs_db_field port)"
    dbname="$(fs_db_field dbname)"

    # Become the role unless it is already the login. `-c role=` is a server
    # setting, so it survives every statement in the session without the
    # migrations needing to know they are not connected directly.
    local opts=""
    [ "$role" != "$master" ] && opts="-c role=$role"

    PGPASSWORD="$(fs_db_field password)" PGOPTIONS="$opts" \
      psql -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$master" -d "$dbname" "$@"
    return
  fi

  dc exec -T -e PGPASSWORD="$(password_for "$role")" db \
    psql -v ON_ERROR_STOP=1 -U "$role" -d "$FS_DB_NAME" "$@"
}

require_db() {
  # Nothing to start, and no docker to ask. The connection either works or the
  # first psql fails with a real error.
  if fs_direct_mode; then
    return 0
  fi

  if ! dc ps --status running --services 2>/dev/null | grep -qx db; then
    echo "database is not running — start it with: docker compose up -d" >&2
    exit 1
  fi
  local i=0
  until dc exec -T db pg_isready -U postgres -d "$FS_DB_NAME" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "database did not become ready" >&2
      exit 1
    fi
    sleep 1
  done
}

# Object storage, for §3.8's attachments. Warns rather than exits: a photograph
# of a defect failing to upload should not stop the API, the web app and the
# mail sender from starting.
require_storage() {
  if ! dc ps --status running --services 2>/dev/null | grep -qx storage; then
    echo "object storage is not running — start it with: docker compose up -d" >&2
    echo "(attachments will fail; everything else works)" >&2
    return 0
  fi
  local i=0
  until curl -fsS -o /dev/null "http://127.0.0.1:9000/minio/health/live" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 30 ]; then
      echo "object storage did not become ready — attachments will fail" >&2
      return 0
    fi
    sleep 1
  done
}
