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
pnpm test:unit
PRESET="$PRESET" ./scripts/build.sh --preset "$PRESET" --platform linux/amd64 --load
docker tag "tcb-sandbox-ags:app-${PRESET}" "$FULL_IMAGE"
docker push "$FULL_IMAGE"

cat > "$OMA_ROOT/.env.harness" <<EOF
# Generated $(date +%Y-%m-%d) — magent preset public CCR (gitignored)
HARNESS_SANDBOX_IMAGE=$FULL_IMAGE
# HARNESS_TOOL_ID unset — orchestrator auto-ensures harness-{CLOUDBASE_ENV_ID}
EOF
echo "Wrote $OMA_ROOT/.env.harness (gitignored; loaded by scripts/load-env.mjs)"
echo "See packages/agent-runtime/src/harness/README.md for harness e2e"
if [[ -n "${HARNESS_TOOL_ID:-}" ]]; then
  node "$OMA_ROOT/scripts/sync-harness-tool.mjs"
else
  echo "(no HARNESS_TOOL_ID — skip sync-harness-tool; image applied on next ensureHarnessTool)"
fi
echo "Pushed: $FULL_IMAGE"
