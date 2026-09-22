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

# psql_as <role> [psql args...]   — SQL is fed on stdin.
psql_as() {
  local role="$1"; shift
  dc exec -T -e PGPASSWORD="$(password_for "$role")" db \
    psql -v ON_ERROR_STOP=1 -U "$role" -d "$FS_DB_NAME" "$@"
}

require_db() {
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
