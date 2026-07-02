/**
 * Managed runtime — materialize deployment-bundle skills into OAK cwd layout.
 *
 * OAK / Claude Agent SDK expects: <cwd>/.claude/skills/<name>/SKILL.md
 * Deployment bundle stores:     <process.cwd()>/skills/<name>/...
 */

import fs from "fs/promises";
import path from "path";

import { managedLog, managedTrace } from "./observability/logging.js";

const SKILL_DOC_NAMES = ["SKILL.md", "skill.md"] as const;

export interface MaterializeManagedSkillsResult {
  materialized: string[];
  skipped: string[];
}

export interface MaterializeManagedSkillsOptions {
  /** Bundle skills root (default: resolve("skills") relative to cwd). */
  bundleSkillsDir?: string;
  /** OAK session cwd (default: /tmp/workspace). */
  workspaceCwd?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function isSkillDirectory(dir: string): Promise<boolean> {
  for (const name of SKILL_DOC_NAMES) {
    if (await pathExists(path.join(dir, name))) return true;
  }
  return false;
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

async function materializeLegacyFlatFile(
  bundleSkillsDir: string,
  name: string,
  destDir: string,
): Promise<boolean> {
  for (const ext of [".md", ".txt"]) {
    const flat = path.join(bundleSkillsDir, `${name}${ext}`);
    if (!(await pathExists(flat))) continue;
    const content = await fs.readFile(flat, "utf-8");
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, "SKILL.md"), content.trim(), "utf-8");
    return true;
  }
  return false;
}

/**
 * Copy installed skills from the deployment bundle into OAK workspace layout.
 */
export async function materializeManagedSkills(
  skillNames: string[],
  opts: MaterializeManagedSkillsOptions = {},
): Promise<MaterializeManagedSkillsResult> {
  const bundleSkillsDir = opts.bundleSkillsDir ?? path.resolve("skills");
  const workspaceCwd = opts.workspaceCwd ?? "/tmp/workspace";
  const destRoot = path.join(workspaceCwd, ".claude", "skills");

  const wl = managedLog({
    lane: "skill-materialize",
    skillCount: skillNames.length,
    bundleSkillsDir,
    workspaceCwd,
  });
  wl.milestone("materialize_start", { skillNames });

  const materialized: string[] = [];
  const skipped: string[] = [];

  if (skillNames.length === 0) {
    wl.emit({ outcome: "ok", materialized: 0, skipped: 0 });
    return { materialized, skipped };
  }

  if (!(await pathExists(bundleSkillsDir))) {
    wl.error(new Error(`Bundle skills dir not found: ${bundleSkillsDir}`), {
      phase: "materialize",
    });
    wl.emit({ outcome: "error", skipped: skillNames.length });
    console.warn(
      `[ManagedSkills] Bundle skills dir not found: ${bundleSkillsDir}`,
    );
    return { materialized, skipped: [...skillNames] };
  }

  await fs.mkdir(destRoot, { recursive: true });

  for (const rawName of skillNames) {
    const name = rawName.trim();
    if (!name) continue;

    const bundleDir = path.join(bundleSkillsDir, name);
    const destDir = path.join(destRoot, name);

    try {
      if (await isSkillDirectory(bundleDir)) {
        await fs.rm(destDir, { recursive: true, force: true });
        await copyDirRecursive(bundleDir, destDir);
        materialized.push(name);
        wl.phase("materialize_skill", { skill: name, layout: "directory", destDir });
        managedTrace("skill-materialize.ok", { skill: name, destDir });
        continue;
      }

      if (await materializeLegacyFlatFile(bundleSkillsDir, name, destDir)) {
        materialized.push(name);
        wl.phase("materialize_skill", { skill: name, layout: "flat-md", destDir });
        managedTrace("skill-materialize.ok", { skill: name, destDir });
        continue;
      }

      skipped.push(name);
      wl.phase("materialize_skip", { skill: name, reason: "not_found" });
      console.warn(
        `[ManagedSkills] Skill '${name}' not found under ${bundleSkillsDir}`,
      );
    } catch (err) {
      skipped.push(name);
      wl.error(err, { phase: "materialize_skill", skill: name });
      console.warn(
        `[ManagedSkills] Failed to materialize '${name}': ${(err as Error).message}`,
      );
    }
  }

  wl.emit({
    outcome: skipped.length && !materialized.length ? "error" : "ok",
    materialized: materialized.length,
    skipped: skipped.length,
    skills: { materialized, skipped },
  });

  return { materialized, skipped };
}
