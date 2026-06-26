#!/usr/bin/env bash
# 发布 OMA Agent Runtime：TCBR + SCF 两个 GHCR 包，各推时间戳 + latest
set -euo pipefail

TAG="${1:-$(date +%y%m%d-%H%M)}"
GHCR="ghcr.io/realalexandreai"
RUNTIME_DIR="$(cd "$(dirname "$0")/../packages/agent-runtime" && pwd)"

echo "=== OMA Agent Runtime · publish $TAG ==="

# ── TCBR（云托管）────────────────────────────────────────
echo ">>> 1. TCBR → oma-agent-runtime"
docker --context colima build --platform linux/amd64 \
  -f "$RUNTIME_DIR/Dockerfile" -t "${GHCR}/oma-agent-runtime:${TAG}" "$RUNTIME_DIR"
docker --context colima push "${GHCR}/oma-agent-runtime:${TAG}"
docker --context colima tag "${GHCR}/oma-agent-runtime:${TAG}" "${GHCR}/oma-agent-runtime:latest"
docker --context colima push "${GHCR}/oma-agent-runtime:latest"
echo "   ✓ ${GHCR}/oma-agent-runtime:${TAG} + latest"

# ── SCF（云函数）─────────────────────────────────────────
echo ""
echo ">>> 2. SCF → oma-agent-runtime-scf"
docker --context colima build --platform linux/amd64 \
  -f "$RUNTIME_DIR/Dockerfile.scf" -t "${GHCR}/oma-agent-runtime-scf:${TAG}" "$RUNTIME_DIR"
docker --context colima push "${GHCR}/oma-agent-runtime-scf:${TAG}"
docker --context colima tag "${GHCR}/oma-agent-runtime-scf:${TAG}" "${GHCR}/oma-agent-runtime-scf:latest"
docker --context colima push "${GHCR}/oma-agent-runtime-scf:latest"
echo "   ✓ ${GHCR}/oma-agent-runtime-scf:${TAG} + latest"

# ── 更新 sync.sh ────────────────────────────────────────
echo ""
echo ">>> 3. 更新 sync.sh"
sed -i '' 's/^BASELINE_TAG=.*/BASELINE_TAG="'"$TAG"'"/' "$(dirname "$0")/sync.sh"
echo "   BASELINE_TAG=$TAG"
echo ""
echo "done."
