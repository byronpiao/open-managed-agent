// sync-image — 将预构建镜像同步到用户的容器镜像服务（TCR）
//
// 用法：
//   magent sync-image              # 零配置
//   magent sync-image -i sandbox   # 只同步指定镜像
//
// 自动处理：
//   - TCB 环境自动检测（tcb env use / 唯一环境 / 交互选择）
//   - 个人版：准备命名空间，推送由构建流水线自动完成

import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callTcbCloudApi } from "../api.mjs";
import { detectOrSelectEnvId } from "../env.mjs";
import { formatSyncTimestamp, resolveSyncImageTag, CNB_RESOLVE_IMAGE_TAG_SNIPPET } from "../sync-image-tags.mjs";
import { green, red, cyan, dim, bold } from "../ui.mjs";

// ═══════════ 镜像定义 ═══════════
const IMAGES = {
  sandbox: {
    name: "CloudBase 沙箱镜像",
    desc: "使用沙箱功能必选",
    imageName: "tcb-sandbox",
    baseline: "ghcr.io/realalexandreai/tcb-remote-workspace:latest",
  },
  tcbr: {
    name: "OpenManagedAgent 云托管镜像",
    desc: "TCBR 容器部署",
    imageName: "open-managed-agent",
    baseline: "ghcr.io/realalexandreai/open-managed-agent:latest",
  },
  scf: {
    name: "OpenManagedAgent 云函数镜像",
    desc: "SCF 函数算力部署",
    imageName: "open-managed-agent",
    baseline: "ghcr.io/realalexandreai/open-managed-agent-scf:latest",
    scf: true,
  },
};

