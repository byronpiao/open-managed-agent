/**
 * Harness deploy preflight — shared by `magent agent:create` and scripts/check-harness-ready.mjs.
 */
import { spawnSync } from "child_process";

import { readTcbLoginCredential } from "./credentials.mjs";
import { callTcbCloudApi } from "./api.mjs";
import { hydrateCloudEnvFromCli, detectCurrentEnvId } from "./env.mjs";
import {
  expectedHarnessToolName,
  harnessCosEnabledFromMap,
  pinnedHarnessToolId,
  loadHarnessEnvIntoProcess,
  readHarnessEnvMap,
  clearShellLeakedHarnessPins,
} from "./harness-env-file.mjs";
import { getNodeExecutable, getTcbScript } from "./tcb.mjs";

export const ROLE_ARN_GUIDE = "docs/harness-credentials.md#控制台逐步操作照填";

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
    { encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    const msg = (res.stderr || res.stdout || "tcb sandbox tool list failed").trim();
    throw new Error(msg.slice(0, 400));
  }
  return parseTcbJsonOutput(res.stdout)?.data?.SandboxToolSet ?? [];
}

function decodeAssumeRolePolicy(doc) {
  if (!doc) return "";
  if (typeof doc === "string") {
    try {
      return decodeURIComponent(doc.replace(/\+/g, " "));
    } catch {
      return doc;
    }
  }
  return JSON.stringify(doc);
}

/** @returns {Promise<{ ok: boolean, roleName?: string, trustsAgs?: boolean, arn?: string, reason?: string }>} */
export async function verifyCamRoleForAgs(roleArn) {
  const parsed = parseHarnessRoleArn(roleArn);
  if (!parsed) return { ok: false, reason: "invalid ARN format" };

  try {
    const resp = await callTcbCloudApi({
      action: "GetRole",
      service: "cam",
      version: "2019-01-16",
      payload: { RoleName: parsed.roleName },
    });
    const policyStr = decodeAssumeRolePolicy(resp?.RoleInfo?.AssumeRolePolicyDocument);
    if (!policyStr) return { ok: false, reason: "role not found" };
    return {
      ok: true,
      roleName: parsed.roleName,
      trustsAgs: /ags\.cloud\.tencent\.com/i.test(policyStr),
      arn: resp?.RoleInfo?.Arn ?? roleArn,
    };
  } catch (err) {
    return { ok: false, reason: (err.message ?? String(err)).slice(0, 240) };
  }
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

/**
 * @param {{ envId?: string, cosEnabled?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, blockers: string[], warnings: string[], hints: string[], context: Record<string, unknown> }>}
 */
export async function runHarnessDeployPreflight(opts = {}) {
  loadHarnessEnvIntoProcess();
  clearShellLeakedHarnessPins();

  const blockers = [];
  const warnings = [];
  const hints = [];

  const hydrated = hydrateCloudEnvFromCli({ envId: opts.envId });
  const envId = opts.envId?.trim() || hydrated.envId || detectCurrentEnvId() || "";
  const envMap = readHarnessEnvMap();
  const cosEnabled = opts.cosEnabled ?? harnessCosEnabledFromMap(envMap);
  const expectedToolName = envId ? expectedHarnessToolName(envId, cosEnabled, envMap) : "";
  const pinnedId = pinnedHarnessToolId();
  const roleArn = resolveRoleArn(envMap);

  if (!hasCloudCredentials()) {
    blockers.push("未登录 CloudBase：先运行 magent login（或 export TCB_SECRET_ID / TCB_SECRET_KEY）");
  }
  if (!envId) {
    blockers.push("未选择环境：运行 tcb env use <envId>，或 export CLOUDBASE_ENV_ID / 传 -e");
  }
  if (!hydrated.region && !process.env.TCB_REGION?.trim()) {
    warnings.push(
      "TCB_REGION 未解析 — 会话持久化可能不可用（见 docs/harness-env.md#advanced-settings）",
    );
  }

  let tools = [];
  let matchedTool = null;

  if (envId && hasCloudCredentials()) {
    try {
      tools = listSandboxTools();
      if (pinnedId) {
        matchedTool = tools.find((t) => t.ToolId === pinnedId) ?? null;
        if (!matchedTool) {
          blockers.push(`HARNESS_TOOL_ID=${pinnedId} 在当前账号下找不到对应沙箱工具`);
        }
      } else {
        matchedTool = tools.find((t) => t.ToolName === expectedToolName) ?? null;
      }
    } catch (err) {
      warnings.push(
        `无法调用 AGS 列出沙箱工具（${err.message}）— 请确认已开通 Agent 沙箱、当前账号有权限`,
      );
    }
  }

  if (matchedTool) {
    hints.push(
      `已找到沙箱工具「${matchedTool.ToolName}」（${matchedTool.ToolId}）— 无需 HARNESS_TOOL_ROLE_ARN`,
    );
  } else if (!pinnedId) {
    if (!roleArn) {
      blockers.push(
        `本环境还没有沙箱工具「${expectedToolName}」。首次部署前必须配置 HARNESS_TOOL_ROLE_ARN（见 ${ROLE_ARN_GUIDE}）`,
      );
      const sampleArn = tools.map((t) => t.RoleArn).find(Boolean);
      if (sampleArn) {
        hints.push(`账号下已有其它沙箱工具，可复用其 RoleArn：export HARNESS_TOOL_ROLE_ARN='${sampleArn}'`);
      } else {
        hints.push("按文档在 CAM 控制台创建「Agent 沙箱服务」产品角色后，export HARNESS_TOOL_ROLE_ARN=...");
      }
      hints.push("部署前自检：node scripts/check-harness-ready.mjs");
    } else {
      const parsed = parseHarnessRoleArn(roleArn);
      if (!parsed) {
        blockers.push("HARNESS_TOOL_ROLE_ARN 格式无效，应为 qcs::cam::uin/<uin>:roleName/<name>");
      } else {
        const roleCheck = await verifyCamRoleForAgs(roleArn);
        if (!roleCheck.ok) {
          warnings.push(`无法通过 CAM 验证角色「${parsed.roleName}」（${roleCheck.reason}）`);
        } else if (!roleCheck.trustsAgs) {
          blockers.push(
            `角色「${parsed.roleName}」载体不是 Agent 沙箱服务 (ags.cloud.tencent.com)，请按 ${ROLE_ARN_GUIDE} 重建`,
          );
        }
        if (cosEnabled) {
          hints.push("已启用 COS：请确认该角色已关联 QcloudCOSFullAccess（或桶级自定义策略）");
        }
        const customImage = process.env.HARNESS_SANDBOX_IMAGE?.trim();
        if (customImage && !customImage.includes("tcb-sandbox-public")) {
          hints.push("使用私有 TCR/CCR 镜像：请确认角色已关联 QcloudTCRReadOnlyAccess");
        }
      }
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    hints,
    context: {
      envId,
      expectedToolName,
      toolFound: Boolean(matchedTool),
      toolCount: tools.length,
      roleArnSet: Boolean(roleArn),
      cosEnabled,
    },
  };
}

export function formatHarnessPreflightReport(result) {
  const lines = [];
  if (result.ok) {
    lines.push(`✓ Harness 部署前置检查通过（env=${result.context.envId}）`);
  } else {
    lines.push("✗ Harness 部署前置检查未通过");
  }
  for (const b of result.blockers) lines.push(`  ✗ ${b}`);
  for (const w of result.warnings) lines.push(`  ⚠ ${w}`);
  for (const h of result.hints) lines.push(`  → ${h}`);
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
