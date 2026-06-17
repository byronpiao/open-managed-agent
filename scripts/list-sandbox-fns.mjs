#!/usr/bin/env node
/**
 * 列出指定环境中 sandbox-prod-conversation 开头的云函数
 *
 * Usage:
 *   node scripts/list-sandbox-fns.mjs [-e <envId>]
 *   # 或直接修改下方 DEFAULT_ENV
 */

import { spawnSync } from "child_process";

const DEFAULT_ENV = "lowcode-5ggo4v9l54b8b32c";
const env = process.argv.find((a, i) => a === "-e" && process.argv[i + 1])?.next?.value
  ?? process.argv[process.argv.indexOf("-e") + 1]
  ?? DEFAULT_ENV;

// 复用 magent 的 tcb 解析逻辑
import { getNodeExecutable, getTcbScript } from "../lib/tcb.mjs";

const res = spawnSync(getNodeExecutable(), [
  getTcbScript(),
  "fn", "list",
  "-e", env,
  "--json",
], { encoding: "utf-8", timeout: 30000 });

if (res.status !== 0) {
  console.error("tcb fn list failed:", res.stderr || res.stdout);
  process.exit(1);
}

// tcb 输出可能混有非 JSON 前缀，找第一个 {
const raw = res.stdout;
const start = raw.indexOf("{");
if (start < 0) {
  console.error("无法解析 tcb 输出：", raw.slice(0, 200));
  process.exit(1);
}

const data = JSON.parse(raw.slice(start));
const functions = data?.data ?? [];

const filtered = functions.filter((fn) =>
  fn.name?.startsWith("sandbox-prod-conversation")
);

console.log(`环境: ${env}`);
console.log(`共有 ${filtered.length} 个 sandbox-prod-conversation* 函数：\n`);

for (const fn of filtered) {
  console.log(`  ${fn.name}  (${fn.status})`);
}

console.log(`\n总计: ${filtered.length}`);