// ═══════════ CNB 脚本（内嵌，写入临时 zip） ═══════════
const CNB_SCRIPTS = {
  "Dockerfile.bootstrap": `FROM alpine:3.19\nRUN echo "cloudapp-docker-bootstrap"\n`,

  "pull-baseline.mjs": `#!/usr/bin/env node
// CNB step: 从公开仓库拉取预构建镜像，tag 为用户 TCR 目标
//   GHCR: docker pull → tag
//   COS:  curl | docker load → tag
import { execSync } from 'node:child_process';
${CNB_RESOLVE_IMAGE_TAG_SNIPPET}
const {
  TCR_REGISTRY,
  CLOUDBASE_UIN = 'user',
  CLOUDBASE_SERVICE_NAME,
  BASELINE_IMAGE,
  COS_BASELINE_URL,
} = process.env;
const TCR_NAMESPACE = process.env.TCR_NAMESPACE || \`tcb-\${CLOUDBASE_UIN}\`;
const tag = resolveImageTag();
if (!TCR_REGISTRY || !CLOUDBASE_SERVICE_NAME || !BASELINE_IMAGE) {
  console.error('[pull] missing required env vars'); process.exit(1);
}
const TARGET = \`\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${tag}\`;
function exec(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'] }).trim();
}
const t0 = Date.now(); let src;
if (COS_BASELINE_URL) {
  console.log(\`[cos] curl \${COS_BASELINE_URL} | docker load\`);
  const loadOut = execSync(
    \`curl -fsSL --retry 3 --retry-delay 5 '\${COS_BASELINE_URL}' | docker load 2>&1\`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'], shell: true },
  );
  const match = loadOut.match(/Loaded image(?: ID)?:\\s*(\\S+)/);
  src = match?.[1] || BASELINE_IMAGE;
  console.log(\`[cos] loaded \${src}  \${Math.round((Date.now() - t0) / 1000)}s\`);
} else {
  src = BASELINE_IMAGE;
  console.log(\`[ghcr] docker pull \${src}\`);
  exec(\`docker pull '\${src}'\`);
  console.log(\`[ghcr] pulled  \${Math.round((Date.now() - t0) / 1000)}s\`);
}
console.log(\`[tag] \${src} → \${TARGET}\`);
exec(\`docker tag '\${src}' '\${TARGET}'\`);
console.log('[ok] pull + tag done');
`,

  "tcr-sts-login.mjs": `#!/usr/bin/env node
// CNB step: 登录 TCR 个人版/企业版 + docker push
//
// 个人版：主账号 ApplicationToken（cloud-tcb EnsureImageToken）
// 企业版：TCR_INSTANCE_ID + STS CreateInstanceToken

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
${CNB_RESOLVE_IMAGE_TAG_SNIPPET}

const {
  TCR_REGISTRY,
  CLOUDBASE_SERVICE_NAME,
  BASELINE_IMAGE,
  TCR_INSTANCE_ID,
  TCR_NAMESPACE,
  CCR_OWNER_UIN,
  TCR_REGION = 'ap-guangzhou',
  API_SECRET_ID,
  API_SECRET_KEY,
  API_TOKEN,
} = process.env;

const tag = resolveImageTag();
if (!TCR_REGISTRY || !CLOUDBASE_SERVICE_NAME) {
  console.error('[login] missing required vars: TCR_REGISTRY CLOUDBASE_SERVICE_NAME');
  process.exit(1);
}
if (!TCR_NAMESPACE) {
  console.error('[login] TCR_NAMESPACE not set — sync must compute and inject it');
  process.exit(1);
}

const IMAGE = \`\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${tag}\`;

function hmacSha256Hex(key, data) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(data).digest('hex');
}
function hmacSha256Str(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}
function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}
function exec(cmd, opts) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'inherit'], ...opts }).trim();
}

function signTC3({ secretId, secretKey, token, action, host, payload, region, ts, date, service = 'tcr', version = '2019-09-24' }) {
  const hp = sha256hex(payload);
  const ch = \`content-type:application/json; charset=utf-8\\nhost:\${host}\\nx-tc-action:\${action.toLowerCase()}\\n\`;
  const sh = 'content-type;host;x-tc-action';
  const cs = \`POST\\n/\\n\\n\${ch}\\n\${sh}\\n\${hp}\`;
  const cr = \`\${date}/\${service}/tc3_request\`;
  const hcs = sha256hex(cs);
  const sts = \`TC3-HMAC-SHA256\\n\${ts}\\n\${cr}\\n\${hcs}\`;
  const sd = hmacSha256Str(\`TC3\${secretKey}\`, date);
  const sv = hmacSha256Hex(sd, service);
  const ss = hmacSha256Hex(sv, 'tc3_request');
  const sig = hmacSha256Hex(ss, sts);
  const headers = new Headers();
  headers.set('Authorization', \`TC3-HMAC-SHA256 Credential=\${secretId}/\${cr}, SignedHeaders=\${sh}, Signature=\${sig}\`);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Host', host);
  headers.set('X-TC-Action', action);
  headers.set('X-TC-Timestamp', String(ts));
  headers.set('X-TC-Version', version);
  if (region) headers.set('X-TC-Region', region);
  if (token) headers.set('X-TC-Token', token);
  return headers;
}

async function tcrApi(action, payload, opts = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const host = 'tcr.tencentcloudapi.com';
  const headers = signTC3({
    secretId: API_SECRET_ID, secretKey: API_SECRET_KEY, token: API_TOKEN,
    action, host, payload: JSON.stringify(payload), region: TCR_REGION, ts, date,
    ...opts,
  });
  const resp = await fetch(\`https://\${host}\`, { method: 'POST', headers, body: JSON.stringify(payload) });
  return resp.json();
}

function tcrErrCode(result) {
  return result.Response?.Error?.Code || '';
}

function dockerLogin(user, pass) {
  const r = spawnSync('docker', ['login', '-u', user, '--password-stdin', TCR_REGISTRY], {
    input: pass,
    encoding: 'utf-8',
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (r.status !== 0) {
    console.error('[推送] 登录镜像仓库失败');
    process.exit(1);
  }
}

async function ensureUserPersonal(loginUin) {
  const vu = await tcrApi('ValidateUserPersonal', { Username: loginUin });
  const vuErr = tcrErrCode(vu);
  if (vuErr) {
    console.error('[推送] 检查 TCR 个人版状态失败');
    process.exit(1);
  }
  const isExist = Boolean(vu.Response?.Data?.IsExist);
  const mainIsExist = Boolean(vu.Response?.Data?.MainIsExist);
  if (isExist && mainIsExist) return;
  const autoPw = 'Aa1' + randomBytes(12).toString('base64url').slice(0, 12);
  const cu = await tcrApi('CreateUserPersonal', { Password: autoPw });
  const cuErr = tcrErrCode(cu);
  if (cuErr && !cuErr.includes('ErrUserExist')) {
    console.error('[推送] 开通 TCR 个人版失败');
    process.exit(1);
  }
}

async function ensureNamespace() {
  const nsResult = await tcrApi('CreateNamespacePersonal', { Namespace: TCR_NAMESPACE });
  const nsErr = nsResult.Response?.Error;
  if (!nsErr) return;
  const code = nsErr.Code || 'unknown';
  if (code.includes('NamespaceExist')) return;
  if (code.includes('NamespaceMaxLimit')) {
    console.log('');
    console.log('  命名空间数量已达上限。');
    console.log('');
    console.log('  个人版 TCR 可创建的命名空间有限，请任选以下方式之一：');
    console.log('    方式一：前往 TCR 控制台，删除不再使用的命名空间');
    console.log('          https://console.cloud.tencent.com/tcr');
    console.log('    方式二：指定一个已有的命名空间，复用该命名空间继续同步');
    console.log('          magent sync-image --namespace <您的命名空间>');
    console.log('');
    process.exit(1);
  }
  console.error('[推送] 创建命名空间失败');
  process.exit(1);
}

async function ensureApplicationToken() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 3; i++) {
    const r = await tcrApi('DescribeApplicationTokenPersonal', {});
    const err = tcrErrCode(r);
    if (!err) {
      const t = r.Response?.Data?.ApplicationToken;
      if (t) return t;
    } else if (i === 2) {
      console.error('[推送] 获取登录凭证失败，请稍后重试');
      process.exit(1);
    }
    await sleep(200);
  }
  console.log('[推送] 正在准备登录凭证…');
  const createR = await tcrApi('CreateApplicationTokenPersonal', {});
  const createErr = tcrErrCode(createR);
  if (createErr && !createErr.includes('Duplicate')) {
    console.error('[推送] 准备登录凭证失败，请稍后重试');
    process.exit(1);
  }
  for (let i = 0; i < 3; i++) {
    const r = await tcrApi('DescribeApplicationTokenPersonal', {});
    const t = r.Response?.Data?.ApplicationToken;
    if (t) return t;
    await sleep(200);
  }
  console.error('[推送] 登录凭证无效，请稍后重试');
  process.exit(1);
}

async function ensureEnterpriseNamespace(registryId, region, namespace) {
  const r = await tcrApi('CreateNamespace', {
    RegistryId: registryId,
    NamespaceName: namespace,
    IsPublic: false,
  });
  const err = tcrErrCode(r);
  if (!err || err.includes('ErrNamespaceExist') || err.includes('NamespaceExist')) return;
  if (err.includes('NamespaceMaxLimit') || err.includes('ErrNamespaceMaxLimit')) {
    console.log('');
    console.log('  命名空间数量已达上限。');
    console.log('    方式一：TCR 控制台删除不用的命名空间');
    console.log('    方式二：magent sync-image --namespace <您的命名空间>');
    console.log('');
    process.exit(1);
  }
  console.error('[推送] 创建命名空间失败');
  process.exit(1);
}

async function ensureEnterpriseRepository(registryId, region, namespace, repoName) {
  const dr = await tcrApi('DescribeRepositories', {
    RegistryId: registryId,
    NamespaceName: namespace,
    RepositoryName: repoName,
    Limit: 100,
    Offset: 0,
  });
  const drErr = tcrErrCode(dr);
  if (!drErr) {
    const repos = dr.Response?.RepositoryList ?? [];
    if (repos.some(x => x.Name === repoName)) return;
  }
  const cr = await tcrApi('CreateRepository', {
    RegistryId: registryId,
    NamespaceName: namespace,
    RepositoryName: repoName,
    BriefDescription: repoName,
    Description: repoName,
  });
  const crErr = tcrErrCode(cr);
  if (!crErr || crErr.includes('ErrRepoExist')) return;
  console.error('[推送] 创建镜像仓库失败');
  process.exit(1);
}

// ── enterprise ──────────────────────────────────────────
if (TCR_INSTANCE_ID) {
  if (!API_SECRET_ID || !API_SECRET_KEY || !API_TOKEN) {
    console.error('[推送] 构建环境配置不完整，请联系环境管理员');
    process.exit(1);
  }
  console.log('[推送] 正在登录企业版镜像仓库…');
  await ensureEnterpriseNamespace(TCR_INSTANCE_ID, TCR_REGION, TCR_NAMESPACE);
  await ensureEnterpriseRepository(TCR_INSTANCE_ID, TCR_REGION, TCR_NAMESPACE, CLOUDBASE_SERVICE_NAME);
  const data = await tcrApi('CreateInstanceToken', {
    RegistryId: TCR_INSTANCE_ID,
    TokenType: 'temp',
  });
  const username = data.Response?.Username;
  const password = data.Response?.Token;
  if (!username || !password) {
    console.error('[推送] 登录企业版镜像仓库失败，请检查实例 ID、地域和权限配置');
    console.error('[推送] 参考：https://cloud.tencent.com/document/product/1141/39287');
    process.exit(1);
  }
  dockerLogin(username, password);

// ── personal ────────────────────────────────────────────
} else {
  if (!API_SECRET_ID || !API_SECRET_KEY) {
    console.error('[推送] 构建环境配置不完整，请联系环境管理员');
    process.exit(1);
  }
  if (!CCR_OWNER_UIN) {
    console.error('[推送] 缺少账号信息，请重新运行 magent sync-image');
    process.exit(1);
  }

  console.log('[推送] 正在登录镜像仓库…');
  await ensureUserPersonal(CCR_OWNER_UIN);
  await ensureNamespace();
  const token = await ensureApplicationToken();
  dockerLogin(CCR_OWNER_UIN, token);
}

const t0 = Date.now();
console.log(\`[推送] 正在上传 \${IMAGE}\`);
exec(\`docker push '\${IMAGE}'\`);
console.log(\`[推送] 完成 \${Math.round((Date.now() - t0) / 1000)}s\`);
console.log(\`[推送] 镜像地址: \${IMAGE}\`);
`,
};

