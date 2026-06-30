// sync-image — 将预构建镜像同步到用户的容器镜像服务（TCR）
//
// 用法：
//   magent sync-image                    # 交互模式
//   magent sync-image --uin xxx --password xxx   # 参数模式
//
// 三种途径：
//   1. CLI 参数（-u / -p / --images）
//   2. .env 文件（读取 TCR_UIN / TCR_PASSWORD）
//   3. 交互模式（逐步问答）
//
// 自动检测：TCB 环境 ID、UIN、已有凭证

import { createInterface } from "readline";
import { execSync } from "child_process";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { callTcbCloudApi } from "../api.mjs";
import { detectCurrentEnvId } from "../env.mjs";
import { green, yellow, red, cyan, dim, bold } from "../ui.mjs";

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

// ═══════════ CNB 脚本模板 (Node.js — 零额外依赖) ═══════════
const CNB_SCRIPTS = {
  "Dockerfile.bootstrap": `FROM alpine:3.19\nRUN echo "cloudapp-docker-bootstrap"\n`,
  "pull-baseline.mjs": `#!/usr/bin/env node
// CNB step: docker pull + tag
import { execSync } from 'node:child_process';
const { TCR_REGISTRY, CLOUDBASE_UIN = 'user', CLOUDBASE_SERVICE_NAME, CLOUDBASE_VERSION_NAME, BASELINE_IMAGE, COS_BASELINE_URL } = process.env;
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
  try {
    const out = execSync(
      \`curl -fsSL --retry 3 --retry-delay 5 '\${COS_BASELINE_URL}' | docker load 2>&1 | grep -oP 'Loaded image(?: ID)?: \\\\\\\\K\\\\\\\\S+' | head -1\`,
      { encoding: 'utf-8', shell: true }
    );
    src = out.trim() || BASELINE_IMAGE;
  } catch { src = BASELINE_IMAGE; }
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
// CNB step: TCR login + namespace ensure + docker push
// Uses Node.js built-ins only (crypto, fetch, child_process)
import { createHmac, createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const {
  TCR_REGISTRY, CLOUDBASE_SERVICE_NAME, CLOUDBASE_VERSION_NAME,
  CLOUDBASE_UIN = 'unknown', CLOUDBASE_ENV_ID = 'unknown',
  API_SECRET_ID = '', API_SECRET_KEY = '', API_TOKEN = '',
  CCR_USERNAME = '', SECRET_CCR_PASSWORD = '', CCR_PASSWORD = '',
  TCR_INSTANCE_ID = '', TCR_REGION = 'ap-shanghai',
} = process.env;

const TCR_NAMESPACE = process.env.TCR_NAMESPACE || \`tcb-\${CLOUDBASE_UIN}\`;
const IMAGE = \`\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${CLOUDBASE_VERSION_NAME}\`;

// ── TC3 helpers ──
function hmacSha256Hex(key, data) {
  return createHmac('sha256', Buffer.from(key, 'hex')).update(data).digest('hex');
}
function hmacSha256Str(key, data) {
  return createHmac('sha256', key).update(data).digest('hex');
}
function sha256hex(data) {
  return createHash('sha256').update(data).digest('hex');
}
function signTC3(secretId, secretKey, service, host, action, version, payload, timestamp) {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const algorithm = 'TC3-HMAC-SHA256';
  const ct = 'application/json; charset=utf-8';
  const hp = sha256hex(payload);
  const canonicalHeaders = \`content-type:\${ct}\\nhost:\${host}\\nx-tc-action:\${action.toLowerCase()}\\n\`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = \`POST\\n/\\n\\n\${canonicalHeaders}\\n\${signedHeaders}\\n\${hp}\`;
  const hcs = sha256hex(canonicalRequest);
  const credentialScope = \`\${date}/\${service}/tc3_request\`;
  const stringToSign = \`\${algorithm}\\n\${timestamp}\\n\${credentialScope}\\n\${hcs}\`;
  const sd = hmacSha256Str(\`TC3\${secretKey}\`, date);
  const sv = hmacSha256Hex(sd, service);
  const ss = hmacSha256Hex(sv, 'tc3_request');
  const signature = hmacSha256Hex(ss, stringToSign);
  return \`\${algorithm} Credential=\${secretId}/\${credentialScope}, SignedHeaders=\${signedHeaders}, Signature=\${signature}\`;
}
async function tc3Request(secretId, secretKey, token, service, host, action, version, payload) {
  const ts = Math.floor(Date.now() / 1000);
  const auth = signTC3(secretId, secretKey, service, host, action, version, payload, ts);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Host': host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': String(ts),
    'Authorization': auth,
  };
  if (token) headers['X-TC-Token'] = token;
  const resp = await fetch(\`https://\${host}\`, { method: 'POST', headers, body: payload });
  return { status: resp.status, body: await resp.text() };
}

// ── enterprise mode ──
if (TCR_INSTANCE_ID) {
  console.log('[login] enterprise mode');
  const ep = \`tcr.\${TCR_REGION}.tencentcloudapi.com\`;
  const epPayload = JSON.stringify({ InstanceId: TCR_INSTANCE_ID });
  const { body: epBody } = await tc3Request(
    API_SECRET_ID, API_SECRET_KEY, API_TOKEN, 'tcr', ep,
    'CreateInstanceToken', '2019-09-24', epPayload
  );
  const epJson = JSON.parse(epBody);
  if (epJson.Response?.Error) {
    console.error(\`CreateInstanceToken failed: \${JSON.stringify(epJson.Response.Error)}\`);
    process.exit(1);
  }
  const UN = epJson.Response?.Username;
  const PW = epJson.Response?.Token;
  execSync(\`echo '\${PW}' | docker login -u '\${UN}' --password-stdin '\${TCR_REGISTRY}'\`, { stdio: 'inherit' });
  console.log(\`[push] docker push \${IMAGE}\`);
  execSync(\`docker push '\${IMAGE}'\`, { stdio: 'inherit' });
  console.log('[push] done');
  process.exit(0);
}

// ── personal edition ──
let U = CCR_USERNAME || '';
let P = SECRET_CCR_PASSWORD || CCR_PASSWORD || '';
const tcrHost = 'tcr.tencentcloudapi.com';

// auto-register
if (!U || !P) {
  console.log('[login] auto-register account via TCR API ...');
  const autoPw = createHash('md5').update(\`\${CLOUDBASE_UIN}_\${CLOUDBASE_ENV_ID}\`).digest('hex').slice(0, 16);
  const regPayload = JSON.stringify({ Password: autoPw });
  const { body: regBody } = await tc3Request(
    API_SECRET_ID, API_SECRET_KEY, API_TOKEN, 'tcr', tcrHost,
    'CreateUserPersonal', '2019-09-24', regPayload
  );
  console.log(\`[login] CreateUserPersonal: \${regBody.slice(0, 500)}\`);
  const regJson = JSON.parse(regBody);
  const regErr = regJson.Response?.Error;
  if (regErr) {
    if (regErr.Code === 'InvalidParameter.ErrUserExist') {
      console.log('[login] 账号已存在');
      U = CCR_USERNAME || CLOUDBASE_UIN;
      P = SECRET_CCR_PASSWORD || CCR_PASSWORD || '';
    } else {
      console.log('[login] 自动开通失败，回退 .env 密码');
      U = CCR_USERNAME || CLOUDBASE_UIN;
      P = SECRET_CCR_PASSWORD || CCR_PASSWORD || '';
    }
  } else {
    console.log('[login] ✓ 账号已自动开通');
    U = CLOUDBASE_UIN;
    P = autoPw;
    console.log('  首次使用，账号已自动开通');
    console.log(\`  UIN:  \${U}\`);
    console.log(\`  密码: \${P}\`);
    console.log('  请前往控制台修改密码: https://console.cloud.tencent.com/tcr');
  }
}

if (!U || !P) {
  console.log('登录失败：账号已存在，但未提供密码');
  console.log('请提供 UIN 和密码：magent sync-image --uin <UIN> --password <密码>');
  process.exit(1);
}

// ensure namespace
console.log(\`[login] ensure namespace: \${TCR_NAMESPACE}\`);
const nsPayload = JSON.stringify({ Namespace: TCR_NAMESPACE });
const { body: nsBody } = await tc3Request(
  API_SECRET_ID, API_SECRET_KEY, API_TOKEN, 'tcr', tcrHost,
  'CreateNamespacePersonal', '2019-09-24', nsPayload
);
const nsJson = JSON.parse(nsBody);
const nsErr = nsJson.Response?.Error;
if (nsErr) {
  const code = nsErr.Code || '';
  if (code === 'InvalidParameter.ErrNamespaceExist') {
    console.log(\`[login] namespace ready: \${TCR_NAMESPACE}\`);
  } else if (code === 'LimitExceeded.ErrNamespaceMaxLimit') {
    console.error('\\n命名空间数量已达上限。');
    console.error('  方案 1: 前往 https://console.cloud.tencent.com/tcr 清理旧命名空间，释放配额');
    console.error('  方案 2: 在 .env 中设置 TCR_NAMESPACE 复用已有的命名空间');
    process.exit(1);
  } else {
    console.error(\`⚠ 创建命名空间失败：\${code}\\n  错误信息: \${nsErr.Message || '未知'}\\n\`);
  }
} else {
  console.log(\`[login] namespace created: \${TCR_NAMESPACE}\`);
}

execSync(\`echo '\${P}' | docker login -u '\${U}' --password-stdin '\${TCR_REGISTRY}'\`, { stdio: 'inherit' });
console.log(\`[push] docker push \${IMAGE}\`);
execSync(\`docker push '\${IMAGE}'\`, { stdio: 'inherit' });
console.log('[push] done');
`,
};

