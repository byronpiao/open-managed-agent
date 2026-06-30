// ── Environment ID resolution ─────────────────────────────────────────────────
// Auto-detects the current CloudBase environment ID via `tcb env use --json`.
// Falls back to -e flag or CLOUDBASE_ENV_ID env var.

import { createInterface } from "node:readline";
import { runTcb } from "./tcb.mjs";
import { red, dim, bold, cyan } from "./ui.mjs";

/** Try to detect the currently selected envId via tcb CLI. */
export function detectCurrentEnvId() {
  try {
    const raw = runTcb(["env", "use", "--json"], { allowFail: true, timeout: 10000 });
    const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return data?.data?.currentEnvId ?? "";
  } catch {
    return "";
  }
}

/** Region for the given env (or current `tcb env use` target). */
export function detectEnvRegion(envId) {
  const id = envId?.trim() || detectCurrentEnvId();
  if (!id) return "";
  try {
    const raw = runTcb(
      ["env", "detail", "-e", id, "--json", "--yes"],
      { allowFail: true, timeout: 15000 },
    );
    const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return data?.data?.region ?? "";
  } catch {
    return "";
  }
}

/**
 * Fill CLOUDBASE_ENV_ID / TCB_REGION from tcb CLI when unset.
 * Values already in process.env (file / shell) are left unchanged.
 */
export function hydrateCloudEnvFromCli({ envId } = {}) {
  const id = (envId?.trim() || process.env.CLOUDBASE_ENV_ID?.trim() || detectCurrentEnvId());
  if (id && !process.env.CLOUDBASE_ENV_ID?.trim()) {
    process.env.CLOUDBASE_ENV_ID = id;
  }
  const resolvedId = process.env.CLOUDBASE_ENV_ID?.trim() || id;
  if (!process.env.TCB_REGION?.trim() && resolvedId) {
    const region = detectEnvRegion(resolvedId);
    if (region) process.env.TCB_REGION = region;
  }
  return {
    envId: process.env.CLOUDBASE_ENV_ID?.trim() || "",
    region: process.env.TCB_REGION?.trim() || "",
  };
}

/** List all CloudBase envs via tcb env list --json. Returns array of { envId, alias }. */
export function listTcbEnvs() {
  try {
    const raw = runTcb(["env", "list", "--json"], { allowFail: true, timeout: 15000 });
    const data = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return (data?.data ?? []).filter(e => e.envId);
  } catch {
    return [];
  }
}

/**
 * 3-tier env resolution with interactive fallback:
 *   1. envIdFromCli arg (CLI flag or env var)
 *   2. `tcb env use` global default
 *   3. Only 1 env → auto-select; multiple → interactive (requires TTY); 0 → exit
 *
 * Sets `tcb env use` after interactive selection so it sticks next time.
 */
export async function detectOrSelectEnvId(envIdFromCli = "") {
  if (envIdFromCli) return envIdFromCli;

  // tier 1: tcb env use global default
  const current = detectCurrentEnvId();
  if (current) return current;

  // tier 2/3: enumerate
  const envs = listTcbEnvs();
  if (envs.length === 0) {
    console.error(red("未找到可用的 CloudBase 环境，请先 tcb login"));
    process.exit(1);
  }
  if (envs.length === 1) {
    console.log(dim(`[env] 自动选择唯一环境 ${envs[0].envId}`));
    return envs[0].envId;
  }

  // multiple envs — need interactive
  if (!process.stdin.isTTY) {
    console.error(red(
      "检测到多个 CloudBase 环境，非交互模式无法自动选择。\n" +
      "请传 -e <envId>，或运行 tcb env use <envId> 设为默认。"
    ));
    process.exit(1);
  }

  console.log("\n请选择 CloudBase 环境：");
  envs.forEach((e, i) => console.log(`  ${i + 1}. ${e.envId}  ${e.alias || ""}`));
  const answer = await new Promise(resolve => {
    const r = createInterface({ input: process.stdin, output: process.stdout });
    r.question(cyan("\n输入序号："), ans => { r.close(); resolve(ans.trim()); });
  });
  const idx = parseInt(answer, 10) - 1;
  if (idx < 0 || idx >= envs.length) {
    console.error(red("无效选择"));
    process.exit(1);
  }
  const chosen = envs[idx].envId;
  try { runTcb(["env", "use", chosen], { allowFail: true, timeout: 10000 }); } catch {}
  console.log(bold(`[env] 已选择 ${chosen}，已设为默认`));
  return chosen;
}

/** Resolve envId from args, env var, or tcb auto-detect. Exits on failure. */
export function requireEnvId(args) {
  let envId;
  // 1. CLI flag -e / --env
  if (args.env) envId = args.env;
  // 2. Environment variable
  else if (process.env.CLOUDBASE_ENV_ID) envId = process.env.CLOUDBASE_ENV_ID;
  // 3. tcb env use --json auto-detect
  else {
    const detected = detectCurrentEnvId();
    if (detected) envId = detected;
  }
  if (!envId) {
    console.error(red("Error: could not detect CloudBase environment."));
    console.error(dim("Run `tcb env use` to select one, or pass -e <envId>"));
    process.exit(1);
  }
  if (!process.env.CLOUDBASE_ENV_ID?.trim()) {
    process.env.CLOUDBASE_ENV_ID = envId;
  }
  hydrateCloudEnvFromCli({ envId });
  return envId;
}
