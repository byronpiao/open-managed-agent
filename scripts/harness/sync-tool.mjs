#!/usr/bin/env node
/**
 * Update AGS sandbox tool image to HARNESS_SANDBOX_IMAGE.
 * Resolves tool by HARNESS_TOOL_ID (`.env.harness` only) or by oma-harness-{env}-* name.
 */
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  expectedHarnessToolName,
  harnessCosEnabledFromMap,
  pinnedHarnessToolId,
  readHarnessEnvMap,
} from "../../lib/harness-env-file.mjs";
import { loadEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

loadEnv();

const image = process.env.HARNESS_SANDBOX_IMAGE?.trim();
if (!image) {
  console.error("Missing HARNESS_SANDBOX_IMAGE");
  process.exit(1);
}

const envMap = readHarnessEnvMap();
const envId = process.env.CLOUDBASE_ENV_ID?.trim() || envMap.get("CLOUDBASE_ENV_ID")?.trim();
if (!envId) {
  console.error("Missing CLOUDBASE_ENV_ID");
  process.exit(1);
}

const cosEnabled = harnessCosEnabledFromMap(envMap);
const toolName = expectedHarnessToolName(envId, cosEnabled);
const pinnedId = pinnedHarnessToolId();

const listRaw = execSync("tcb sandbox tool list --json", {
  encoding: "utf-8",
  maxBuffer: 20 * 1024 * 1024,
});
const listJson = JSON.parse(listRaw.slice(listRaw.indexOf("{")));
const tools = listJson.data?.SandboxToolSet ?? [];

let tool = pinnedId ? tools.find((t) => t.ToolId === pinnedId) : undefined;
if (!tool) {
  tool = tools.find((t) => t.ToolName === toolName);
}
if (!tool) {
  console.error(
    pinnedId
      ? `Tool not found: ${pinnedId}`
      : `No tool named ${toolName} — orchestrator will CreateSandboxTool on next session`,
  );
  process.exit(pinnedId ? 1 : 0);
}

const currentTag = tool.CustomConfiguration?.Image?.split(":").pop();
const nextTag = image.split(":").pop();
if (currentTag === nextTag) {
  console.log(`Tool ${tool.ToolId} (${tool.ToolName}) already on tag ${nextTag} — skip`);
  process.exit(0);
}

const cfg = { ...tool.CustomConfiguration, Image: image, ImageRegistryType: "personal" };
delete cfg.ImageDigest;

const cfgPath = "/tmp/oma-harness-tool-custom-configuration.json";
writeFileSync(cfgPath, JSON.stringify(cfg));

console.log(`Updating ${tool.ToolId} (${tool.ToolName}) → ${image}`);
execSync(`tcb sandbox tool update ${tool.ToolId} --custom-configuration "$(cat ${cfgPath})"`, {
  stdio: "inherit",
  shell: "/bin/bash",
});
console.log("Done. Wait ~120s after tool update before instance start (AGS image pull).");
