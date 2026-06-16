/**
 * Harness deploy preflight — shared by `magent agent:create` and scripts/check-harness-ready.mjs.
 */
import { spawnSync } from "child_process";

import { readTcbLoginCredential } from "./credentials.mjs";
import { hydrateCloudEnvFromCli, detectCurrentEnvId } from "./env.mjs";
import {
  expectedHarnessToolName,
  pinnedHarnessToolId,
  readHarnessEnvMap,
  clearShellLeakedHarnessPins,
} from "./harness-env-file.mjs";
import { getNodeExecutable, getTcbScript } from "./tcb.mjs";
import { resolveSandboxImageFromYaml } from "./resolve-harness-sandbox-image.mjs";

export const ROLE_ARN_GUIDE = "docs/harness-credentials.md#控制台逐步操作照填";

/** @typedef {'required' | 'optional' | 'first_tool'} HarnessCheckTier */
/** @typedef {'ok' | 'fail' | 'warn' | 'skip'} HarnessCheckStatus */
/** @typedef {{ key: string, label: string, tier: HarnessCheckTier, status: HarnessCheckStatus, detail: string, fix?: string }} HarnessPreflightCheck */

/** @returns {{ uin: string, roleName: string } | null} */
export function parseHarnessRoleArn(arn) {
  const m = /^qcs::cam::uin\/(\d+):roleName\/(.+)$/.exec(arn?.trim() ?? "");
  if (!m) return null;
  return { uin: m[1], roleName: m[2] };
}

function parseTcbJsonOutput(raw) {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("tcb output contained no JSON");
  return JSON.parse(raw.slice(start));
}

export function listSandboxTools() {
  const res = spawnSync(
    getNodeExecutable(),
    [getTcbScript(), "sandbox", "tool", "list", "--json"],
    {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "tcb sandbox tool list failed").trim();
    throw new Error(msg.slice(0, 400));
  }
  return parseTcbJsonOutput(res.stdout)?.data?.SandboxToolSet ?? [];
}

function resolveRoleArn(envMap) {
  return (
    process.env.HARNESS_TOOL_ROLE_ARN?.trim() ??
    envMap.get("HARNESS_TOOL_ROLE_ARN")?.trim() ??
    ""
  );
}

function hasCloudCredentials() {
  if (process.env.TCB_SECRET_ID?.trim() && process.env.TCB_SECRET_KEY?.trim()) return true;
  return Boolean(readTcbLoginCredential());
}

function harnessCosEnabledFromProcessEnv() {
  const v = process.env.HARNESS_COS_ENABLED?.trim().toLowerCase() ?? "";
  return v === "1" || v === "true" || v === "yes";
}

const COS_ENV_KEYS = [
  "HARNESS_COS_BUCKET",
  "HARNESS_COS_BUCKET_PATH",
  "HARNESS_COS_ENDPOINT",
  "HARNESS_COS_REGION",
  "HARNESS_COS_MOUNT_NAME",
  "HARNESS_COS_MOUNT_DIR",
];

function tierLabel(tier) {
  if (tier === "required") return "必选";
  if (tier === "first_tool") return "首次创工具";
  return "可选";
}

function statusMark(status) {
  if (status === "ok") return "✓";
  if (status === "fail") return "✗";
  if (status === "warn") return "!";
  return "—";
}

/**
 * @param {{ envId?: string, cosEnabled?: boolean }} [opts]
 */
