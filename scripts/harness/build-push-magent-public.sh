#!/usr/bin/env bash
# Build TRW magent preset, push public CCR, sync OMA defaults + AGS tool.
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found in PATH — brew link docker && colima start" >&2
  exit 1
fi
if [[ -z "${DOCKER_HOST:-}" && -S "${HOME}/.colima/default/docker.sock" ]]; then
  export DOCKER_HOST="unix://${HOME}/.colima/default/docker.sock"
fi

TRW_ROOT="${TRW_ROOT:-$(cd "$(dirname "$0")/../../../tcb-remote-workspace" && pwd)}"
PUBLIC_REPO="${PUBLIC_REPO:-ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d}"
PRESET="${PRESET:-magent}"
TAG="${TAG:-$(date +%y%m%d-%H%M)-$(head -c3 /dev/urandom | xxd -p)-${PRESET}}"
FULL_IMAGE="${PUBLIC_REPO}:${TAG}"

echo "TRW_ROOT=$TRW_ROOT"
echo "IMAGE=$FULL_IMAGE"

OMA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HARNESS_ENV_TS="${OMA_ROOT}/packages/agent-runtime/src/harness/harness-env.ts"

cd "$TRW_ROOT"
OAK_VENDOR="${OMA_ROOT}/packages/agent-runtime/vendor/cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz"
TRW_VENDOR="${TRW_ROOT}/vendor/cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz"
if [[ ! -f "$TRW_VENDOR" && -f "$OAK_VENDOR" ]]; then
  mkdir -p "${TRW_ROOT}/vendor"
  cp -f "$OAK_VENDOR" "$TRW_VENDOR"
  echo "Synced OAK vendor tgz → TRW vendor/"
fi
if [[ ! -f "$TRW_VENDOR" ]]; then
  echo "Missing $TRW_VENDOR (copy from open-managed-agent/packages/agent-runtime/vendor/)" >&2
  exit 1
fi
pnpm build:prod
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
EOF
  echo "Wrote $HARNESS_ENV"
fi

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
echo "  npm run test:full"
echo "  npm run harness -- cloud-tcbr"
echo "  npm run harness -- cloud-scf"
