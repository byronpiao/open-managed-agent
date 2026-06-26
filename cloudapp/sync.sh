#!/usr/bin/env bash
# OMA Agent Runtime — 同步到您的 TCR
# 用法：cd cloudapp && cp .env.example .env && ./sync.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TCB_API_VERSION="2018-06-08"
BOOTSTRAP_CMD='docker build -f Dockerfile.bootstrap -t cloudapp-bootstrap:tmp .'
CONFIG="${CLOUDAPP_SYNC_ENV:-${SCRIPT_DIR}/.env}"

# ═══════════════════════════════════════════════════════════
# 平台维护
# ═══════════════════════════════════════════════════════════

TCB_ENV_ID="lowcode-8gtybv2a87db84a3"
TCR_REGISTRY="ccr.ccs.tencentyun.com"
BASELINE_TAG="260625-1807"
BASELINE_GHCR="ghcr.io/realalexandreai/oma-agent-runtime:<BASELINE_TAG>"
BASELINE_GHCR_SCF="ghcr.io/realalexandreai/oma-agent-runtime-scf:<BASELINE_TAG>"
BASELINE_SOURCE="${BASELINE_SOURCE:-ghcr}"

die() { echo "ERROR: $*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
need_cmd tcb jq zip curl python3

[ -f "$CONFIG" ] && source "$CONFIG"

BASELINE_IMAGE="${BASELINE_GHCR//<BASELINE_TAG>/$BASELINE_TAG}"
COS_URL=""

TCR_MODE="${TCR_MODE:-personal}"
TCR_NAMESPACE="${TCR_NAMESPACE:-open-managed-agent}"
TCR_UIN="${TCR_UIN:-}"
TCR_PASSWORD="${TCR_PASSWORD:-}"
TCR_IMAGE_NAME="${TCR_IMAGE_NAME:-oma-agent-runtime}"

POLL="${CLOUDAPP_POLL_INTERVAL_SEC:-5}"
TMO="${CLOUDAPP_POLL_TIMEOUT_SEC:-1800}"

echo "=== CloudApp：OMA Agent Runtime ($([ "$TCR_MODE" = "personal" ] && echo '个人版 CCR' || echo '企业版 TCR')) ==="
echo "  目标: ${TCR_REGISTRY}/${TCR_NAMESPACE:-open-managed-agent}/${TCR_IMAGE_NAME}"
echo "  源:   GitHub Packages  (${BASELINE_IMAGE})"

tcb_api() {
  local a="$1" b="$2"
  tcb api tcb "$a" --api-version "$TCB_API_VERSION" --body "$b" --json 2>&1 \
    | python3 -c "import json,sys;raw=sys.stdin.read();i=raw.find('{');d=json.loads(raw[i:]) if i>=0 else {};print(json.dumps(d.get('data',d)))"
}

build_body() {
  local ts="$1"
  local scf_image="${BASELINE_GHCR_SCF//<BASELINE_TAG>/$BASELINE_TAG}"
  jq -nc --arg e "$TCB_ENV_ID" --arg s "$TCR_IMAGE_NAME" --arg t "$ts" \
    --arg b "$BASELINE_IMAGE" --arg scf "$scf_image" \
    --arg r "$TCR_REGISTRY" --arg n "$TCR_NAMESPACE" \
    --arg u "$TCR_UIN" --arg p "$TCR_PASSWORD" --arg x "$BOOTSTRAP_CMD" \
    '{
      EnvId:$e,ServiceName:$s,DeployType:"custom",BuildType:"zip",
      Source:{Type:"zip",CosTimestamp:$t,CosSuffix:".zip"},
      Env:[{Key:"BASELINE_IMAGE",Value:$b},{Key:"SCF_BASELINE_IMAGE",Value:$scf},{Key:"TCR_REGISTRY",Value:$r},{Key:"TCR_NAMESPACE",Value:$n},{Key:"CCR_USERNAME",Value:$u}],
      Secrets:([{Name:"CCR_PASSWORD",Value:$p}]|map(select(.Value!=""))),
      CustomSteps:[
        {Name:"bootstrap-docker",Command:$x},
        {Name:"pull-tcbr",Command:"bash ./pull-baseline.sh"},
        {Name:"push-tcbr",Command:"bash ./tcr-sts-login.sh"},
        {Name:"pull-scf",Command:"BASELINE_IMAGE=$SCF_BASELINE_IMAGE CLOUDBASE_VERSION_NAME=scf-${CLOUDBASE_VERSION_NAME} bash ./pull-baseline.sh"},
        {Name:"push-scf",Command:"BASELINE_IMAGE=$SCF_BASELINE_IMAGE CLOUDBASE_VERSION_NAME=scf-${CLOUDBASE_VERSION_NAME} bash ./tcr-sts-login.sh"}
      ]
    }'
}

