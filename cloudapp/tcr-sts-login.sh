#!/usr/bin/env bash
# CNB step: 登录 TCR + docker push
# 架构见 cloudapp/README.md
#   个人版：自动尝试开通 CCR 账号（首次用户无需进控制台）
#         已注册用户走 .env 提供的账密
#   企业版：$TCR_INSTANCE_ID + STS CreateInstanceToken（未实测）
set -euo pipefail

: "${TCR_REGISTRY:?}"
TCR_NAMESPACE="${TCR_NAMESPACE:-tcb-sandbox}"
: "${CLOUDBASE_SERVICE_NAME:?}"
: "${CLOUDBASE_VERSION_NAME:?}"

IMAGE="${TCR_REGISTRY}/${TCR_NAMESPACE}/${CLOUDBASE_SERVICE_NAME}:${CLOUDBASE_VERSION_NAME}"

if [ -n "${TCR_INSTANCE_ID:-}" ]; then
  # ── 企业版 STS → CreateInstanceToken ──────────────────
  : "${API_SECRET_ID:?}" "${API_SECRET_KEY:?}" "${API_TOKEN:?}"
  HOST="tcr.tencentcloudapi.com"
  TS=$(date +%s)
  DATE=$(date -u -d "@${TS}" +"%Y-%m-%d" 2>/dev/null || date -u -r "${TS}" +"%Y-%m-%d")
  PAYLOAD='{"RegistryId":"'"${TCR_INSTANCE_ID}"'","TokenType":"LongTermToken"}'
  HP=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hex | awk '{print $NF}')
  CH="content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:createinstancetoken\n"
  SH="content-type;host;x-tc-action"
  CS="POST\n/\n\n${CH}\n${SH}\n${HP}"
  CR="${DATE}/tcr/tc3_request"
  HCS=$(printf "${CS}" | openssl dgst -sha256 -hex | awk '{print $NF}')
  STS_STR="TC3-HMAC-SHA256\n${TS}\n${CR}\n${HCS}"
  SD=$(printf '%s' "${DATE}" | openssl dgst -sha256 -hmac "TC3${API_SECRET_KEY}" -hex | awk '{print $NF}')
  SV=$(printf '%s' "tcr" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SD}" -hex | awk '{print $NF}')
  SS=$(printf '%s' "tc3_request" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SV}" -hex | awk '{print $NF}')
  SIG=$(printf "${STS_STR}" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SS}" -hex | awk '{print $NF}')
  AUTH="TC3-HMAC-SHA256 Credential=${API_SECRET_ID}/${CR}, SignedHeaders=${SH}, Signature=${SIG}"

  RESP=$(curl -sS -X POST "https://${HOST}" \
    -H "Authorization: ${AUTH}" -H "Content-Type: application/json; charset=utf-8" \
    -H "Host: ${HOST}" -H "X-TC-Action: CreateInstanceToken" \
    -H "X-TC-Timestamp: ${TS}" -H "X-TC-Version: 2019-09-24" \
    -H "X-TC-Region: ${TCR_REGION:-ap-shanghai}" -H "X-TC-Token: ${API_TOKEN}" \
    --data "$PAYLOAD")
  U=$(echo "$RESP" | jq -r '.Response.Username')
  P=$(echo "$RESP" | jq -r '.Response.Token')
  echo "[login] enterprise STS → CreateInstanceToken"
  printf '%s' "$P" | docker login -u "$U" --password-stdin "${TCR_REGISTRY}"
