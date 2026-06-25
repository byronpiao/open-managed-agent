#!/usr/bin/env bash
# CNB step: 从公开仓库拉取预构建镜像，tag 为用户 TCR 目标
# 架构见 cloudapp/README.md
#   GHCR: docker pull → tag
#   COS:  curl | docker load → tag
set -euo pipefail

: "${TCR_REGISTRY:?}"
TCR_NAMESPACE="${TCR_NAMESPACE:-open-managed-agent}"
: "${CLOUDBASE_SERVICE_NAME:?}"
: "${CLOUDBASE_VERSION_NAME:?}"
: "${BASELINE_IMAGE:?}"

TARGET="${TCR_REGISTRY}/${TCR_NAMESPACE}/${CLOUDBASE_SERVICE_NAME}:${CLOUDBASE_VERSION_NAME}"
SRC=""

T0=$(date +%s)
if [ -n "${COS_BASELINE_URL:-}" ]; then
  echo "[cos] curl ${COS_BASELINE_URL} | docker load"
  OUT=$(curl -fsSL --retry 3 --retry-delay 5 "${COS_BASELINE_URL}" | docker load 2>&1)
  SRC=$(echo "$OUT" | grep -oP 'Loaded image(?: ID)?: \K\S+' | head -1)
  [ -n "$SRC" ] || { echo "[error] docker load 未输出镜像名" >&2; exit 1; }
  T1=$(date +%s)
  echo "[cos] loaded ${SRC}  $((T1 - T0))s"
else
  SRC="${BASELINE_IMAGE}"
  echo "[ghcr] docker pull ${SRC}"
  docker pull "${SRC}"
  T1=$(date +%s)
  echo "[ghcr] pulled  $((T1 - T0))s"
fi

echo "[tag] ${SRC} → ${TARGET}"
docker tag "${SRC}" "${TARGET}"
echo "[ok] pull + tag done"
