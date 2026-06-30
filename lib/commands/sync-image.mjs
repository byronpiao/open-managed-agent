// sync-image — 将预构建镜像同步到用户的容器镜像服务（TCR）
//
// 用法：
//   magent sync-image                         # 交互 / 零配置
//   magent sync-image -p <密码>               # 已有访问凭证
//   magent sync-image -u <UIN> -p <密码>      # 显式指定 UIN+密码
//   magent sync-image -i sandbox              # 只同步指定镜像
//
// 自动处理：
//   - TCB 环境自动检测（tcb env use / 唯一环境 / 交互选择）
//   - UIN 自动从 tcb login 会话读取
//   - TCR 个人版：本地 ensure（开通/命名空间），对齐 cloudappserver 流程

import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { execSync } from "child_process";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { callTcbCloudApi } from "../api.mjs";
import { detectOrSelectEnvId } from "../env.mjs";
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
const {
  TCR_REGISTRY,
  CLOUDBASE_UIN = 'user',
  CLOUDBASE_SERVICE_NAME,
  CLOUDBASE_VERSION_NAME,
  BASELINE_IMAGE,
  COS_BASELINE_URL,
} = process.env;
const TCR_NAMESPACE = process.env.TCR_NAMESPACE || \`tcb-\${CLOUDBASE_UIN}\`;
if (!TCR_REGISTRY || !CLOUDBASE_SERVICE_NAME || !CLOUDBASE_VERSION_NAME || !BASELINE_IMAGE) {
  console.error('[pull] missing required env vars'); process.exit(1);
}
const TARGET = \`\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${CLOUDBASE_VERSION_NAME}\`;
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
// 个人版两条路径（由 sync 是否注入 SECRET_CCR_PASSWORD 决定）：
//   A. 有密码 → 直接 docker login（已开通 TCR 个人版）
//   B. 无密码 → CreateUserPersonal 首次开通 → 打印 auto 密码
//      ErrUserExist → 已开通但未给密码，exit 引导路径 A
//
// 企业版：TCR_INSTANCE_ID + STS CreateInstanceToken（iWiki 推荐）
//
// 平台注入的环境变量（不要引用其他 CLOUDBASE_* 变量，平台不保证注入）：
//   CLOUDBASE_SERVICE_NAME, CLOUDBASE_VERSION_NAME, CLOUDBASE_ENV_ID
//   API_SECRET_ID, API_SECRET_KEY, API_TOKEN
//   SECRET_<NAME> → 对应 CreateCloudApp Secrets[].Name

import { createHmac, createHash, randomBytes } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const {
  TCR_REGISTRY,
  CLOUDBASE_ENV_ID = 'unknown',
  CLOUDBASE_SERVICE_NAME,
  CLOUDBASE_VERSION_NAME,
  TCR_INSTANCE_ID,
  // TCR_NAMESPACE 由本地计算后显式传入（tcb-<env owner UIN>）
  TCR_NAMESPACE,
  // 登录凭证：CCR_USERNAME 明文 Env，SECRET_CCR_PASSWORD 来自 Secrets[]
  CCR_USERNAME,
  CCR_OWNER_UIN,  // 环境主账号 UIN，path B 零配置时用
  SECRET_CCR_PASSWORD,
  CCR_PASSWORD, // 兼容直接注入（本地测试用）
  TCR_REGION = 'ap-guangzhou', // personal TCR is only in ap-guangzhou; enterprise overrides via Env
  API_SECRET_ID,
  API_SECRET_KEY,
  API_TOKEN,
} = process.env;

if (!TCR_REGISTRY || !CLOUDBASE_SERVICE_NAME || !CLOUDBASE_VERSION_NAME) {
  console.error('[login] missing required platform vars: TCR_REGISTRY CLOUDBASE_SERVICE_NAME CLOUDBASE_VERSION_NAME');
  process.exit(1);
}
if (!TCR_NAMESPACE) {
  console.error('[login] TCR_NAMESPACE not set — sync must compute and inject it');
  process.exit(1);
}

const IMAGE = \`\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${CLOUDBASE_VERSION_NAME}\`;

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
    console.error('[login] docker login failed');
    process.exit(1);
  }
}

async function ensureNamespace() {
  console.log(\`[login] ensure namespace: \${TCR_NAMESPACE}\`);
  const nsResult = await tcrApi('CreateNamespacePersonal', { Namespace: TCR_NAMESPACE });
  console.log(\`[login] CreateNamespacePersonal: \${JSON.stringify(nsResult).slice(0, 200)}\`);
  const nsErr = nsResult.Response?.Error;
  if (!nsErr) {
    console.log(\`[login] namespace ready: \${TCR_NAMESPACE}\`);
    return;
  }
  const code = nsErr.Code || 'unknown';
  const msg = nsErr.Message || '';
  if (code.includes('NamespaceExist')) {
    console.log(\`[login] namespace ready: \${TCR_NAMESPACE}\`);
    return;
  }
  if (code.includes('NamespaceMaxLimit')) {
    console.log('');
    console.log('  命名空间数量已达上限');
    console.log('  1) 控制台删除不用的命名空间: https://console.cloud.tencent.com/tcr');
    console.log('  2) .env 设置 TCR_NAMESPACE=已有命名空间');
    console.log('');
    process.exit(1);
  }
  console.log(\`[login] 创建命名空间失败：\${code}\${msg ? ' ' + msg : ''}\`);
  process.exit(1);
}

// ── enterprise ──────────────────────────────────────────
if (TCR_INSTANCE_ID) {
  if (!API_SECRET_ID || !API_SECRET_KEY || !API_TOKEN) {
    console.error('[login] enterprise mode requires API_SECRET_ID, API_SECRET_KEY, API_TOKEN (platform STS)');
    process.exit(1);
  }
  console.log('[login] enterprise → CreateInstanceToken');
  const data = await tcrApi('CreateInstanceToken', {
    RegistryId: TCR_INSTANCE_ID,
    TokenType: 'LongTermToken',
  });
  const username = data.Response?.Username;
  const password = data.Response?.Token;
  if (!username || !password) {
    const err = data.Response?.Error;
    console.error(\`[login] CreateInstanceToken failed: \${err?.Code || 'unknown'} \${err?.Message || ''}\`);
    process.exit(1);
  }
  dockerLogin(username, password);

// ── personal ────────────────────────────────────────────
} else {
  if (!API_SECRET_ID || !API_SECRET_KEY) {
    console.error('[login] personal mode requires API_SECRET_ID, API_SECRET_KEY');
    process.exit(1);
  }

  // SECRET_CCR_PASSWORD: platform injects as $SECRET_<Name> from Secrets[].Name
  // CCR_PASSWORD: direct env var (local testing fallback)
  const suppliedPass = SECRET_CCR_PASSWORD || CCR_PASSWORD || '';
  const suppliedUser = CCR_USERNAME || '';

  let user, pass;

  if (suppliedPass) {
    // Path A — 已开通且提供了访问凭证
    console.log('[login] path A: 使用提供的 TCR 访问凭证');
    if (!suppliedUser) {
      console.error('[login] path A: CCR_USERNAME not set (must be injected via Env)');
      process.exit(1);
    }
    user = suppliedUser;
    pass = suppliedPass;

  } else {
    // Path B — 零配置：首次开通（CreateUserPersonal）
    console.log('[login] path B: 零配置 → CreateUserPersonal');
    const autoPw = 'Aa1' + randomBytes(12).toString('base64url').slice(0, 12);
    const regResult = await tcrApi('CreateUserPersonal', { Password: autoPw });
    console.log(\`[login] CreateUserPersonal: \${JSON.stringify(regResult).slice(0, 300)}\`);
    const errCode = tcrErrCode(regResult);
    if (errCode.includes('ErrUserExist')) {
      console.log('');
      console.log('=========================================');
      console.log('  TCR 个人版已开通，请提供访问凭证');
      console.log('');
      console.log('  零配置（路径 B）仅适用于从未开通 TCR 的主账号。');
      console.log('  已开通请在 .env 中设置：');
      console.log('    TCR_PASSWORD=<控制台访问凭证密码>');
      console.log('=========================================');
      process.exit(1);
    }
    if (errCode) {
      console.error(\`[login] CreateUserPersonal failed: \${errCode}\`);
      process.exit(1);
    }
    user = CCR_OWNER_UIN || CCR_USERNAME;
    pass = autoPw;
    console.log('');
    console.log('=========================================');
    console.log('  首次开通 TCR 个人版（CreateUserPersonal）');
    console.log(\`  ENV_ID:  \${CLOUDBASE_ENV_ID}\`);
    console.log('');
    console.log('  下次同步请在 .env 中填写：');
    console.log('  TCR_PASSWORD=<此次密码，见 magent sync-image 本地输出>');
    console.log('=========================================');
    console.log('');
  }

  await ensureNamespace();
  dockerLogin(user, pass);
}

const t0 = Date.now();
console.log(\`[push] docker push \${IMAGE}\`);
exec(\`docker push '\${IMAGE}'\`);
console.log(\`[push] done \${Math.round((Date.now() - t0) / 1000)}s\`);
console.log(\`[push] image: \${IMAGE}\`);
`,
};