// ═══════════ 本地 TCR ensure（对齐 cloudappserver EnsureNamespace）═══════════

async function getCallerIdentity() {
  const resp = await callTcbCloudApi({
    action: "GetUserAppId",
    service: "cam",
    version: "2019-01-16",
    endpoint: "cam.tencentcloudapi.com",
    payload: {},
  });
  const uin = String(resp.Uin || "");
  const ownerUin = String(resp.OwnerUin || uin);
  if (!uin) throw new Error("无法获取当前登录 UIN，请先 tcb login");
  return { uin, ownerUin };
}

function platformRandomPassword() {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let tail = "";
  const buf = randomBytes(9);
  for (let i = 0; i < 9; i++) tail += chars[buf[i] % chars.length];
  return `Aa1${tail}`;
}

async function tcrApiLocal(action, payload, region = "ap-guangzhou") {
  return callTcbCloudApi({
    action,
    service: "tcr",
    version: "2019-09-24",
    endpoint: "tcr.tencentcloudapi.com",
    region,
    payload,
    noThrow: true,
  });
}

function tcrCode(resp) {
  return resp?.Error?.Code ?? "";
}

const NS_MAX_LIMIT_HINT =
  "命名空间数量已达上限。\n\n" +
  "个人版 TCR 可创建的命名空间有限，请任选以下方式之一：\n" +
  "  方式一：前往 TCR 控制台，删除不再使用的命名空间\n" +
  "        https://console.cloud.tencent.com/tcr\n" +
  "  方式二：指定一个已有的命名空间，复用该命名空间继续同步\n" +
  "        magent sync-image --namespace <您的命名空间>\n" +
  "        或在 .env 中设置 TCR_NAMESPACE=<您的命名空间>";

function defaultNamespace(ownerUin) {
  return `tcb-${ownerUin}`;
}