else
  # ── 个人版：自动开通 + 账密登录 ──────────────────────
  AUTO_PW=$(printf '%s' "${CLOUDBASE_UIN:-unknown}_${CLOUDBASE_ENV_ID:-unknown}" | md5sum | cut -c1-16)

  # 用 STS 凭证通过 TCR API 尝试自动开通 CCR 账号（TC3-HMAC-SHA256 签名）
  echo "[login] auto-register CCR personal account ..."
  HOST="tcr.tencentcloudapi.com"
  TS=$(date +%s)
  DATE=$(date -u -d "@${TS}" +"%Y-%m-%d" 2>/dev/null || date -u -r "${TS}" +"%Y-%m-%d")
  PAYLOAD=$(printf '{"Password":"%s"}' "$AUTO_PW")
  HP=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hex | awk '{print $NF}')
  CH="content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:createuserpersonal\n"
  SH="content-type;host;x-tc-action"
  CS="POST\n/\n\n${CH}\n${SH}\n${HP}"
  CR="${DATE}/tcr/tc3_request"
  HCS=$(printf "${CS}" | openssl dgst -sha256 -hex | awk '{print $NF}')
  STS2="TC3-HMAC-SHA256\n${TS}\n${CR}\n${HCS}"
  SD=$(printf '%s' "${DATE}" | openssl dgst -sha256 -hmac "TC3${API_SECRET_KEY}" -hex | awk '{print $NF}')
  SV=$(printf '%s' "tcr" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SD}" -hex | awk '{print $NF}')
  SS=$(printf '%s' "tc3_request" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SV}" -hex | awk '{print $NF}')
  SIG=$(printf "${STS2}" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SS}" -hex | awk '{print $NF}')
  AUTH="TC3-HMAC-SHA256 Credential=${API_SECRET_ID}/${CR}, SignedHeaders=${SH}, Signature=${SIG}"

  REG_RESULT=$(curl -sS -X POST "https://${HOST}" \
    -H "Authorization: ${AUTH}" -H "Content-Type: application/json; charset=utf-8" \
    -H "Host: ${HOST}" -H "X-TC-Action: CreateUserPersonal" \
    -H "X-TC-Timestamp: ${TS}" -H "X-TC-Version: 2019-09-24" \
    -H "X-TC-Token: ${API_TOKEN}" --data "$PAYLOAD" 2>&1)
  echo "[login] CreateUserPersonal: $(printf '%s' "$REG_RESULT" | head -c 300)"

  if echo "$REG_RESULT" | grep -q 'ErrUserExist'; then
    echo "[login] CCR 账号已存在"
    U="${CCR_USERNAME:-${CLOUDBASE_UIN}}"
    P="${SECRET_CCR_PASSWORD:-${CCR_PASSWORD:-}}"
  elif echo "$REG_RESULT" | grep -qv '"Error"'; then
    echo "[login] ✓ CCR 账号已自动开通"
    U="${CLOUDBASE_UIN}"
    P="$AUTO_PW"
  else
    echo "[login] 自动开通失败，回退 .env 密码"
    U="${CCR_USERNAME:-${CLOUDBASE_UIN}}"
    P="${SECRET_CCR_PASSWORD:-${CCR_PASSWORD:-}}"
  fi
  : "${U:?无法确定登录用户名}"
  : "${P:?无法确定登录密码}"

  # 自动创建命名空间（如果 .env 没填则用 tcb-<envId>）
  NS_CREATE="${TCR_NAMESPACE:-tcb-sandbox}"
  echo "[login] ensure namespace: ${NS_CREATE}"
  NSPAYLOAD='{"Namespace":"'"${NS_CREATE}"'"}'
  NSHP=$(printf '%s' "$NSPAYLOAD" | openssl dgst -sha256 -hex | awk '{print $NF}')
  NSCH="content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:createnamespacepersonal\n"
  NSCS="POST\n/\n\n${NSCH}\n${SH}\n${NSHP}"
  NSHCS=$(printf "${NSCS}" | openssl dgst -sha256 -hex | awk '{print $NF}')
  NSSTS2="TC3-HMAC-SHA256\n${TS}\n${CR}\n${NSHCS}"
  NSSIG=$(printf "${NSSTS2}" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"${SS}" -hex | awk '{print $NF}')
  NSAUTH="TC3-HMAC-SHA256 Credential=${API_SECRET_ID}/${CR}, SignedHeaders=${SH}, Signature=${NSSIG}"

  NSRES=$(curl -sS -X POST "https://${HOST}" \
    -H "Authorization: ${NSAUTH}" -H "Content-Type: application/json; charset=utf-8" \
    -H "Host: ${HOST}" -H "X-TC-Action: CreateNamespacePersonal" \
    -H "X-TC-Timestamp: ${TS}" -H "X-TC-Version: 2019-09-24" \
    -H "X-TC-Region: ${TCR_REGION:-ap-shanghai}" \
    -H "X-TC-Token: ${API_TOKEN}" --data "$NSPAYLOAD" 2>&1)
  echo "[login] CreateNamespacePersonal: $(printf '%s' "$NSRES" | head -c 200)"
  if echo "$NSRES" | grep -qv '"Error"'; then
    TCR_NAMESPACE="$NS_CREATE"
  fi

  printf '%s' "$P" | docker login -u "$U" --password-stdin "${TCR_REGISTRY}"
fi

T0=$(date +%s)
echo "[push] docker push ${IMAGE}"
docker push "${IMAGE}"
T1=$(date +%s)
echo "[push] done $((T1 - T0))s"
echo "::output::tag=${CLOUDBASE_VERSION_NAME}"
