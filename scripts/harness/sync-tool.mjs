#!/usr/bin/env node
/**
 * Update a pinned HARNESS_TOOL_ID to HARNESS_SANDBOX_IMAGE (optional).
 * Default flow auto-creates harness-{envId} — only run when HARNESS_TOOL_ID is set.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

loadEnv();

const image =
  process.env.HARNESS_SANDBOX_IMAGE;
const toolId = process.env.HARNESS_TOOL_ID?.trim();

if (!image) {
  console.error("Missing HARNESS_SANDBOX_IMAGE");
  process.exit(1);
}
if (!toolId) {
  console.error(
    "HARNESS_TOOL_ID not set — orchestrator auto-ensures oma-harness-{env}-no-cos|with-cos. " +
      "Set HARNESS_TOOL_ID in .env.harness only when pinning an existing tool.",
  );
  process.exit(1);
}

const listRaw = execSync("tcb sandbox tool list --json", {
  encoding: "utf-8",
  maxBuffer: 20 * 1024 * 1024,
});
const listJson = JSON.parse(listRaw.slice(listRaw.indexOf("{")));
const tools = listJson.data?.SandboxToolSet ?? [];
const tool = tools.find((t) => t.ToolId === toolId);
if (!tool) {
  console.error(`Tool not found: ${toolId}`);
  process.exit(1);
}

const cfg = { ...tool.CustomConfiguration, Image: image, ImageRegistryType: "personal" };
delete cfg.ImageDigest;

const cfgPath = "/tmp/oma-harness-tool-custom-configuration.json";
writeFileSync(cfgPath, JSON.stringify(cfg));

console.log(`Updating ${toolId} → ${image}`);
execSync(`tcb sandbox tool update ${toolId} --custom-configuration "$(cat ${cfgPath})"`, {
  stdio: "inherit",
  shell: "/bin/bash",
});
console.log("Done. Wait ~120s after tool update before instance start (AGS image pull).");
