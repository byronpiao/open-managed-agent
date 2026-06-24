#!/usr/bin/env bash
# Build TRW magent preset, push public CCR, sync OMA defaults + AGS tool.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH — brew link docker && colima start" >&2
  exit 1
fi

TRW_ROOT="${TRW_ROOT:-$(cd "$(dirname "$0")/../../../tcb-remote-workspace" && pwd)}"
# shellcheck source=../../../tcb-remote-workspace/scripts/lib/docker-context.sh
source "${TRW_ROOT}/scripts/lib/docker-context.sh"
DOCKER_CTX=$(resolve_build_docker_context "magent")
apply_docker_context "$DOCKER_CTX"
PUBLIC_REPO="${PUBLIC_REPO:-ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d}"
PRESET="${PRESET:-magent}"
TAG="${TAG:-$(date +%y%m%d-%H%M)-$(head -c3 /dev/urandom | xxd -p)-${PRESET}}"
FULL_IMAGE="${PUBLIC_REPO}:${TAG}"

echo "TRW_ROOT=$TRW_ROOT"
echo "IMAGE=$FULL_IMAGE"

OMA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS_ENV_TS="${OMA_ROOT}/packages/agent-runtime/src/harness/harness-env.ts"

cd "$TRW_ROOT"
pnpm build:prod
unset PORT HOST
npm run test:merge
PRESET="$PRESET" ./scripts/build.sh --preset "$PRESET" --platform linux/amd64 --load
docker tag "tcb-sandbox-ags:app-${PRESET}" "$FULL_IMAGE"
docker push "$FULL_IMAGE"

if [[ -f "$HARNESS_ENV_TS" ]]; then
  node -e "
const fs = require('fs');
const p = process.argv[1];
const img = process.argv[2];
const s = fs.readFileSync(p, 'utf8');
const next = 'export const HARNESS_PUBLIC_MAGENT_IMAGE =\\n  \"' + img + '\";';
const out = s.replace(/export const HARNESS_PUBLIC_MAGENT_IMAGE =\\n\\s*\"[^\"]+\";/, next);
if (out === s || !out.includes(img)) {
  console.error('Failed to patch HARNESS_PUBLIC_MAGENT_IMAGE in', p);
  process.exit(1);
}
fs.writeFileSync(p, out);
" "$HARNESS_ENV_TS" "$FULL_IMAGE"
  echo "Updated HARNESS_PUBLIC_MAGENT_IMAGE in harness-env.ts"
fi

cd "$OMA_ROOT"
npm run build:runtime

node scripts/harness/sync-tool.mjs || true

echo ""
echo "Pushed: $FULL_IMAGE"
echo "Next (before cloud harness):"
echo "  sleep 120   # AGS tool image pull"
echo "  npm run test:merge"
echo "  npm run harness -- run --infra tcbr,scf --engine opencode"
