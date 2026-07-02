// TCR image tag rules for magent sync-image (aligned with GHCR publish.sh timestamps).

/** @returns {string} e.g. 260616-1430 */
export function formatSyncTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yy = pad(date.getFullYear() % 100);
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yy}${mm}${dd}-${hh}${min}`;
}

/**
 * @param {"sandbox"|"tcbr"|"scf"} imageKey
 * @param {string} ts from formatSyncTimestamp()
 */
export function resolveSyncImageTag(imageKey, ts) {
  switch (imageKey) {
    case "sandbox":
      return `magent-${ts}`;
    case "tcbr":
      return ts;
    case "scf":
      return `${ts}-scf`;
    default:
      throw new Error(`unknown image key: ${imageKey}`);
  }
}

/**
 * CNB 侧解析推送 tag：优先 IMAGE_TAG；否则按服务名现场生成（不用平台 VersionName）。
 * 逻辑须与 sync-image.mjs 内嵌 CNB 脚本保持一致。
 */
export function resolveCnbImageTag({ imageTag, serviceName, baselineImage, now = new Date() }) {
  if (imageTag) return imageTag;
  const ts = formatSyncTimestamp(now);
  if (serviceName === "tcb-sandbox") return `magent-${ts}`;
  if (baselineImage?.includes("open-managed-agent-scf")) return `${ts}-scf`;
  if (serviceName === "open-managed-agent") return ts;
  return `magent-${ts}`;
}

/** @internal keep in sync with resolveCnbImageTag */
export const CNB_RESOLVE_IMAGE_TAG_SNIPPET = `
function formatTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getFullYear() % 100) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
function resolveImageTag() {
  if (process.env.IMAGE_TAG) return process.env.IMAGE_TAG;
  const ts = formatTs();
  const svc = process.env.CLOUDBASE_SERVICE_NAME;
  const base = process.env.BASELINE_IMAGE || '';
  if (svc === 'tcb-sandbox') return 'magent-' + ts;
  if (base.includes('open-managed-agent-scf')) return ts + '-scf';
  if (svc === 'open-managed-agent') return ts;
  return 'magent-' + ts;
}
`.trim();
