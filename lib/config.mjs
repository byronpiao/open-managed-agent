/**
 * ~/.magent 全局配置与 code 路径解析。
 *
 * resolveCodePath 按 5 级优先级查找 agent code 目录：
 *   1. --code 显式传入
 *   2. ~/.magent/config.json 的 codePath
 *   3. ~/.magent/packages/agent-runtime（install.sh / magent init 位置）
 *   4. <magent.mjs 所在目录>/packages/agent-runtime（git clone / npm install -g）
 *   5. require.resolve("open-managed-agent-runtime/package.json") 目录（npm install -g fallback）
 * 找到后若缺 dist/，自动 npm run build 补齐。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

export const MAGENT_DIR = join(homedir(), ".magent");
export const CONFIG_PATH = join(MAGENT_DIR, "config.json");
const DEFAULT_GLOBAL_CODE = join(MAGENT_DIR, "packages", "agent-runtime");

// lib/config.mjs 在 lib/ 下，仓库根 = ../
const MAGENT_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_CODE = join(MAGENT_SCRIPT_DIR, "..", "packages", "agent-runtime");

const REPO_URL = "https://github.com/yhsunshining/open-managed-agent.git";

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  if (!existsSync(MAGENT_DIR)) mkdirSync(MAGENT_DIR, { recursive: true });
  const next = { ...readConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
}

export function resolveCodePath(explicit) {
  // 显式传入的路径必须存在，不 fallback
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`--code path not found: ${explicit}`);
    }
    return ensureDist(explicit);
  }

  const candidates = [
    readConfig().codePath,
    DEFAULT_GLOBAL_CODE,
    REPO_CODE,
  ];

  // npm install -g fallback: require.resolve runtime 包
  try {
    const require = createRequire(import.meta.url);
    const rtPkg = require.resolve("open-managed-agent-runtime/package.json");
    candidates.push(dirname(rtPkg));
  } catch {}

  for (const c of candidates) {
    if (c && existsSync(c)) return ensureDist(c);
  }

  throw new Error(
    "Code directory not found.\n" +
    "  Run `magent init` to download the template to ~/.magent,\n" +
    "  or pass --code <path> to specify a custom location.",
  );
}

function ensureDist(code) {
  if (existsSync(join(code, "dist"))) return code;
  console.log(`dist/ missing in ${code} — running npm run build ...`);
  execSync("npm run build", { cwd: code, stdio: "inherit" });
  return code;
}
