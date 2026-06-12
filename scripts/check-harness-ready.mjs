#!/usr/bin/env node
/**
 * Customer-facing harness deploy preflight (no magent subcommand).
 *
 *   magent login && tcb env use <envId>
 *   export HARNESS_TOOL_ROLE_ARN=...   # only when check says tool missing
 *   node scripts/check-harness-ready.mjs
 */
import {
  formatHarnessPreflightReport,
  runHarnessDeployPreflight,
} from "../lib/harness-preflight.mjs";

const json = process.argv.includes("--json");

const result = await runHarnessDeployPreflight();

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(formatHarnessPreflightReport(result));
  console.log();
  console.log("可提前检查项：登录、环境 ID、TCB_REGION、AGS 沙箱工具是否已存在、");
  console.log("HARNESS_TOOL_ROLE_ARN 格式与 CAM 角色载体、COS/私有镜像策略提示。");
  console.log("无法提前保证：CreateSandboxTool 成功、镜像可拉取、AGS 配额。");
  console.log(`角色创建步骤：${result.context.envId ? "见 docs/harness-credentials.md" : "先 tcb env use"}`);
}

process.exit(result.ok ? 0 : 1);