// ═══════════ helpers ═══════════

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function question(line, defaultValue = "") {
  return new Promise((resolve) => {
    const r = rl();
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

  // Create zip in memory
  const tmp = execSync("mktemp -d").toString().trim();
  const zipPath = `${tmp}/bundle.zip`;
  const scriptDir = `${tmp}`;
  execSync(`mkdir -p ${scriptDir}`);
  for (const [name, content] of Object.entries(scripts)) {
    writeFileSync(`${scriptDir}/${name}`, content);
    if (name.endsWith(".mjs")) execSync(`chmod +x ${scriptDir}/${name}`);
  }
  execSync(`cd ${scriptDir} && zip -qr ${zipPath} . -i '*.mjs' -i 'Dockerfile.bootstrap'`);

  const zipBuf = readFileSync(zipPath);
  execSync(`rm -rf ${tmp}`);

  // Upload
  const curlArgs = ["curl", "-sS", "-X", "PUT", uploadUrl, "-H", "Content-Type: application/zip", "--data-binary", "@-", "-o", "/dev/null", "-w", "%{http_code}"];
  for (const h of headers) {
    if (h.Key && h.Value) curlArgs.push("-H", `${h.Key}: ${h.Value}`);
  }
  const cp = spawnSync("curl", curlArgs.slice(1), { input: zipBuf, encoding: "utf-8" });
  if (cp.stdout.trim() !== "200") throw new Error(`COS upload failed: ${cp.stdout.trim()}`);

  return ts;
}

export function registerSyncImageCommand(program) {
  program
    .command("sync-image")
    .description("将预构建镜像同步到您的容器镜像服务（TCR）")
    .option("-u, --uin <uin>", "腾讯云账号 UIN（默认自动检测）")
    .option("-p, --password <password>", "访问凭证密码（默认交互询问）")
    .option("-i, --images <list>", "镜像: sandbox,tcbr,scf,all（默认 all）")
    .option("-e, --env-id <id>", "TCB 环境 ID（默认自动检测）")
    .option("-n, --namespace <ns>", "命名空间（默认 tcb-<UIN>）")
    .option("--endpoint <url>", "仓库地址（默认 ccr.ccs.tencentyun.com）")
    .option("--baseline-tag <tag>", "固定版本 tag（默认 latest）")
    .option("--no-save", "不保存凭证到 .env")
    .action(handleSyncImage);
}

async function handleSyncImage(options) {
  const envId = options.envId || detectCurrentEnvId();
  if (!envId) {
    console.error(red("未检测到 TCB 环境。请先 tcb login && tcb env use <ID>"));
    process.exit(1);
  }
  console.log(`TCB 环境: ${bold(envId)}`);

  let uin = options.uin || process.env.TCR_UIN || "";
  let password = options.password || process.env.TCR_PASSWORD || "";
  const images = options.images || "all";
  const selectedImages = images === "all"
    ? Object.keys(IMAGES)
    : images.split(",").map(s => s.trim()).filter(k => IMAGES[k]);

  if (selectedImages.length === 0) {
    console.error(red("未选择任何镜像。可用: sandbox,tcbr,scf,all"));
    process.exit(1);
  }

  // Override tag if specified
  const baselineTag = options.baselineTag || "latest";

  const namespace = options.namespace || (uin ? `tcb-${uin}` : "tcb-user");
  const endpoint = options.endpoint || "ccr.ccs.tencentyun.com";
  const POLL_MS = 5000;
  const TIMEOUT_MS = 1200_000;
  const results = [];

  // Interactive mode
  if (!uin || !password) {
    console.log("");
    console.log(bold("交互模式 — 按回车使用默认值"));
    console.log("");

    // 选镜像（如果 CLI 未指定）
    if (!options.images || options.images === "all") {
      const imgChoice = await question(
        "选择镜像 [sandbox / tcbr / scf / all]",
        "all"
      );
      if (imgChoice !== "all") {
        const chosen = imgChoice.split(",").map(s => s.trim()).filter(k => IMAGES[k]);
        if (chosen.length > 0) selectedImages.length = 0, selectedImages.push(...chosen);
      }
    }

    const choice = await question(
      "登录方式 [1] 自动开通（未使用过） / [2] 已有访问凭证",
      "1"
    );
    if (choice === "2") {
      uin = uin || await question("腾讯云 UIN", uin || undefined);
      password = password || await promptPassword("访问凭证密码");
    } else {
      console.log(dim("  将自动开通个人版共享实例"));
    }

    // 确认
    console.log(`  镜像: ${selectedImages.map(k => IMAGES[k].name).join(" + ")}`);
    console.log(`  目标: ${endpoint}/${namespace}`);
    console.log(uin ? `  UIN:  ${uin}${password ? "（已有凭证）" : ""}` : "  登录: 自动开通");
    const confirm = await question("\n确认开始？[Y/n]", "Y");
    if (confirm !== "Y" && confirm !== "y") { console.log("已取消"); process.exit(0); }
    console.log("");
  } else {
    // CLI 参数模式 — 简要确认
    console.log(`  镜像: ${selectedImages.map(k => IMAGES[k].name).join(" + ")}`);
    console.log(`  目标: ${endpoint}/${namespace}`);
    if (uin) console.log(`  登录: ${uin}（已有凭证）`);
    console.log("");
  }

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
            { Key: "TCR_NAMESPACE", Value: namespace },
            { Key: "CCR_USERNAME", Value: uin },
          ],
          Secrets: password ? [{ Name: "CCR_PASSWORD", Value: password }] : [],
          CustomSteps: [
            { Name: "bootstrap-docker", Command: "docker build -f Dockerfile.bootstrap -t cloudapp-bootstrap:tmp ." },
            { Name: "pull-baseline", Command: "node ./pull-baseline.mjs" },
            { Name: "login-and-push", Command: "node ./tcr-sts-login.mjs" },
          ],
        },
      });
      const ver = resp.VersionName;
      console.log(`  VersionName: ${ver}`);

      // Poll until all steps complete
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

  // Final output
  if (results.length > 0) {
    console.log(bold("✓ 同步完成"));
    for (const r of results) {
      const label = r.scf ? "云函数" : r.key === "sandbox" ? "沙箱  " : "云托管";
      console.log(`  ${label}: ${r.image}`);
    }

    // Offer to save .env
    if (uin && password && !options.noSave) {
      const save = await question("\n保存配置到 .env？下次可直接 magent sync-image", "Y");
      if (save === "Y" || save === "y") {
        const envPath = resolve(process.cwd(), ".env");
        let content = "";
        if (existsSync(envPath)) content = readFileSync(envPath, "utf-8");
        if (!content.includes("TCR_UIN=")) content += `\nTCR_UIN=${uin}`;
        if (!content.includes("TCR_PASSWORD=")) content += `\nTCR_PASSWORD=${password}`;
        writeFileSync(envPath, content.trim() + "\n");
        console.log(green(`  已写入 ${envPath}`));

        // Ensure .gitignore
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
