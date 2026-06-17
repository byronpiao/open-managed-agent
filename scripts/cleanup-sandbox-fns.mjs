#!/usr/bin/env node
/**
 * 批量删除环境中 sandbox-prod-conversation* 失败函数
 *   - 删除时 5 个并发
 *
 * Usage:
 *   node scripts/cleanup-sandbox-fns.mjs              # 预览 + 确认
 *   node scripts/cleanup-sandbox-fns.mjs --yes        # 直接删除
 *   node scripts/cleanup-sandbox-fns.mjs -e <envId>  # 指定环境
 */

import { spawnSync } from "child_process";
import { getNodeExecutable, getTcbScript } from "../lib/tcb.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes") || args.includes("-y");
const envIdx = args.indexOf("-e");
const env = envIdx >= 0 ? args[envIdx + 1] : "lowcode-5ggo4v9l54b8b32c";
const CONCURRENCY = 5;

const nodeExe = getNodeExecutable();
const tcbScript = getTcbScript();

// 1. 获取函数列表
console.log(`正在获取环境 ${env} 的函数列表...`);
const listRes = spawnSync(nodeExe, [tcbScript, "fn", "list", "-e", env, "-l", "100", "--json"], {
  encoding: "utf-8",
  timeout: 30000,
});

if (listRes.status !== 0) {
  console.error("获取函数列表失败：", listRes.stderr || listRes.stdout);
  process.exit(1);
}

const raw = listRes.stdout;
const start = raw.indexOf("{");
const functions = JSON.parse(raw.slice(start)).data ?? [];

const targets = functions.filter((fn) =>
  fn.name?.startsWith("sandbox-prod-conversation")
);

if (targets.length === 0) {
  console.log("没有找到 sandbox-prod-conversation* 函数，无需清理。");
  process.exit(0);
}

console.log(`\n找到 ${targets.length} 个函数：`);
for (const fn of targets) {
  console.log(`  - ${fn.name}  (${fn.status})`);
}

if (dryRun) {
  console.log("\n[--dry-run] 仅预览，未执行删除。");
  process.exit(0);
}

if (!yes) {
  console.log("\n确认删除？按 Enter 继续，Ctrl+C 取消...");
  await new Promise((resolve) => {
    process.stdin.once("data", resolve);
    process.stdin.resume();
  });
  process.stdin.pause();
}

// 2. 并发删除（5 个并发）
console.log(`\n开始删除（并发 ${CONCURRENCY}）...\n`);

let ok = 0, fail = 0;

async function deleteOne(fn) {
  return new Promise((resolve) => {
    process.stdout.write(`  删除 ${fn.name}... `);
    const res = spawnSync(nodeExe, [tcbScript, "fn", "delete", fn.name, "-e", env], {
      encoding: "utf-8",
      timeout: 30000,
    });
    if (res.status === 0) {
      console.log("OK");
      ok++;
    } else {
      const msg = (res.stderr || res.stdout || "未知错误").trim().split("\n")[0];
      console.log(`失败: ${msg}`);
      fail++;
    }
    resolve();
  });
}

async function runPool() {
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const fn = queue.shift();
      if (fn) await deleteOne(fn);
    }
  });
  await Promise.all(workers);
}

await runPool();

console.log(`\n完成：成功 ${ok}，失败 ${fail}，总计 ${targets.length}`);
process.exit(fail > 0 ? 1 : 0);
