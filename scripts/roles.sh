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

# ---------------------------------------------------------------------------
# Where the passwords come from
#
# Locally: `lib.sh` defaults, which mirror docker-compose.yml.
#
# Deployed: AWS Secrets Manager, injected whole as JSON — the stack generates
# app_role's and admin_role's and the migration task is given both. Read with
# node rather than jq, because node is already in the image and jq would be a
# dependency carried for one line.
#
# mail_role and scheduler_role have no secret yet: nothing deployed runs the
# sender or the sweep. They still have to *exist*, because migrations GRANT to
# them, so they get a random password nobody keeps. The day either is deployed
# it gets a secret of its own and is read here like the other two — that is
# what `${MAIL_ROLE_SECRET:-}` is holding the door open for.
# ---------------------------------------------------------------------------
secret_field() {
  node -e '
    const raw = process.env[process.argv[1]];
    if (!raw) { process.stdout.write(""); process.exit(0); }
    let v;
    try { v = JSON.parse(raw); } catch {
      console.error(`${process.argv[1]} is set but is not JSON`); process.exit(1);
    }
    if (typeof v.password !== "string") {
      console.error(`${process.argv[1]} carries no password`); process.exit(1);
    }
    process.stdout.write(v.password);
  ' "$1"
}

unknowable() { fs_random_secret; }

if fs_direct_mode; then
  owner_password="$(unknowable)"   # the managed master logs in; this role is SET ROLE'd into
  app_password="$(secret_field APP_ROLE_SECRET)"
  admin_password="$(secret_field ADMIN_ROLE_SECRET)"
  mail_password="$(secret_field MAIL_ROLE_SECRET)"
  scheduler_password="$(secret_field SCHEDULER_ROLE_SECRET)"

  [ -z "$app_password" ] && { echo "APP_ROLE_SECRET is required" >&2; exit 1; }
  [ -z "$admin_password" ] && { echo "ADMIN_ROLE_SECRET is required" >&2; exit 1; }
  [ -z "$mail_password" ] && mail_password="$(unknowable)"
  [ -z "$scheduler_password" ] && scheduler_password="$(unknowable)"

  master="$(fs_db_field username)"

  # roles.sql makes the caller a member of flightsquare_owner as soon as the
  # role exists — it has to, for its own ALTER DEFAULT PRIVILEGES statements —
  # and that same membership is what lets `psql_as flightsquare_owner` become
  # it. Without it every migration stops on its own first line.
  psql_as "$master" -q \
    -v db="$(fs_db_field dbname)" \
    -v owner_password="$owner_password" \
    -v app_password="$app_password" \
    -v admin_password="$admin_password" \
    -v mail_password="$mail_password" \
    -v scheduler_password="$scheduler_password" \
    -f - < "$ROOT/db/roles.sql"

  echo "✓ roles applied (managed database)."
  exit 0
fi

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