// ═══════════ 本地 TCR ensure（对齐 cloudappserver EnsureNamespace）═══════════

function tcrErrCodeFromApiError(err) {
  // callTcbCloudApi throws with message "Tencent Cloud API <action> <Code>: <Message>"
  const m = err?.message?.match(/Tencent Cloud API \S+ (\S+?):/);
  return m?.[1] ?? "";
}

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

async function tcrApiLocal(action, payload) {
  return callTcbCloudApi({
    action,
    service: "tcr",
    version: "2019-09-24",
    endpoint: "tcr.tencentcloudapi.com",
    region: "ap-guangzhou", // personal TCR is only in ap-guangzhou
    payload,
    noThrow: true,
  });
}

function tcrCode(resp) {
  return resp?.Error?.Code ?? "";
}

/**
 * Local EnsureNamespace — mirrors cloudappserver logic.
 * @returns {{ loginUin, ownerUin, namespace, password, createdUser }}
 */
async function ensurePersonalTcr({ loginUin: uinIn = "", password: pwIn = "", namespace: nsIn = "" } = {}) {
  const identity = await getCallerIdentity();
  const loginUin = uinIn || identity.uin;
  const ownerUin = identity.ownerUin;
  const namespace = nsIn || `tcb-${ownerUin}`;

  let password = pwIn;
  let createdUser = false;

  console.log(`[ensure] caller UIN=${loginUin}  env owner=${ownerUin}  ns=${namespace}`);

  if (!password) {
    const vu = await tcrApiLocal("ValidateUserPersonal", { Username: loginUin });
    const vuCode = tcrCode(vu);
    if (vuCode.includes("UnauthorizedOperation")) {
      // 无读权限 — 子账号时提前拦截
      if (loginUin !== ownerUin) {
        throw new Error(
          `子账号 ${loginUin} 无 TCR 读权限，且 CNB 路径 B 无法代开主账号 TCR。\n` +
          `请先用主账号 tcb login 确认 TCR 已开通，再切回子账号并提供 --password。`,
        );
      }
      console.log(dim("[ensure] ValidateUserPersonal 无权限，跳过本地代开（CNB 将走路径 B，仅主账号首次有效）"));
      return { loginUin, ownerUin, namespace, password: "", createdUser: false, localEnsure: "skipped" };
    }
    if (vuCode) throw new Error(`ValidateUserPersonal: ${vuCode} ${vu.Error?.Message || ""}`);

    const isExist = Boolean(vu.Data?.IsExist);
    const mainIsExist = Boolean(vu.Data?.MainIsExist);
    console.log(`[ensure] ValidateUserPersonal IsExist=${isExist} MainIsExist=${mainIsExist}`);

    if (!isExist || !mainIsExist) {
      // 尝试 CreateUserPersonal — 子账号有权限时同样可代开
      password = platformRandomPassword();
      const cu = await tcrApiLocal("CreateUserPersonal", { Password: password });
      const cuCode = tcrCode(cu);
      if (cuCode.includes("ErrUserExist")) {
        password = "";
        console.log(dim("[ensure] CreateUserPersonal ErrUserExist — TCR 已注册，需提供密码"));
      } else if (cuCode.includes("UnauthorizedOperation")) {
        throw new Error(
          `子账号 ${loginUin} 无 tcr:CreateUserPersonal 权限，且主账号 ${ownerUin} 从未开通 TCR 个人版。\n` +
          `请切换到主账号登录后运行：tcb login && magent sync-image`,
        );
      } else if (cuCode) {
        throw new Error(`CreateUserPersonal: ${cuCode} ${cu.Error?.Message || ""}`);
      } else {
        createdUser = true;
        console.log("[ensure] CreateUserPersonal OK（等同控制台「初始化访问凭证」）");
      }
    } else {
      console.log(dim("[ensure] TCR 用户已就绪"));
    }

    if (!password) {
      const hint = loginUin !== ownerUin
        ? "子账号已注册 TCR，请填 --password（控制台「访问凭证」）"
        : "主账号已注册 TCR，请填 --password 或 .env TCR_PASSWORD";
      throw new Error(`缺少 TCR 访问凭证密码。${hint}`);
    }
  } else {
    console.log(dim("[ensure] 使用提供的 TCR 访问凭证"));
  }

  // ensure namespace
  const vn = await tcrApiLocal("ValidateNamespaceExistPersonal", { Namespace: namespace });
  const vnCode = tcrCode(vn);
  if (vnCode.includes("UnauthorizedOperation")) {
    console.log(dim("[ensure] ValidateNamespaceExistPersonal 无权限，跳过（CNB 会 CreateNamespacePersonal）"));
  } else if (vnCode) {
    throw new Error(`ValidateNamespaceExistPersonal: ${vnCode}`);
  } else if (vn.Data?.IsExist) {
    console.log(`[ensure] namespace exists: ${namespace}`);
  } else {
    const cn = await tcrApiLocal("CreateNamespacePersonal", { Namespace: namespace });
    const cnCode = tcrCode(cn);
    if (cnCode.includes("NamespaceExist")) {
      console.log(`[ensure] namespace exists: ${namespace}`);
    } else if (cnCode.includes("NamespaceMaxLimit")) {
      throw new Error("命名空间数量已达上限，请清理或用 --namespace <已有命名空间>");
    } else if (cnCode) {
      throw new Error(`CreateNamespacePersonal: ${cnCode} ${cn.Error?.Message || ""}`);
    } else {
      console.log(`[ensure] namespace created: ${namespace}`);
    }
  }

  if (createdUser) {
    console.log("");
    console.log("=========================================");
    console.log("  已代开 TCR 个人版访问凭证");
    console.log(`  UIN:  ${loginUin}`);
    console.log(`  密码: ${password}`);
    console.log("  建议写入 .env 以便下次零交互：");
    console.log(`  TCR_PASSWORD=${password}`);
    console.log("=========================================");
    console.log("");
  }

  return { loginUin, ownerUin, namespace, password, createdUser, localEnsure: "full" };
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

async function promptPassword(label) {
  return new Promise((resolve) => {
    console.log(cyan(`${label}: `));
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let pwd = "";
    process.stdin.on("data", (chunk) => {
      const str = chunk.toString();
      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          process.stdout.write("\n");
          process.stdin.setRawMode(wasRaw ?? false);
          process.stdin.pause();
          resolve(pwd);
          return;
        }
        if (ch === "\x7f" || ch === "\b") {
          if (pwd) { pwd = pwd.slice(0, -1); process.stdout.write("\b \b"); }
        } else {
          pwd += ch;
          process.stdout.write("*");
        }
      }
    });
  });
}

