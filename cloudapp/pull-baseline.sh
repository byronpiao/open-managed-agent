#!/usr/bin/env bash
# CNB step: 从 GitHub Container Registry 拉取预构建镜像，tag 为用户 TCR 目标
set -euo pipefail

: "${TCR_REGISTRY:?}"
TCR_NAMESPACE="${TCR_NAMESPACE:-open-managed-agent}"
: "${CLOUDBASE_SERVICE_NAME:?}"
: "${CLOUDBASE_VERSION_NAME:?}"
: "${BASELINE_IMAGE:?}"

TARGET="${TCR_REGISTRY}/${TCR_NAMESPACE}/${CLOUDBASE_SERVICE_NAME}:${CLOUDBASE_VERSION_NAME}"

T0=$(date +%s)
echo "[ghcr] docker pull ${BASELINE_IMAGE}"
docker pull "${BASELINE_IMAGE}"
T1=$(date +%s)
echo "[ghcr] pulled  $((T1 - T0))s"

echo "[tag] ${BASELINE_IMAGE} → ${TARGET}"
docker tag "${BASELINE_IMAGE}" "${TARGET}"
echo "[ok] pull + tag done"
