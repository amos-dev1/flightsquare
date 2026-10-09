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

CDK_ARGS=()

if [ "$WHICH" = "api" ] || [ "$WHICH" = "both" ]; then
  API_DIGEST="$(build api api/Dockerfile)"
  echo "✓ api  $API_DIGEST"
  CDK_ARGS+=(-c "apiImage=$API_DIGEST")
fi

if [ "$WHICH" = "web" ] || [ "$WHICH" = "both" ]; then
  WEB_DIGEST="$(build web web/Dockerfile)"
  echo "✓ web  $WEB_DIGEST"
  CDK_ARGS+=(-c "webImage=$WEB_DIGEST")
fi

# Whichever image is not being deployed keeps the digest the stack already
# holds, rather than falling back to `latest` and quietly rolling the other
# service back to whatever that points at now.
keep() {
  local key="$1" logical="$2"
  local current
  current="$(aws_ cloudformation describe-stacks \
    --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$logical'].OutputValue" \
    --output text 2>/dev/null || true)"
  if [ -n "$current" ] && [ "$current" != "None" ]; then
    CDK_ARGS+=(-c "$key=$current")
    echo "· keeping $key at $current"
  fi
}
# `if`, not `[ … ] && keep …`: under `set -e` a false test makes the whole
# `&&` return 1 and the script exits — which is the `both` case, every time.
if [ "$WHICH" = "web" ]; then keep apiImage DeployedApiImage; fi
if [ "$WHICH" = "api" ]; then keep webImage DeployedWebImage; fi

echo "→ cdk deploy $STACK"
( cd infra && npx cdk deploy "$STACK" ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} --require-approval never "${CDK_ARGS[@]}" )

echo "✓ deployed. The services reference digests, so the deployment was the pull —"
echo "  no start-deployment to remember."