async function uploadZip(envId, serviceName, scripts) {
  const cosResp = await callTcbCloudApi({
    action: "DescribeCloudAppCosInfo",
    payload: { EnvId: envId, ServiceName: serviceName, DeployType: "custom", NeedDownload: false },
  });
  const uploadUrl = cosResp.UploadUrl;
  const headers = cosResp.UploadHeaders ?? [];
  const ts = cosResp.UnixTimestamp;

  const tmp = execSync("mktemp -d").toString().trim();
  const zipPath = `${tmp}/bundle.zip`;
  for (const [name, content] of Object.entries(scripts)) {
    writeFileSync(`${tmp}/${name}`, content);
    if (name.endsWith(".mjs")) execSync(`chmod +x ${tmp}/${name}`);
  }
  execSync(`cd ${tmp} && zip -qr ${zipPath} . -i '*.mjs' -i 'Dockerfile.bootstrap'`);

  const zipBuf = readFileSync(zipPath);
  execSync(`rm -rf ${tmp}`);

  const curlArgs = ["curl", "-sS", "-X", "PUT", uploadUrl, "-H", "Content-Type: application/zip", "--data-binary", "@-", "-o", "/dev/null", "-w", "%{http_code}"];
  for (const h of headers) {
    if (h.Key && h.Value) curlArgs.push("-H", `${h.Key}: ${h.Value}`);
  }
  const cp = spawnSync("curl", curlArgs.slice(1), { input: zipBuf, encoding: "utf-8" });
  if (cp.stdout.trim() !== "200") throw new Error(`COS upload failed: ${cp.stdout.trim()}`);

  return ts;
}

