#!/usr/bin/env bash
# 发布 OMA Agent Runtime：构建 TCBR + SCF，推 GHCR
set -euo pipefail

TAG="${1:-$(date +%y%m%d-%H%M)}"
GHCR="ghcr.io/realalexandreai/oma-agent-runtime"
RUNTIME_DIR="$(cd "$(dirname "$0")/../packages/agent-runtime" && pwd)"

echo "=== OMA Agent Runtime · publish $TAG ==="

# ── TCBR（云托管）────────────────────────────────────────
echo ">>> 1. TCBR (CloudRun)"
docker --context colima build --platform linux/amd64 \
  -f "$RUNTIME_DIR/Dockerfile" -t "${GHCR}:${TAG}" "$RUNTIME_DIR"
docker --context colima push "${GHCR}:${TAG}"
echo "   ✓ ${GHCR}:${TAG}"

# ── SCF（云函数）─────────────────────────────────────────
echo ""
echo ">>> 2. SCF (Serverless)"
SCF_TAG="scf-${TAG}"
docker --context colima build --platform linux/amd64 \
  -f "$RUNTIME_DIR/Dockerfile.scf" -t "${GHCR}:${SCF_TAG}" "$RUNTIME_DIR"
docker --context colima push "${GHCR}:${SCF_TAG}"
echo "   ✓ ${GHCR}:${SCF_TAG}"

# ── 更新 sync.sh ────────────────────────────────────────
echo ""
echo ">>> 3. 更新 sync.sh"
sed -i '' 's/^BASELINE_TAG=.*/BASELINE_TAG="'"$TAG"'"/' "$(dirname "$0")/sync.sh"
echo "   BASELINE_TAG=$TAG"
echo "   SCF 版本: scf-$TAG"
echo ""
echo "done."