function namespacePrefix(ownerUin) {
  return `tcb-${ownerUin}-`;
}

function findNamespaceByPrefix(names, prefix) {
  for (const ns of names) {
    if (ns && ns.startsWith(prefix)) return ns;
  }
  return "";
}

async function namespaceExistsLocal(namespace) {
  const vn = await tcrApiLocal("ValidateNamespaceExistPersonal", { Namespace: namespace });
  const vnCode = tcrCode(vn);
  if (vnCode.includes("UnauthorizedOperation")) return null;
  if (vnCode) throw new Error(`命名空间检查失败：${vnCode}`);
  return Boolean(vn.Data?.IsExist);
}

async function listPersonalNamespaces(prefix) {
  const resp = await tcrApiLocal("DescribeNamespacePersonal", {
    Namespace: prefix,
    Limit: 100,
    Offset: 0,
  });
  const code = tcrCode(resp);
  if (code.includes("UnauthorizedOperation")) return null;
  if (code) throw new Error(`列举命名空间失败：${resp.Error?.Message || code}`);
  const infos = resp.Data?.NamespaceInfo ?? [];
  return infos.map((i) => i.Namespace).filter(Boolean);
}

/**
 * 命名空间解析（个人版 / 企业版共用规则）：
 * 1. 用户指定 → 直接用
 * 2. tcb-{uin} 已存在 → 复用
 * 3. 列举 tcb-{uin}-* → 复用第一个
 * 4. 否则 → 创建 tcb-{uin}
 */
async function resolveNamespace(ownerUin, userSpecified, { checkExists, listByPrefix }) {
  if (userSpecified) return userSpecified;

  const defaultNs = defaultNamespace(ownerUin);
  const defaultExist = await checkExists(defaultNs);
  if (defaultExist === true) return defaultNs;

  const prefix = namespacePrefix(ownerUin);
  const listed = await listByPrefix(prefix);
  if (Array.isArray(listed)) {
    const found = findNamespaceByPrefix(listed, prefix);
    if (found) {
      console.log(dim(`[准备] 复用已有命名空间: ${found}`));
      return found;
    }
  }

  return defaultNs;
}

async function resolveNamespacePersonal(ownerUin, userSpecified = "") {
  return resolveNamespace(ownerUin, userSpecified, {
    checkExists: (ns) => namespaceExistsLocal(ns),
    listByPrefix: (prefix) => listPersonalNamespaces(prefix),
  });
}

async function listEnterpriseNamespaces(registryId, region) {
  const resp = await tcrApiLocal("DescribeNamespaces", {
    RegistryId: registryId,
    Limit: 100,
    Offset: 0,
  }, region);
  const code = tcrCode(resp);
  if (code.includes("UnauthorizedOperation")) return null;
  if (code) throw new Error(`列举命名空间失败：${resp.Error?.Message || code}`);
  const list = resp.NamespaceList ?? [];
  return list.map((n) => n.Name).filter(Boolean);
}

async function resolveNamespaceEnterprise(ownerUin, userSpecified, registryId, region) {
  const names = await listEnterpriseNamespaces(registryId, region);
  return resolveNamespace(ownerUin, userSpecified, {
    checkExists: async (ns) => {
      if (names === null) return null;
      return names.includes(ns);
    },
    listByPrefix: async () => (names === null ? null : names),
  });
}

async function ensureNamespaceExists(namespace) {
  const exist = await namespaceExistsLocal(namespace);
  if (exist === true) {
    console.log(`[准备] 命名空间已存在: ${namespace}`);
    return;
  }
  if (exist === null) {
    console.log(dim("[准备] 命名空间将在构建流水线中确认"));
    return;
  }

  const cn = await tcrApiLocal("CreateNamespacePersonal", { Namespace: namespace });
  const cnCode = tcrCode(cn);
  if (cnCode.includes("NamespaceExist")) {
    console.log(`[准备] 命名空间已存在: ${namespace}`);
  } else if (cnCode.includes("NamespaceMaxLimit")) {
    throw new Error(NS_MAX_LIMIT_HINT);
  } else if (cnCode) {
    throw new Error(`创建命名空间失败：${cn.Error?.Message || cnCode}`);
  } else {
    console.log(`[准备] 命名空间已创建: ${namespace}`);
  }
}

/**
 * 本地准备：TCR 用户 + 命名空间（不存在则创建，已存在则复用）。
 * @returns {{ ownerUin, namespace, createdUser, localEnsure }}
 */