# ── ① ─────────────────────────────────────────────────
J=$(tcb_api DescribeCloudAppCosInfo "$(jq -nc --arg e "$TCB_ENV_ID" --arg s "$TCR_IMAGE_NAME" '{EnvId:$e,ServiceName:$s,DeployType:"custom",NeedDownload:false}')")
U=$(echo "$J" | jq -r '.UploadUrl')
TS=$(echo "$J" | jq -r '.UnixTimestamp')

# ── ② ─────────────────────────────────────────────────
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; Z="${W}/bundle.zip"
(cd "$SCRIPT_DIR" && chmod +x *.sh && zip -qr "$Z" . -i '*.sh' -i 'Dockerfile.bootstrap' -x 'sync.sh' '.env*')
A=(-sS -X PUT "$U" -H "Content-Type: application/zip" --data-binary "@${Z}")
while IFS= read -r L; do
  k=$(echo "$L" | jq -r '.Key // empty'); v=$(echo "$L" | jq -r '.Value // empty')
  [ -n "$k" ] && [ -n "$v" ] && A+=(-H "${k}: ${v}")
done < <(echo "$J" | jq -c '.UploadHeaders[]?')
[ "$(curl "${A[@]}" -o /dev/null -w '%{http_code}')" = "200" ] || die "上传失败"

# ── ③ ─────────────────────────────────────────────────
R=$(tcb_api CreateCloudApp "$(build_body "$TS")")
VER=$(echo "$R" | jq -r '.VersionName')
echo ">>> 构建已触发  VersionName=${VER}"

# ── ④ ─────────────────────────────────────────────────
D=$(( $(date +%s) + TMO ))
while true; do
  Q=$(jq -nc --arg e "$TCB_ENV_ID" --arg s "$TCR_IMAGE_NAME" --arg v "$VER" '{EnvId:$e,ServiceName:$s,VersionName:$v,DeployType:"custom"}')
  DATA=$(tcb_api DescribeCloudAppVersion "$Q")
  S=$(echo "$DATA" | jq -r '.Status // .VersionStatus // "UNKNOWN"')
  echo "    status=${S}"
  [ "$S" = "SUCCESS" ] || [ "$S" = "Success" ] || [ "$S" = "success" ] && break
  [ "$S" = "FAILED" ] || [ "$S" = "Failed" ] || [ "$S" = "failed" ] && {
    echo "  构建失败 — 步骤详情:"
    echo "$DATA" | jq -r '.Steps[]? | "    \(.Name): \(.Status)  \(.Duration // "")"'
    die "构建失败"
  }
  [ $(date +%s) -ge $D ] && die "超时"
  sleep "$POLL"
done

echo "$DATA" | jq -r '.Steps[]? | "  \(.Name)  \(.Status)  \(.Duration // "")"'
echo ""
echo "✓ 同步完成"
echo "  云托管:  ${TCR_REGISTRY}/${TCR_NAMESPACE}/${TCR_IMAGE_NAME}:${VER}"
echo "  云函数:  ${TCR_REGISTRY}/${TCR_NAMESPACE}/${TCR_IMAGE_NAME}:scf-${VER}"
