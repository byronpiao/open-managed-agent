#!/usr/bin/env node
/**
 * Update AGS sandbox tool image to the harness pinned sandbox image
 * (agent.harness.yaml sandbox.image, else HARNESS_PUBLIC_MAGENT_IMAGE).
 * When `.env.harness` has HARNESS_COS_ENABLED=1, also syncs StorageMounts.
 */
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
  expectedHarnessToolName,
  harnessCosEnabledFromMap,
  pinnedHarnessToolId,
  readHarnessEnvMap,
} from "../../lib/harness-env-file.mjs";
import { resolveHarnessOperationalSandboxImage } from "../../lib/resolve-harness-sandbox-image.mjs";
import { loadEnv, applyHarnessCosFromHarnessFile } from "./load-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

loadEnv();

const image = await resolveHarnessOperationalSandboxImage(repoRoot);

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
const hasCosMounts = (tool.StorageMounts ?? []).length > 0;
const needsCosMounts = cosEnabled && !hasCosMounts;
if (currentTag === nextTag && !needsCosMounts) {
  console.log(`Tool ${tool.ToolId} (${tool.ToolName}) already on tag ${nextTag} — skip`);
  process.exit(0);
}

if (cosEnabled) {
  applyHarnessCosFromHarnessFile();
}

const { syncHarnessAgsTool } = await import(
  "../../packages/agent-runtime/dist/harness/sandbox/orchestrator.js"
);

console.log(`Updating ${tool.ToolId} (${tool.ToolName}) → ${image}`);
await syncHarnessAgsTool({
  envId,
  toolId: tool.ToolId,
  image,
});
console.log("Done. Wait ~120s after tool update before instance start (AGS image pull).");