export async function runHarnessDeployPreflight(opts = {}) {
  clearShellLeakedHarnessPins();

  /** @type {HarnessPreflightCheck[]} */
  const checks = [];
  const blockers = [];
  const warnings = [];

  const hydrated = hydrateCloudEnvFromCli({ envId: opts.envId });
  const envId = opts.envId?.trim() || hydrated.envId || detectCurrentEnvId() || "";
  const envMap = readHarnessEnvMap();
  const cosEnabled = opts.cosEnabled ?? harnessCosEnabledFromProcessEnv();
  const expectedToolName = envId ? expectedHarnessToolName(envId, cosEnabled, envMap) : "";
  const pinnedId = pinnedHarnessToolId();
  const roleArn = resolveRoleArn(envMap);
  const region = process.env.TCB_REGION?.trim() || hydrated.region || "";

  const loggedIn = hasCloudCredentials();
  checks.push({
    key: "login",
    label: "CloudBase 登录",
    tier: "required",
    status: loggedIn ? "ok" : "fail",
    detail: loggedIn ? "magent login" : "未登录",
    fix: loggedIn ? undefined : "magent login",
  });
  if (!loggedIn) blockers.push("未登录：magent login");

  checks.push({
    key: "env",
    label: "环境 ID",
    tier: "required",
    status: envId ? "ok" : "fail",
    detail: envId || "未选择",
    fix: envId ? undefined : "tcb env use <envId>",
  });
  if (!envId) blockers.push("未选择环境：tcb env use <envId>");

  checks.push({
    key: "region",
    label: "TCB_REGION",
    tier: "required",
    status: region ? "ok" : "warn",
    detail: region || "未解析",
    fix: region ? undefined : "tcb env use <envId> 或 export TCB_REGION",
  });
  if (!region) {
    warnings.push("TCB_REGION 未设置");
  }

  let tools = [];
  let matchedTool = null;
  let agsListError = "";

  if (envId && loggedIn) {
    try {
      tools = listSandboxTools();
      if (pinnedId) {
        matchedTool = tools.find((t) => t.ToolId === pinnedId) ?? null;
        if (!matchedTool) {
          blockers.push(`HARNESS_TOOL_ID=${pinnedId} 不存在`);
        }
        checks.push({
          key: "tool_pin",
          label: "HARNESS_TOOL_ID",
          tier: "optional",
          status: matchedTool ? "ok" : "fail",
          detail: matchedTool ? `${matchedTool.ToolName} (${pinnedId})` : pinnedId,
          fix: matchedTool ? undefined : "核对 .env.harness 中的 ToolId",
        });
      } else {
        matchedTool = tools.find((t) => t.ToolName === expectedToolName) ?? null;
      }
    } catch (err) {
      agsListError = (err.message ?? String(err)).slice(0, 120);
      warnings.push(`AGS 列表失败：${agsListError}`);
    }
  }

  const parsedRoleArn = roleArn ? parseHarnessRoleArn(roleArn) : null;
  const roleReady = Boolean(parsedRoleArn);

  if (pinnedId && matchedTool) {
    // tool row omitted — pin row covers it
  } else {
    let toolStatus = /** @type {HarnessCheckStatus} */ ("fail");
    let toolDetail = `无 ${expectedToolName || "oma-harness-<env>"}`;
    if (agsListError) {
      toolStatus = "warn";
      toolDetail = `列表失败：${agsListError}`;
    } else if (matchedTool) {
      toolStatus = "ok";
      toolDetail = matchedTool.ToolName;
    } else if (roleReady) {
      toolStatus = "ok";
      toolDetail = `无（已配 RoleArn，首次 run 自动创建）`;
    }

    checks.push({
      key: "ags_tool",
      label: "AGS 沙箱工具",
      tier: "required",
      status: toolStatus,
      detail: toolDetail,
      fix:
        agsListError
          ? "确认已开通 Agent 沙箱"
          : matchedTool || roleReady
            ? undefined
            : ROLE_ARN_GUIDE,
    });
    if (!agsListError && !matchedTool && !roleReady) {
      blockers.push(`缺少沙箱工具且未配置 HARNESS_TOOL_ROLE_ARN`);
    }
  }

  if (matchedTool) {
    checks.push({
      key: "role_arn",
      label: "HARNESS_TOOL_ROLE_ARN",
      tier: "first_tool",
      status: "skip",
      detail: "已有工具，不需要",
    });
  } else if (!pinnedId || !matchedTool) {
    checks.push({
      key: "role_arn",
      label: "HARNESS_TOOL_ROLE_ARN",
      tier: "first_tool",
      status: !roleArn ? "fail" : roleReady ? "ok" : "fail",
      detail: !roleArn ? "未设置" : roleReady ? parsedRoleArn.roleName : "格式错误",
      fix: !roleArn || !roleReady ? ROLE_ARN_GUIDE : undefined,
    });
    if (!roleArn) {
      blockers.push("缺少 HARNESS_TOOL_ROLE_ARN");
    } else if (!roleReady) {
      blockers.push("HARNESS_TOOL_ROLE_ARN 格式无效");
    }
  }

  if (cosEnabled) {
    const missingCos = COS_ENV_KEYS.filter((k) => !process.env[k]?.trim());
    checks.push({
      key: "cos",
      label: "COS 工作区",
      tier: "optional",
      status: missingCos.length ? "fail" : "ok",
      detail: missingCos.length ? `缺 ${missingCos.join(", ")}` : "已配置",
      fix: missingCos.length ? "见 harness-credentials.md（Role 须含 COS 写权限）" : undefined,
    });
    if (missingCos.length) {
      blockers.push(`COS 环境变量不完整：${missingCos.join(", ")}`);
    } else {
      checks.push({
        key: "cos_role",
        label: "Role COS 写权限",
        tier: "optional",
        status: roleArn || matchedTool ? "ok" : "warn",
        detail: "启用快照须 QcloudCOSFullAccess 或桶级策略",
      });
    }
  }

  const customImage = resolveSandboxImageFromYaml();
  if (customImage && !customImage.includes("tcb-sandbox-public")) {
    checks.push({
      key: "private_image",
      label: "私有镜像 Role",
      tier: "optional",
      status: "ok",
      detail: "Role 须含 QcloudTCRReadOnlyAccess",
    });
  }

  return {
    ok: blockers.length === 0,
    checks,
    blockers,
    warnings,
    hints: [],
    context: {
      envId,
      region,
      expectedToolName,
      toolFound: Boolean(matchedTool),
      toolId: matchedTool?.ToolId,
      toolCount: tools.length,
      roleArnSet: Boolean(roleArn),
      cosEnabled,
    },
  };
}