// ═══════════ command ═══════════

export function registerSyncImageCommand(program) {
  program
    .command("sync-image")
    .description("将预构建镜像同步到您的容器镜像服务（TCR）")
    .option("-u, --uin <uin>", "腾讯云账号 UIN（默认自动检测）")
    .option("-p, --password <password>", "访问凭证密码")
    .option("-i, --images <list>", "镜像: sandbox,tcbr,scf,all（默认 all）")
    .option("-e, --env-id <id>", "TCB 环境 ID（默认自动检测）")
    .option("-n, --namespace <ns>", "命名空间（默认 tcb-<主账号UIN>）")
    .option("--endpoint <url>", "仓库地址（默认 ccr.ccs.tencentyun.com）")
    .option("--baseline-tag <tag>", "固定版本 tag（默认 latest）")
    .option("--no-save", "不保存凭证到 .env")
    .action(handleSyncImage);
}

async function handleSyncImage(options) {
  // ── env ────────────────────────────────────────────────
  const envId = await detectOrSelectEnvId(options.envId || "");
  console.log(`TCB 环境: ${bold(envId)}`);

  // ── 镜像选择 ───────────────────────────────────────────
  const images = options.images || "all";
  let selectedImages = images === "all"
    ? Object.keys(IMAGES)
    : images.split(",").map(s => s.trim()).filter(k => IMAGES[k]);

  if (selectedImages.length === 0) {
    console.error(red("未选择任何镜像。可用: sandbox,tcbr,scf,all"));
    process.exit(1);
  }

  // ── 交互补全镜像选择（仅当用户没有通过 -i 明确指定时）───
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

  // ── TCR ensure ────────────────────────────────────────
  const endpoint = options.endpoint || "ccr.ccs.tencentyun.com";
  let password = options.password || process.env.TCR_PASSWORD || "";

  // If password not provided and we're in a TTY, offer masked prompt
  if (!password && process.stdin.isTTY) {
    const hasCreds = await question(
      "已有 TCR 个人版访问凭证？[Y/n]",
      "n",
    );
    if (hasCreds.toUpperCase() === "Y") {
      password = await promptPassword("访问凭证密码");
    }
  }

  let ensured;
  console.log("");
  try {
    ensured = await ensurePersonalTcr({
      loginUin: options.uin || process.env.TCR_UIN || "",
      password,
      namespace: options.namespace || "",
    });
  } catch (e) {
    console.error(red(`ERROR: ${e.message}`));
    process.exit(1);
  }

  const { loginUin, ownerUin, namespace, password: resolvedPassword, createdUser } = ensured;

  console.log(`  目标: ${endpoint}/${namespace}`);
  console.log(`  登录: UIN ${loginUin}${loginUin !== ownerUin ? ` (NS 属主 ${ownerUin})` : ""}`);
  console.log("");

  const baselineTag = options.baselineTag || "latest";
  const POLL_MS = 5000;
  const TIMEOUT_MS = 1200_000;
  const results = [];

  // ── 每个镜像逐一构建 ──────────────────────────────────
  for (const key of selectedImages) {
    const img = { ...IMAGES[key] };
    if (baselineTag !== "latest") {
      img.baseline = img.baseline.replace(/:latest$/, `:${baselineTag}`);
    }
    console.log(`${bold(img.name)} …`);
    try {
      const ts = await uploadZip(envId, img.imageName, CNB_SCRIPTS);
      const resp = await callTcbCloudApi({
        action: "CreateCloudApp",
        payload: {
          EnvId: envId,
          ServiceName: img.imageName,
          DeployType: "custom",
          BuildType: "zip",
          Source: { Type: "zip", CosTimestamp: ts, CosSuffix: ".zip" },
          Env: [
            { Key: "BASELINE_IMAGE", Value: img.baseline },
            { Key: "TCR_REGISTRY", Value: endpoint },
            // 本地已确认，显式传入，避免 CNB 靠 CLOUDBASE_UIN 猜测
            { Key: "TCR_NAMESPACE", Value: namespace },
            // CCR_USERNAME: path A 登录 UIN
            { Key: "CCR_USERNAME", Value: loginUin },
            // CCR_OWNER_UIN: path B 零配置时 docker login 用主账号身份
            { Key: "CCR_OWNER_UIN", Value: ownerUin },
            // personal TCR is only in ap-guangzhou; enterprise caller sets own region via --endpoint
            { Key: "TCR_REGION", Value: "ap-guangzhou" },
          ],
          Secrets: resolvedPassword ? [{ Name: "CCR_PASSWORD", Value: resolvedPassword }] : [],
          CustomSteps: [
            { Name: "bootstrap-docker", Command: "docker build -f Dockerfile.bootstrap -t cloudapp-bootstrap:tmp ." },
            { Name: "pull-baseline", Command: "node ./pull-baseline.mjs" },
            { Name: "login-and-push", Command: "node ./tcr-sts-login.mjs" },
          ],
        },
      });
      const ver = resp.VersionName;
      console.log(`  VersionName: ${ver}`);

      const deadline = Date.now() + TIMEOUT_MS;
      let done = false;
      let lastSteps = "";
      while (!done) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const data = await callTcbCloudApi({
          action: "DescribeCloudAppVersion",
          payload: { EnvId: envId, ServiceName: img.imageName, VersionName: ver, DeployType: "custom" },
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
                  payload: { EnvId: envId, ServiceName: img.imageName, ServiceVersion: ver, BuildId: Number(bid), Start: 1 },
                });
                const logText = logResp?.Log?.Text ?? "";
                if (logText) {
                  const idx = logText.indexOf("login-and-push");
                  if (idx >= 0) {
                    console.error(dim("  login-and-push 日志:\n    " + logText.slice(idx).replace(/\n/g, "\n    ")));
                  } else {
                    const lines = logText.split("\n");
                    const lastDash = lines.map((l, i) => l.match(/^-+ .+ -+$/) ? i : -1).filter(i => i >= 0).pop();
                    if (lastDash >= 0) console.error(dim(lines.slice(lastDash, lastDash + 20).join("\n")));
                  }
                }
              }
            } catch {}
          } else {
            const fullImage = `${endpoint}/${namespace}/${img.imageName}:${ver}`;
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

    // 保存凭证到 .env
    if (resolvedPassword && !options.noSave && process.stdin.isTTY) {
      const save = await question("\n保存配置到 .env？下次可直接 magent sync-image [Y/n]", "Y");
      if (save.toUpperCase() === "Y") {
        const envPath = resolve(process.cwd(), ".env");
        let content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
        if (!content.includes("TCR_PASSWORD=")) content += `\nTCR_PASSWORD=${resolvedPassword}`;
        writeFileSync(envPath, content.trim() + "\n");
        console.log(green(`  已写入 ${envPath}`));
        const giPath = resolve(process.cwd(), ".gitignore");
        let gi = existsSync(giPath) ? readFileSync(giPath, "utf-8") : "";
        if (!gi.includes(".env")) {
          writeFileSync(giPath, (gi.trim() + "\n.env\n").trimStart());
          console.log(dim("  .gitignore 已添加 .env"));
        }
      }
    }
  }
}
