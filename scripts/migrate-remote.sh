#!/usr/bin/env bash
# Run the migration task against a deployed environment, and fail if it fails.
#
#   scripts/migrate-remote.sh dev
#
# The exit code is the point. `aws ecs run-task` returns as soon as the task is
# *accepted*, which is success in the sense that something was scheduled and
# says nothing about whether the migrations applied — so a deploy that stops
# there reports green while the schema is whatever it was. This waits for the
# task to stop, reads the container's exit code, and carries it out.
#
# Everything it needs comes from stack outputs: the task definition (which
# already points at the digest just deployed), the subnets and the security
# group. Nothing is hardcoded, so this follows the stack rather than drifting
# from it.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_NAME="${1:-dev}"
case "$ENV_NAME" in
  dev|prod) ;;
  *) echo "usage: scripts/migrate-remote.sh <dev|prod>" >&2; exit 1 ;;
esac

STACK="FlightSquare$(printf '%s' "${ENV_NAME:0:1}" | tr '[:lower:]' '[:upper:]')${ENV_NAME:1}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER="fs-$ENV_NAME-tasks"

# A named profile locally; whatever the environment already has in CI, where
# the credentials come from OIDC and no profile exists.
AWS_ARGS=()
PROFILE="flightsquare-$ENV_NAME"
if aws configure list-profiles 2>/dev/null | grep -qx "$PROFILE"; then
  AWS_ARGS=(--profile "$PROFILE")
fi
aws_() { aws ${AWS_ARGS[@]+"${AWS_ARGS[@]}"} --region "$REGION" "$@"; }

output() {
  aws_ cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

TASK_DEF="$(output MigrateTaskArn)"
SUBNETS="$(output MigrateSubnets)"
SG="$(output MigrateSecurityGroup)"
[ -n "$TASK_DEF" ] && [ "$TASK_DEF" != "None" ] || { echo "no MigrateTaskArn on $STACK" >&2; exit 1; }

echo "→ migrating $ENV_NAME"
echo "  task definition: ${TASK_DEF##*/}"

# A public subnet with a public address, matching how the stack describes this
# task: there is no NAT, so pulling the image needs a route out, and the
# security group opens nothing inbound.
TASK_ARN="$(aws_ ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SG}],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)"
[ -n "$TASK_ARN" ] && [ "$TASK_ARN" != "None" ] || { echo "run-task returned no task" >&2; exit 1; }
echo "  task: ${TASK_ARN##*/}"

echo "→ waiting"
until [ "$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
           --query 'tasks[0].lastStatus' --output text)" = "STOPPED" ]; do
  sleep 10
done

EXIT_CODE="$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
REASON="$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].stoppedReason' --output text)"

# The log stream name is deterministic: <prefix>/<container>/<task id>.
LOG_GROUP="$(aws_ ecs describe-task-definition --task-definition "$TASK_DEF" \
  --query 'taskDefinition.containerDefinitions[0].logConfiguration.options."awslogs-group"' --output text)"
echo "── migration output ─────────────────────────────────────────"
aws_ logs get-log-events \
  --log-group-name "$LOG_GROUP" \
  --log-stream-name "migrate/migrate/${TASK_ARN##*/}" \
  --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || echo "(no log events)"
echo "─────────────────────────────────────────────────────────────"

if [ "$EXIT_CODE" != "0" ]; then
  echo "✗ migrations failed — container exit $EXIT_CODE ($REASON)" >&2
  exit 1
fi
echo "✓ migrations applied"
