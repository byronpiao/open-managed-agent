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
import { readTcbLoginCredential } from "../credentials.mjs";
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

// ═══════════ CNB 脚本模板 ═══════════
const CNB_SCRIPTS = {
  "Dockerfile.bootstrap": `FROM alpine:3.19\nRUN echo "cloudapp-docker-bootstrap"\n`,
  "pull-baseline.sh": `#!/usr/bin/env bash
set -euo pipefail
: "\${TCR_REGISTRY:?}" "\${CLOUDBASE_SERVICE_NAME:?}" "\${CLOUDBASE_VERSION_NAME:?}" "\${BASELINE_IMAGE:?}"
TCR_NAMESPACE="\${TCR_NAMESPACE:-tcb-\${CLOUDBASE_UIN:-user}}"
TARGET="\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${CLOUDBASE_VERSION_NAME}"
echo "[ghcr] docker pull \${BASELINE_IMAGE}"
docker pull "\${BASELINE_IMAGE}"
echo "[tag] \${BASELINE_IMAGE} → \${TARGET}"
docker tag "\${BASELINE_IMAGE}" "\${TARGET}"
echo "[ok] pull + tag done"
`,
  "tcr-sts-login.sh": `#!/usr/bin/env bash
set -euo pipefail
: "\${TCR_REGISTRY:?}" "\${CLOUDBASE_SERVICE_NAME:?}" "\${CLOUDBASE_VERSION_NAME:?}"
TCR_NAMESPACE="\${TCR_NAMESPACE:-tcb-\${CLOUDBASE_UIN:-user}}"
IMAGE="\${TCR_REGISTRY}/\${TCR_NAMESPACE}/\${CLOUDBASE_SERVICE_NAME}:\${CLOUDBASE_VERSION_NAME}"
AUTO_PW=\$(printf '%s' "\${CLOUDBASE_UIN:-unknown}_\${CLOUDBASE_ENV_ID:-unknown}" | md5sum | cut -c1-16)

# ── auto-register ──
HOST="tcr.tencentcloudapi.com"
TS=\$(date +%s)
DATE=\$(date -u -d "@\${TS}" +"%Y-%m-%d" 2>/dev/null || date -u -r "\${TS}" +"%Y-%m-%d")
PAYLOAD=\$(printf '{"Password":"%s"}' "\$AUTO_PW")
HP=\$(printf '%s' "\$PAYLOAD" | openssl dgst -sha256 -hex | awk '{print \$NF}')
CH="content-type:application/json; charset=utf-8\\nhost:\${HOST}\\nx-tc-action:createuserpersonal\\n"
SH="content-type;host;x-tc-action"
CS="POST\\n/\\n\\n\${CH}\\n\${SH}\\n\${HP}"
CR="\${DATE}/tcr/tc3_request"
HCS=\$(printf "\${CS}" | openssl dgst -sha256 -hex | awk '{print \$NF}')
STS2="TC3-HMAC-SHA256\\n\${TS}\\n\${CR}\\n\${HCS}"
SD=\$(printf '%s' "\${DATE}" | openssl dgst -sha256 -hmac "TC3\${API_SECRET_KEY}" -hex | awk '{print \$NF}')
SV=\$(printf '%s' "tcr" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"\${SD}" -hex | awk '{print \$NF}')
SS=\$(printf '%s' "tc3_request" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"\${SV}" -hex | awk '{print \$NF}')
SIG=\$(printf "\${STS2}" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"\${SS}" -hex | awk '{print \$NF}')
AUTH="TC3-HMAC-SHA256 Credential=\${API_SECRET_ID}/\${CR}, SignedHeaders=\${SH}, Signature=\${SIG}"

REG_RESULT=\$(curl -sS -X POST "https://\${HOST}" \\
  -H "Authorization: \${AUTH}" -H "Content-Type: application/json; charset=utf-8" \\
  -H "Host: \${HOST}" -H "X-TC-Action: CreateUserPersonal" \\
  -H "X-TC-Timestamp: \${TS}" -H "X-TC-Version: 2019-09-24" \\
  -H "X-TC-Token: \${API_TOKEN}" --data "\$PAYLOAD" 2>&1)

if echo "\$REG_RESULT" | grep -q 'ErrUserExist'; then
  echo "[login] 账号已存在"
  U="\${CCR_USERNAME:-\${CLOUDBASE_UIN}}"
  P="\${SECRET_CCR_PASSWORD:-\${CCR_PASSWORD:-}}"
elif echo "\$REG_RESULT" | grep -qv '"Error"'; then
  echo "[login] ✓ 账号已自动开通"
  U="\${CLOUDBASE_UIN}"
  P="\$AUTO_PW"
  echo "  首次使用，账号已自动开通"
  echo "  UIN:  \$U"
  echo "  密码: \$P"
  echo "  请前往控制台修改密码: https://console.cloud.tencent.com/tcr"
else
  U="\${CCR_USERNAME:-\${CLOUDBASE_UIN}}"
  P="\${SECRET_CCR_PASSWORD:-\${CCR_PASSWORD:-}}"
fi

if [ -z "\$U" ] || [ -z "\$P" ]; then
  echo "登录失败：账号已存在，但未提供密码"
  echo "请提供 UIN 和密码：magent sync-image --uin <UIN> --password <密码>"
  exit 1
fi

# ── ensure namespace ──
NS="\${TCR_NAMESPACE}"
NS_PAYLOAD='{"Namespace":"'"\${NS}"'"}'
NSRES=\$(curl -sS -X POST "https://\${HOST}" \\
  -H "Authorization: \${AUTH}" -H "Content-Type: application/json; charset=utf-8" \\
  -H "Host: \${HOST}" -H "X-TC-Action: CreateNamespacePersonal" \\
  -H "X-TC-Timestamp: \${TS}" -H "X-TC-Version: 2019-09-24" \\
  -H "X-TC-Token: \${API_TOKEN}" --data "\$NS_PAYLOAD" 2>&1)
echo "[login] namespace: \${NS}"

printf '%s' "\$P" | docker login -u "\$U" --password-stdin "\${TCR_REGISTRY}"
echo "[push] docker push \${IMAGE}"
docker push "\${IMAGE}"
echo "[push] done"
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
        if (name.endsWith(".sh")) execSync(`chmod +x ${scriptDir}/${name}`);
      }
      execSync(`cd ${scriptDir} && zip -qr ${zipPath} . -i '*.sh' -i 'Dockerfile.bootstrap'`);

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
    .option("-u, --uin <uin>", "腾讯云账号 UIN")
    .option("-p, --password <password>", "访问凭证密码")
    .option("-n, --namespace <ns>", "命名空间（默认 tcb-<UIN>）")
    .option("-i, --images <list>", "镜像: sandbox,tcbr,scf,all（默认）")
    .option("-e, --env-id <id>", "TCB 环境 ID（默认自动检测）")
    .option("--endpoint <url>", "仓库地址（默认 ccr.ccs.tencentyun.com）")
    .option("--image-name <name>", "镜像名（默认不同镜像有不同名）")
    .option("--baseline-tag <tag>", "固定版本 tag（默认 latest）")
    .option("--no-save", "不保存到 .env")
    .option("--poll-interval <sec>", "轮询间隔秒数（默认 5）")
    .option("--timeout <sec>", "超时秒数（默认 1800）")
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

  // Interactive mode
  if (!uin || !password) {
    console.log("");
    const choice = await question("容器镜像服务登录方式？[1] 自动开通 [2] 已有凭证", "1");
    if (choice === "2") {
      uin = uin || await question("腾讯云 UIN（控制台右上角→账号信息）");
      password = password || await promptPassword("访问凭证密码");
    }
  }

  const namespace = options.namespace || (uin ? `tcb-${uin}` : "tcb-user");
  const endpoint = options.endpoint || "ccr.ccs.tencentyun.com";
  const pollInterval = (parseInt(options.pollInterval) || 5) * 1000;
  const timeout = (parseInt(options.timeout) || 1800) * 1000;

  console.log("");
  console.log("确认信息：");
  console.log(`  镜像: ${selectedImages.map(k => IMAGES[k].name).join(" + ")}`);
  console.log(`  目标: ${endpoint}/${namespace}`);
  if (uin) console.log(`  登录: ${uin}${password ? "（已有凭证）" : "（自动开通）"}`);
  console.log("");
  const confirm = await question("确认开始？[Y/n]", "Y");
  if (confirm !== "Y" && confirm !== "y") { console.log("已取消"); process.exit(0); }

  console.log("");

  const results = [];
  for (const key of selectedImages) {
    const img = { ...IMAGES[key] };
    if (baselineTag !== "latest") {
      img.baseline = img.baseline.replace(/:latest$/, `:${baselineTag}`);
    }
    if (options.imageName) {
      img.imageName = options.imageName;
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
            { Name: "pull-baseline", Command: "bash ./pull-baseline.sh" },
            { Name: "login-and-push", Command: "bash ./tcr-sts-login.sh" },
          ],
        },
      });
      const ver = resp.VersionName;
      console.log(`  VersionName: ${ver}`);

      // Poll
      let done = false;
      let lastSteps = "";
      while (!done) {
        await new Promise(r => setTimeout(r, pollInterval));
        const data = await callTcbCloudApi({
          action: "DescribeCloudAppVersion",
          payload: { EnvId: envId, ServiceName: img.imageName, VersionName: ver, DeployType: "custom" },
        });
        const s = data.Status ?? data.VersionStatus ?? "UNKNOWN";
        const curSteps = (data.Steps ?? []).map(st => `${st.Name}/${st.Status}`).join(" ");
        if (curSteps !== lastSteps) {
          console.log(`  ${(data.Steps ?? []).map(st => `${st.Name}:${st.Status}[${st.Duration ?? ""}]`).join(" ")}`);
          lastSteps = curSteps;
        }
        if (s === "SUCCESS" || s === "Success" || s === "success") {
          done = true;
          const fullImage = `${endpoint}/${namespace}/${img.imageName}:${ver}`;
          results.push({ key, name: img.name, image: fullImage, scf: img.scf });
          console.log(green(`  ✓ ${fullImage}`));
        } else if (s === "FAILED" || s === "Failed" || s === "failed") {
          console.error(red(`  ✗ 构建失败`));
          // Try to fetch logs
          try {
            const bid = data.BuildId;
            if (bid) {
              const logResp = await callTcbCloudApi({
                action: "DescribeCloudBaseRunBuildLog",
                payload: { EnvId: envId, ServiceName: img.imageName, ServiceVersion: ver, BuildId: Number(bid), Start: 1 },
              });
              const logText = logResp?.Log?.Text ?? "";
              if (logText) {
                // Find last section
                const lines = logText.split("\n");
                const lastDash = lines.map((l, i) => l.match(/^-+ .+ -+$/) ? i : -1).filter(i => i >= 0).pop();
                if (lastDash >= 0) {
                  console.error(dim(lines.slice(lastDash, lastDash + 20).join("\n")));
                }
              }
            }
          } catch {}
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
