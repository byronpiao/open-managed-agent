#!/usr/bin/env node
/**
 * Load `.env` for managed Agent / SDK tests (integration, manual-demo, tools).
 * Harness 验收用 `scripts/harness/load-env.mjs`（只读 `.env.harness`）。
 */

import { existsSync, readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(repoRoot, ".env");

const ALIASES = [
  ["TCB_ENV_ID", "CLOUDBASE_ENV_ID"],
  ["TENCENTCLOUD_SECRETID", "TCB_SECRET_ID"],
  ["TENCENTCLOUD_SECRETKEY", "TCB_SECRET_KEY"],
];

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq === -1) return null;
  const key = trimmed.slice(0, eq).trim();
  let val = trimmed.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  return { key, val };
}

/** Load `.env` only (`cp .env.example .env`). */
export function loadProjectEnv() {
  if (!existsSync(ENV_FILE)) return;
  for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const { key, val } = parsed;
    if (!process.env[key]) process.env[key] = val;
  }
  for (const [from, to] of ALIASES) {
    if (process.env[from] && !process.env[to]) process.env[to] = process.env[from];
  }
}