async function ensurePersonalTcr({ ownerUin: ownerUinIn = "", namespace: nsIn = "" } = {}) {
  const identity = ownerUinIn ? null : await getCallerIdentity();
  const ownerUin = ownerUinIn || identity.ownerUin;
  const userSpecified = nsIn || "";

  let createdUser = false;

  const vu = await tcrApiLocal("ValidateUserPersonal", { Username: ownerUin });
  const vuCode = tcrCode(vu);
  if (vuCode.includes("UnauthorizedOperation")) {
    console.log(dim("[准备] 将在构建流水线中完成 TCR 用户初始化"));
    let namespace;
    try {
      namespace = await resolveNamespacePersonal(ownerUin, userSpecified);
      console.log(`[准备] 命名空间: ${namespace}`);
      await ensureNamespaceExists(namespace);
    } catch {
      namespace = userSpecified || defaultNamespace(ownerUin);
      console.log(`[准备] 命名空间: ${namespace}（构建流水线将确认）`);
    }
    return { ownerUin, namespace, createdUser: false, localEnsure: "skipped" };
  }
  if (vuCode) throw new Error(`TCR 个人版检查失败：${vu.Error?.Message || vuCode}`);

  const isExist = Boolean(vu.Data?.IsExist);
  const mainIsExist = Boolean(vu.Data?.MainIsExist);

  if (!isExist || !mainIsExist) {
    const autoPw = platformRandomPassword();
    const cu = await tcrApiLocal("CreateUserPersonal", { Password: autoPw });
    const cuCode = tcrCode(cu);
    if (cuCode.includes("ErrUserExist")) {
      console.log(dim("[准备] 个人版 TCR 已开通"));
    } else if (cuCode.includes("UnauthorizedOperation")) {
      console.log(dim("[准备] 本地无开通权限，构建流水线将代开"));
    } else if (cuCode) {
      throw new Error(`开通 TCR 个人版失败：${cu.Error?.Message || cuCode}`);
    } else {
      createdUser = true;
      console.log("[准备] 已开通个人版 TCR");
    }
  } else {
    console.log(dim("[准备] 个人版 TCR 已开通"));
  }

  const namespace = await resolveNamespacePersonal(ownerUin, userSpecified);
  console.log(`[准备] 命名空间: ${namespace}`);
  await ensureNamespaceExists(namespace);

  if (createdUser) {
    console.log("");
    console.log("=========================================");
    console.log("  已为您开通 TCR 个人版");
    console.log(`  命名空间: ${namespace}`);
    console.log("  后续推送由构建流水线自动完成");
    console.log("=========================================");
    console.log("");
  }

  return { ownerUin, namespace, createdUser, localEnsure: "full" };
}

async function describeEnterpriseInstance(registryId, regionHint = "") {
  const payload = {
    Registryids: [registryId],
    Limit: 1,
  };
  if (!regionHint) payload.AllRegion = true;

  const resp = await tcrApiLocal(
    "DescribeInstances",
    payload,
    regionHint || "ap-guangzhou",
  );
  const code = tcrCode(resp);
  if (code) throw new Error(`查询 TCR 实例失败：${resp.Error?.Message || code}`);

  const reg = resp.Registries?.[0];
  if (!reg) throw new Error(`未找到 TCR 实例：${registryId}`);

  const publicDomain = reg.PublicDomain;
  const region = reg.RegionName || regionHint;
  if (!publicDomain) throw new Error("DescribeInstances 未返回实例公网域名");
  if (!region) {
    throw new Error("无法确定实例地域，请指定 --tcr-region（如 ap-guangzhou）");
  }
  return { publicDomain, region };
}

async function ensureNamespaceEnterprise(registryId, region, namespace) {
  const cn = await tcrApiLocal("CreateNamespace", {
    RegistryId: registryId,
    NamespaceName: namespace,
    IsPublic: false,
  }, region);
  const cnCode = tcrCode(cn);
  if (cnCode.includes("ErrNamespaceExist") || cnCode.includes("NamespaceExist")) {
    console.log(`[准备] 命名空间已存在: ${namespace}`);
    return;
  }
  if (cnCode.includes("NamespaceMaxLimit") || cnCode.includes("ErrNamespaceMaxLimit")) {
    throw new Error(NS_MAX_LIMIT_HINT);
  }
  if (cnCode) throw new Error(`创建命名空间失败：${cn.Error?.Message || cnCode}`);
  console.log(`[准备] 命名空间已创建: ${namespace}`);
}

async function ensureRepositoryEnterprise(registryId, region, namespace, repoName) {
  const dr = await tcrApiLocal("DescribeRepositories", {
    RegistryId: registryId,
    NamespaceName: namespace,
    RepositoryName: repoName,
    Limit: 100,
    Offset: 0,
  }, region);
  const drCode = tcrCode(dr);
  if (!drCode) {
    const repos = dr.RepositoryList ?? [];
    if (repos.some((r) => r.Name === repoName && r.Namespace === namespace)) {
      console.log(dim(`[准备] 镜像仓库已存在: ${repoName}`));
      return;
    }
  } else if (!drCode.includes("UnauthorizedOperation")) {
    throw new Error(`查询镜像仓库失败：${dr.Error?.Message || drCode}`);
  }

  const cr = await tcrApiLocal("CreateRepository", {
    RegistryId: registryId,
    NamespaceName: namespace,
    RepositoryName: repoName,
    BriefDescription: repoName,
    Description: repoName,
  }, region);
  const crCode = tcrCode(cr);
  if (!crCode || crCode.includes("ErrRepoExist")) {
    console.log(dim(`[准备] 镜像仓库已就绪: ${repoName}`));
    return;
  }
  if (crCode.includes("RepoMaxLimit") || crCode.includes("ErrRepoMaxLimit")) {
    throw new Error(`镜像仓库数量已达上限，请清理 TCR 控制台中 ${namespace} 下的仓库后重试`);
  }
  if (crCode) throw new Error(`创建镜像仓库失败：${cr.Error?.Message || crCode}`);
  console.log(`[准备] 镜像仓库已创建: ${repoName}`);
}

/**
 * 企业版本地准备：实例信息、命名空间、镜像仓库。
 * @returns {{ ownerUin, namespace, endpoint, region, localEnsure }}
 */
