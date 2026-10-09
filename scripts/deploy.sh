#!/usr/bin/env bash
# Build, push, and deploy exactly what was built.
#
#   scripts/deploy.sh dev              # both images
#   scripts/deploy.sh dev api          # just the API (and the tasks that share it)
#   scripts/deploy.sh dev web
#   scripts/deploy.sh prod
#
# The point of this script is the digest. `cdk deploy` on its own used to be a
# no-op for a new image: the services referenced `:latest`, a moved tag renders
# the same template, App Runner saw no configuration change, and the previous
# image kept serving — a deploy that reported success and changed nothing, with
# `aws apprunner start-deployment` as the step you had to remember afterwards.
#
# Here the digest comes from the push itself (`--metadata-file`), not from a
# later lookup of what `:latest` points at. Those differ precisely when it
# matters: two pushes racing, or a rebuild between push and read.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_NAME="${1:-dev}"
WHICH="${2:-both}"

case "$ENV_NAME" in
  dev|prod) ;;
  *) echo "usage: scripts/deploy.sh <dev|prod> [api|web|both]" >&2; exit 1 ;;
esac
case "$WHICH" in
  api|web|both) ;;
  *) echo "usage: scripts/deploy.sh <dev|prod> [api|web|both]" >&2; exit 1 ;;
esac

STACK="FlightSquare$(printf '%s' "${ENV_NAME:0:1}" | tr '[:lower:]' '[:upper:]')${ENV_NAME:1}"
REGION="${AWS_REGION:-us-east-1}"

# A named profile on a laptop; nothing in CI, where the credentials arrive from
# GitHub's OIDC token and no profile exists. Detected rather than configured so
# the same script runs in both places — which is the point of CI calling this
# instead of repeating the steps in YAML.
#
# `${ARR[@]+"${ARR[@]}"}` and not `"${ARR[@]}"`: under `set -u` an empty array
# is an unbound variable in bash 3.2, which is what macOS ships.
AWS_ARGS=()
PROFILE="flightsquare-$ENV_NAME"
if aws configure list-profiles 2>/dev/null | grep -qx "$PROFILE"; then
  AWS_ARGS=(--profile "$PROFILE")
  echo "· using profile $PROFILE"
else
  echo "· using ambient credentials ($(aws sts get-caller-identity --query Arn --output text 2>/dev/null || echo unknown))"
fi
aws_() { aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} "$@"; }

ACCOUNT="$(aws_ sts get-caller-identity --query Account --output text)"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

echo "→ $STACK in $ACCOUNT ($REGION)"

aws_ ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
echo "✓ logged in to ECR"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Both architectures: the migration and mail tasks are pinned to ARM64 in the
# stack and App Runner exposes no architecture setting. Nothing here compiles,
# so the second architecture is nearly free.
build() {
  local name="$1" dockerfile="$2"
  local repo="$REGISTRY/fs-$ENV_NAME-$name"
  # stderr, not stdout: this function's stdout IS the digest, and anything else
  # written there is captured by `$(build …)` and sent to App Runner as part of
  # the image identifier.
  echo "→ building $name" >&2
  docker buildx build \
    -f "$dockerfile" \
    --platform linux/amd64,linux/arm64 \
    --provenance=false \
    -t "$repo:latest" \
    --metadata-file "$work/$name.json" \
    --push . >&2
  # What the registry accepted, straight from the push. Not a lookup of what
  # `:latest` resolves to afterwards, which is a different question.
  local digest
  digest="$(node -e '
    const m = require(process.argv[1]);
    const d = m["containerimage.digest"];
    if (!d) { console.error("no digest in buildx metadata"); process.exit(1); }
    process.stdout.write(d);
  ' "$work/$name.json")"

  # A guard, because the failure it catches is quiet: anything non-digest
  # reaching App Runner is rejected by a 400 naming a regular expression, and
  # the reason it was wrong is three steps back.
  case "$digest" in
    sha256:*) ;;
    *) echo "expected a sha256 digest for $name, got: $digest" >&2; exit 1 ;;
  esac
  printf '%s' "$digest"
}

# What the stack currently runs. Used to hold the services still during the
# first pass, and to leave an image alone when only the other is being built.
deployed() {
  local out
  out="$(aws_ cloudformation describe-stacks \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text 2>/dev/null || true)"
  [ "$out" = "None" ] && out=""
  printf '%s' "$out"
}

CURRENT_API="$(deployed DeployedApiImage)"
CURRENT_WEB="$(deployed DeployedWebImage)"

API_DIGEST=""
WEB_DIGEST=""
if [ "$WHICH" = "api" ] || [ "$WHICH" = "both" ]; then
  API_DIGEST="$(build api api/Dockerfile)"
  echo "✓ api  $API_DIGEST"
fi
if [ "$WHICH" = "web" ] || [ "$WHICH" = "both" ]; then
  WEB_DIGEST="$(build web web/Dockerfile)"
  echo "✓ web  $WEB_DIGEST"
fi

# An image that was not rebuilt keeps the digest the stack already holds,
# rather than falling back to `latest` and quietly rolling that service onto
# whatever the tag points at now.
[ -z "$API_DIGEST" ] && API_DIGEST="${CURRENT_API:-latest}"
[ -z "$WEB_DIGEST" ] && WEB_DIGEST="${CURRENT_WEB:-latest}"

cdk_deploy() {
  ( cd infra && npx cdk deploy "$STACK" ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} \
      --require-approval never "$@" )
}

###############################################################################
# Pass 1 — move the schema, leave the code alone.
#
# The migration task picks up the new image; the API, the mail worker and the
# web app stay on exactly what they are already running. That ordering is the
# whole point: migrations are additive and forward-only (CLAUDE.md §6), so old
# code against the new schema is fine — it ignores a column it does not know
# about — while new code against the old schema fails on the first query
# naming something that is not there yet.
#
# On a first deploy there is nothing running yet, so there is no "hold still"
# to do and one pass is the whole deploy.
###############################################################################
if [ -n "$CURRENT_API" ] || [ -n "$CURRENT_WEB" ]; then
  echo "→ pass 1: migration task to the new image, services held at the current one"
  echo "   api held at ${CURRENT_API:-latest}"
  echo "   web held at ${CURRENT_WEB:-latest}"
  cdk_deploy \
    -c "migrateImage=$API_DIGEST" \
    -c "apiImage=${CURRENT_API:-latest}" \
    -c "webImage=${CURRENT_WEB:-latest}"

  echo "→ migrating, before any new code serves"
  "$(dirname "$0")/migrate-remote.sh" "$ENV_NAME"
else
  echo "· first deploy: nothing is running yet, so there is nothing to hold back"
fi

###############################################################################
# Pass 2 — now the code.
#
# If the migrations above failed, `set -e` stopped before this, and the
# services are still serving the old image against a schema it understands.
# That is the failure mode worth having.
###############################################################################
echo "→ pass 2: services to the new image"
cdk_deploy \
  -c "migrateImage=$API_DIGEST" \
  -c "apiImage=$API_DIGEST" \
  -c "webImage=$WEB_DIGEST"

# A first deploy had nothing to hold back, so its migrations run here instead —
# after the stack exists, which is the earliest the task definition does.
if [ -z "$CURRENT_API" ] && [ -z "$CURRENT_WEB" ]; then
  echo "→ migrating (first deploy)"
  "$(dirname "$0")/migrate-remote.sh" "$ENV_NAME"
fi

echo "✓ deployed. Migrations ran before the new code served, and the services"
echo "  reference digests, so each deployment was the pull."
