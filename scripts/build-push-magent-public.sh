#!/usr/bin/env bash
# Build TRW magent preset and push to public CCR (see harness/README.md §4).
# Requires: docker, colima|docker desktop, tcb login, pnpm in tcb-remote-workspace.
set -euo pipefail

export PATH="/opt/homebrew/Cellar/docker/29.5.3/bin:/opt/homebrew/bin:${PATH:-}"
export DOCKER_HOST="${DOCKER_HOST:-unix://${HOME}/.colima/default/docker.sock}"

TRW_ROOT="${TRW_ROOT:-$(cd "$(dirname "$0")/../../../tcb-remote-workspace" && pwd)}"
PUBLIC_REPO="${PUBLIC_REPO:-ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d}"
PRESET="${PRESET:-magent}"
TAG="${TAG:-$(date +%y%m%d-%H%M)-$(head -c3 /dev/urandom | xxd -p)-${PRESET}}"
FULL_IMAGE="${PUBLIC_REPO}:${TAG}"

echo "TRW_ROOT=$TRW_ROOT"
echo "IMAGE=$FULL_IMAGE"

OMA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$TRW_ROOT"
pnpm build:prod
# OMA .env may set PORT=3001; TRW unit tests expect default 9000.
unset PORT HOST
pnpm test:unit
PRESET="$PRESET" ./scripts/build.sh --preset "$PRESET" --platform linux/amd64 --load
docker tag "tcb-sandbox-ags:app-${PRESET}" "$FULL_IMAGE"
docker push "$FULL_IMAGE"

HARNESS_ENV="$OMA_ROOT/.env.harness"
if [[ -f "$HARNESS_ENV" ]]; then
  if grep -q '^HARNESS_SANDBOX_IMAGE=' "$HARNESS_ENV"; then
    sed -i '' "s|^HARNESS_SANDBOX_IMAGE=.*|HARNESS_SANDBOX_IMAGE=$FULL_IMAGE|" "$HARNESS_ENV"
  else
    printf '\nHARNESS_SANDBOX_IMAGE=%s\n' "$FULL_IMAGE" >> "$HARNESS_ENV"
  fi
  echo "Updated HARNESS_SANDBOX_IMAGE in $HARNESS_ENV"
else
  cat > "$HARNESS_ENV" <<EOF
# Generated $(date +%Y-%m-%d) — magent preset public CCR (gitignored)
HARNESS_SANDBOX_IMAGE=$FULL_IMAGE
# HARNESS_TOOL_ID unset — orchestrator auto-ensures harness-{CLOUDBASE_ENV_ID}
EOF
  echo "Wrote $HARNESS_ENV (gitignored; loaded by scripts/load-env.mjs)"
fi
echo "See packages/agent-runtime/src/harness/README.md for harness e2e"
if [[ -n "${HARNESS_TOOL_ID:-}" ]]; then
  node "$OMA_ROOT/scripts/sync-harness-tool.mjs"
else
  echo "(no HARNESS_TOOL_ID — skip sync-harness-tool; image applied on next ensureHarnessTool)"
fi
echo "Pushed: $FULL_IMAGE"