async function ensureEnterpriseTcr({
  ownerUin: ownerUinIn = "",
  namespace: nsIn = "",
  tcrInstanceId,
  tcrRegion: regionHint = "",
  repoNames = [],
}) {
  const identity = ownerUinIn ? null : await getCallerIdentity();
  const ownerUin = ownerUinIn || identity.ownerUin;
  const userSpecified = nsIn || "";

  const { publicDomain, region: tcrRegion } = await describeEnterpriseInstance(
    tcrInstanceId,
    regionHint,
  );
  if (!regionHint) console.log(dim(`[准备] 实例地域: ${tcrRegion}`));
  console.log(dim(`[准备] 实例域名: ${publicDomain}`));

  let namespace;
  try {
    namespace = await resolveNamespaceEnterprise(ownerUin, userSpecified, tcrInstanceId, tcrRegion);
    console.log(`[准备] 命名空间: ${namespace}`);
    await ensureNamespaceEnterprise(tcrInstanceId, tcrRegion, namespace);
  } catch (e) {
    if (userSpecified) throw e;
    namespace = defaultNamespace(ownerUin);
    console.log(`[准备] 命名空间: ${namespace}（构建流水线将确认）`);
  }

  for (const repoName of repoNames) {
    try {
      await ensureRepositoryEnterprise(tcrInstanceId, tcrRegion, namespace, repoName);
    } catch (e) {
      console.log(dim(`[准备] 镜像仓库 ${repoName} 将在构建流水线中确认（${e.message}）`));
    }
  }

  return { ownerUin, namespace, endpoint: publicDomain, region: tcrRegion, localEnsure: "full" };
}

// ═══════════ helpers ═══════════