export function formatHarnessPreflightReport(result, { compact = false } = {}) {
  const envId = result.context?.envId || "";
  const lines = [];
  lines.push(`Harness 部署检查${envId ? `  env=${envId}` : ""}`);
  lines.push("");

  const colStatus = 4;
  const colTier = 10;
  const colLabel = 22;
  lines.push(
    `${"状态".padEnd(colStatus)}${"级别".padEnd(colTier)}${"检查项".padEnd(colLabel)}结果`,
  );
  lines.push(`${"-".repeat(colStatus)}${"-".repeat(colTier)}${"-".repeat(colLabel)}${"-".repeat(24)}`);

  for (const c of result.checks ?? []) {
    const mark = statusMark(c.status);
    const tier = tierLabel(c.tier);
    lines.push(
      `${mark.padEnd(colStatus)}${tier.padEnd(colTier)}${c.label.padEnd(colLabel)}${c.detail}`,
    );
    if (!compact && c.fix && (c.status === "fail" || c.status === "warn")) {
      lines.push(`${"".padEnd(colStatus + colTier + colLabel)}→ ${c.fix}`);
    }
  }

  lines.push("");
  if (result.ok) {
    lines.push("✓ 可以执行  magent agent:create --runtime harness");
  } else {
    lines.push("✗ 请先补齐表中 ✗ 项");
    const firstFix = result.checks?.find((c) => c.status === "fail" && c.fix)?.fix;
    if (firstFix && !compact) lines.push(`  ${firstFix}`);
  }
  return lines.join("\n");
}

export async function assertHarnessDeployPreflight(opts = {}) {
  const result = await runHarnessDeployPreflight(opts);
  if (!result.ok) {
    const err = new Error(formatHarnessPreflightReport(result));
    err.harnessPreflight = result;
    throw err;
  }
  return result;
}
