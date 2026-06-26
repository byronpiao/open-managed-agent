#!/usr/bin/env bash
# 发布 OMA Agent Runtime：TCBR + SCF 两个 GHCR 包，各推时间戳 + latest
set -euo pipefail

TAG="${1:-$(date +%y%m%d-%H%M)}"
GHCR="ghcr.io/realalexandreai"
RUNTIME_DIR="$(cd "$(dirname "$0")/../packages/agent-runtime" && pwd)"

echo "=== OMA Agent Runtime · publish $TAG ==="

# ── TCBR（云托管）────────────────────────────────────────
echo ">>> 1. TCBR → open-managed-agent"
docker --context colima build --platform linux/amd64 \
  -f "$RUNTIME_DIR/Dockerfile" -t "${GHCR}/open-managed-agent:${TAG}" "$RUNTIME_DIR"
docker --context colima push "${GHCR}/open-managed-agent:${TAG}"
docker --context colima tag "${GHCR}/open-managed-agent:${TAG}" "${GHCR}/open-managed-agent:latest"
docker --context colima push "${GHCR}/open-managed-agent:latest"
echo "   ✓ ${GHCR}/open-managed-agent:${TAG} + latest"

# ── SCF（云函数）─────────────────────────────────────────
echo ""
echo ">>> 2. SCF → open-managed-agent-scf"
docker --context colima build --platform linux/amd64 \
  -f "$RUNTIME_DIR/Dockerfile.scf" -t "${GHCR}/open-managed-agent-scf:${TAG}" "$RUNTIME_DIR"
docker --context colima push "${GHCR}/open-managed-agent-scf:${TAG}"
docker --context colima tag "${GHCR}/open-managed-agent-scf:${TAG}" "${GHCR}/open-managed-agent-scf:latest"
docker --context colima push "${GHCR}/open-managed-agent-scf:latest"
echo "   ✓ ${GHCR}/open-managed-agent-scf:${TAG} + latest"

# ── 更新 sync.sh ────────────────────────────────────────
echo ""
echo ">>> 3. 更新 sync.sh"
sed -i '' 's/^BASELINE_TAG=.*/BASELINE_TAG="'"$TAG"'"/' "$(dirname "$0")/sync.sh"
echo "   BASELINE_TAG=$TAG"
echo ""
echo "done."