function question(line, defaultValue = "") {
  return new Promise((resolve) => {
    const r = createInterface({ input: process.stdin, output: process.stdout });
    const prompt = defaultValue ? `${line} [${defaultValue}]: ` : `${line}: `;
    r.question(cyan(prompt), (answer) => {
      r.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function uploadZip(envId, serviceName, scripts) {
  const cosResp = await callTcbCloudApi({
    action: "DescribeCloudAppCosInfo",
    payload: { EnvId: envId, ServiceName: serviceName, DeployType: "custom", NeedDownload: false },
  });
  const uploadUrl = cosResp.UploadUrl;
  const ts = cosResp.UnixTimestamp;
  // H-1: validate required fields before proceeding
  if (!uploadUrl) throw new Error("无法获取上传地址，请确认 CloudBase 环境已开通镜像构建能力");
  if (!ts) throw new Error("上传初始化失败，请稍后重试");
  const headers = cosResp.UploadHeaders ?? [];

  // M-3: use mkdtempSync (portable, no external command) + try/finally cleanup
  const tmp = mkdtempSync(join(tmpdir(), "sync-image-"));
  let zipBuf;
  try {
    const zipPath = join(tmp, "bundle.zip");
    for (const [name, content] of Object.entries(scripts)) {
      writeFileSync(join(tmp, name), content);
      // M-1: quote paths to handle spaces/special chars
      if (name.endsWith(".mjs")) execSync(`chmod +x '${join(tmp, name)}'`);
    }
    execSync(`cd '${tmp}' && zip -qr '${zipPath}' . -i '*.mjs' -i 'Dockerfile.bootstrap'`);
    zipBuf = readFileSync(zipPath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const curlArgs = ["-sS", "-X", "PUT", uploadUrl, "-H", "Content-Type: application/zip", "--data-binary", "@-", "-o", "/dev/null", "-w", "%{http_code}"];
  for (const h of headers) {
    if (h.Key && h.Value) curlArgs.push("-H", `${h.Key}: ${h.Value}`);
  }
  const cp = spawnSync("curl", curlArgs, { input: zipBuf, encoding: "utf-8" });
  // L-3: surface curl process errors separately from HTTP errors
  if (cp.error || cp.status !== 0) {
    throw new Error(`COS upload: curl 退出 ${cp.status} — ${cp.stderr || cp.error?.message || "unknown"}`);
  }
  if (cp.stdout.trim() !== "200") {
    throw new Error(`COS upload failed: HTTP ${cp.stdout.trim() || "(no response)"}`);
  }

  return ts;
}

// ═══════════ command ═══════════

const MODE_LABEL = { personal: "个人版", enterprise: "企业版" };

export function registerSyncImageCommand(program) {
  program
    .command("sync-image")
    .description("将预构建镜像同步到您的腾讯云容器镜像服务（TCR），无需手动配置密码")
    .option("-i, --images <list>", "要同步的镜像：sandbox / tcbr / scf / all（默认 all）")
    .option("-e, --env-id <id>", "CloudBase 环境 ID（默认自动检测）")
    .option("-n, --namespace <命名空间>", "命名空间（默认自动，见文档）")
    .option("--mode <mode>", "TCR 类型：personal 个人版（默认）| enterprise 企业版")
    .option("--tcr-id <id>", "【企业版·必填】实例 ID（tcr-xxxxxxxx）")
    .option("--tcr-region <region>", "【企业版·可选】实例地域（留空则按实例 ID 自动查询）")
    .option("--baseline-tag <tag>", "基线镜像版本（默认 latest）")
    .action(handleSyncImage);
}

async function handleSyncImage(options) {
  const POLL_MS = 5000;
  const TIMEOUT_MS = 1800_000; // 30min, same as cloudapp/sync.mjs

  // ── TCR 模式 ───────────────────────────────────────────
  const mode = options.mode || process.env.TCR_MODE || "personal";
  if (mode !== "personal" && mode !== "enterprise") {
    console.error(red(`未知 TCR 类型: ${mode}。可用: personal（个人版）| enterprise（企业版）`));
    process.exit(1);
  }
  const isEnterprise = mode === "enterprise";

  // 企业版：仅需 tcr-id；region / 公网域名由 DescribeInstances 自动查询
  let tcrInstanceId = "";
  let tcrRegion = "";
  if (isEnterprise) {
    tcrInstanceId = options.tcrId || process.env.TCR_INSTANCE_ID || "";
    tcrRegion = options.tcrRegion || process.env.TCR_REGION || "";
    if (!tcrInstanceId) {
      console.error(red("企业版需要 --tcr-id（或在 .env 中设置 TCR_INSTANCE_ID）"));
      process.exit(1);
    }
  }

  // ── env ────────────────────────────────────────────────
  const envId = await detectOrSelectEnvId(options.envId || "");

  // 从 tcb login 会话预先获取身份信息，用于 pre-flight 展示和个人版 ensure
  // 对企业版也尝试获取以供展示，失败不阻断
  let preflightIdentity = null;
  try {
    preflightIdentity = await getCallerIdentity();
  } catch { /* 显示在 ensure 阶段 */ }

  console.log(`环境: ${bold(envId)}  TCR: ${bold(MODE_LABEL[mode] || mode)}`);
  if (preflightIdentity) {
    const { uin, ownerUin } = preflightIdentity;
    const tag = uin !== ownerUin ? `${dim("（子账号，主账号")} ${ownerUin}${dim("）")}` : "";
    console.log(`当前账号: ${bold(uin)} ${tag}`);
  }

  // ── 镜像选择 ───────────────────────────────────────────
  const images = options.images || "all";
  let selectedImages = images === "all"
    ? Object.keys(IMAGES)
    : images.split(",").map(s => s.trim()).filter(k => IMAGES[k]);

  if (selectedImages.length === 0) {
    console.error(red("未选择任何镜像。可用: sandbox,tcbr,scf,all"));
    process.exit(1);
  }

  // 交互补全镜像选择（仅当用户没有通过 -i 明确指定时）
  if (process.stdin.isTTY && (!options.images || options.images === "all")) {
    console.log("");
    console.log("选择要同步的镜像：");
    Object.entries(IMAGES).forEach(([k, v]) => console.log(`  ${k.padEnd(8)} ${v.name}  ${dim(v.desc)}`));
    const imgChoice = await question("镜像 [sandbox / tcbr / scf / all]", "all");
    if (imgChoice !== "all") {
      const chosen = imgChoice.split(",").map(s => s.trim()).filter(k => IMAGES[k]);
      if (chosen.length > 0) selectedImages = chosen;
    }
    console.log("");
  }

  // ── registry endpoint ──────────────────────────────────
  let endpoint = isEnterprise ? "" : "ccr.ccs.tencentyun.com";

  const baselineTag = options.baselineTag || "latest";
  const results = [];

  // ── TCR ensure ─────────────────────────────────────────
  let ownerUin = "", namespace = "";

  if (!isEnterprise) {
    console.log("");
    let ensured;
    try {
      ensured = await ensurePersonalTcr({
        ownerUin: preflightIdentity?.ownerUin || "",
        namespace: options.namespace || process.env.TCR_NAMESPACE || "",
      });
    } catch (e) {
      console.error(red(`ERROR: ${e.message}`));
      process.exit(1);
    }

    ({ ownerUin, namespace } = ensured);

    console.log(`  仓库: ${endpoint}/${namespace}`);
    console.log(`  推送: 构建流水线自动完成（无需密码）`);
    console.log("");

  } else {
    console.log("");
    const repoNames = [...new Set(selectedImages.map((k) => IMAGES[k].imageName))];
    let ensured;
    try {
      ensured = await ensureEnterpriseTcr({
        ownerUin: preflightIdentity?.ownerUin || "",
        namespace: options.namespace || process.env.TCR_NAMESPACE || "",
        tcrInstanceId,
        tcrRegion,
        repoNames,
      });
    } catch (e) {
      console.error(red(`ERROR: ${e.message}`));
      process.exit(1);
    }
    ({ ownerUin, namespace } = ensured);
    endpoint = ensured.endpoint;
    tcrRegion = ensured.region;

    console.log(`  仓库: ${endpoint}/${namespace}`);
    console.log(`  实例: ${tcrInstanceId}  地域: ${tcrRegion}`);
    console.log(`  推送: 构建流水线自动完成（无需密码）`);
    console.log("");
  }

  const syncTs = formatSyncTimestamp();
  console.log(`镜像标签: ${dim(`sandbox→magent-${syncTs}  tcbr→${syncTs}  scf→${syncTs}-scf`)}`);
  console.log("");

  // ── 每个镜像逐一构建 ──────────────────────────────────
  for (const key of selectedImages) {
    const img = { ...IMAGES[key] };
    const imageTag = resolveSyncImageTag(key, syncTs);
    if (baselineTag !== "latest") {
      img.baseline = img.baseline.replace(/:latest$/, `:${baselineTag}`);
    }

    console.log(`${bold(img.name)} …`);
    console.log(`  镜像标签: ${imageTag}`);
    try {
      const ts = await uploadZip(envId, img.imageName, CNB_SCRIPTS);

      // 按模式构建 Env[] / Secrets[]（对齐 cloudapp/sync.mjs buildBody）
      let envVars, secrets;
      const tagEnv = { Key: "IMAGE_TAG", Value: imageTag };
      if (!isEnterprise) {
        envVars = [
          { Key: "BASELINE_IMAGE", Value: img.baseline },
          { Key: "TCR_REGISTRY", Value: endpoint },
          { Key: "TCR_NAMESPACE", Value: namespace },
          { Key: "CCR_OWNER_UIN", Value: ownerUin },
          { Key: "TCR_REGION", Value: "ap-guangzhou" },
          tagEnv,
        ];
        secrets = [];
      } else {
        // 企业版：CCR_OWNER_UIN/CCR_USERNAME 不需要；TCR_INSTANCE_ID 触发 CNB 走企业分支
        // TCR_REGION 传给 CNB 用于 CreateInstanceToken 签名
        envVars = [
          { Key: "BASELINE_IMAGE", Value: img.baseline },
          { Key: "TCR_REGISTRY", Value: endpoint },
          { Key: "TCR_NAMESPACE", Value: namespace },
          { Key: "TCR_INSTANCE_ID", Value: tcrInstanceId },
          { Key: "TCR_REGION", Value: tcrRegion },
          tagEnv,
        ];
        // Secrets 为空（企业版通过 STS 获取临时 token，不需要静态密码）
        secrets = [];
      }

      const resp = await callTcbCloudApi({
        action: "CreateCloudApp",
        payload: {
          EnvId: envId,
          ServiceName: img.imageName,
          DeployType: "custom",
          BuildType: "zip",
          Source: { Type: "zip", CosTimestamp: String(ts), CosSuffix: ".zip" },
          Env: envVars,
          Secrets: secrets,
          CustomSteps: [
            { Name: "bootstrap-docker", Command: "docker build -f Dockerfile.bootstrap -t cloudapp-bootstrap:tmp ." },
            { Name: "pull-baseline", Command: "node ./pull-baseline.mjs" },
            { Name: "push-image", Command: "node ./tcr-sts-login.mjs" },
          ],
        },
      });
      const buildVersion = resp.VersionName;
      if (!buildVersion) {
        const errMsg = resp?.error?.message || JSON.stringify(resp);
        if (errMsg.includes("未开放")) throw new Error("当前环境暂未开通镜像构建能力，请联系环境管理员");
        throw new Error(`创建构建任务失败: ${errMsg}`);
      }

      const deadline = Date.now() + TIMEOUT_MS;
      let done = false;
      let lastSteps = "";
      while (!done) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const data = await callTcbCloudApi({
          action: "DescribeCloudAppVersion",
          payload: { EnvId: envId, ServiceName: img.imageName, VersionName: buildVersion, DeployType: "custom" },
        });
        const steps = data.Steps ?? [];
        const curSteps = steps.map(st => `${st.Name}/${st.Status}`).join(" ");
        if (curSteps !== lastSteps && curSteps.length > 0) {
          console.log(`  ${steps.map(st => `${st.Name}:${st.Status}[${st.Duration ?? ""}]`).join(" ")}`);
          lastSteps = curSteps;
        }
        const allDone = steps.length > 0 && steps.every(s =>
          s.Status === "success" || s.Status === "skipped" || s.Status === "failed"
        );
        if (allDone) {
          done = true;
          const failed = steps.filter(s => s.Status === "failed");
          if (failed.length > 0) {
            console.error(red("  ✗ 构建失败"));
            try {
              const bid = data.BuildId;
              if (bid) {
                const logResp = await callTcbCloudApi({
                  action: "DescribeCloudBaseRunBuildLog",
                  payload: { EnvId: envId, ServiceName: img.imageName, ServiceVersion: buildVersion, BuildId: Number(bid), Start: 1 },
                });
                const logText = logResp?.Log?.Text ?? "";
                if (logText) {
                  const idx = logText.indexOf("push-image");
                  if (idx >= 0) {
                    console.error(dim("  推送阶段日志:\n    " + logText.slice(idx).replace(/\n/g, "\n    ")));
                  } else {
                    const idxLegacy = logText.indexOf("login-and-push");
                    if (idxLegacy >= 0) {
                      console.error(dim("  推送阶段日志:\n    " + logText.slice(idxLegacy).replace(/\n/g, "\n    ")));
                    } else {
                      const lines = logText.split("\n");
                      const lastDash = lines.map((l, i) => l.match(/^-+ .+ -+$/) ? i : -1).filter(i => i >= 0).pop();
                      if (lastDash >= 0) console.error(dim(lines.slice(lastDash, lastDash + 20).join("\n")));
                    }
                  }
                }
              }
            } catch {}
          } else {
            const fullImage = `${endpoint}/${namespace}/${img.imageName}:${imageTag}`;
            results.push({ key, name: img.name, image: fullImage, scf: img.scf });
            console.log(green(`  ✓ ${fullImage}`));
          }
        } else if (Date.now() > deadline) {
          console.error(red("  ✗ 构建超时"));
          done = true;
        }
      }
    } catch (err) {
      console.error(red(`  ✗ ${err.message}`));
    }
    console.log("");
  }

  // ── 汇总 ──────────────────────────────────────────────
  if (results.length > 0) {
    console.log(bold("✓ 同步完成"));
    for (const r of results) {
      const label = r.scf ? "云函数" : r.key === "sandbox" ? "沙箱  " : "云托管";
      console.log(`  ${label}: ${r.image}`);
    }
  }
}
