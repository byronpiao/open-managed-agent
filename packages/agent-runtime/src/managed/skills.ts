/**
 * Managed runtime — materialize deployment-bundle skills into OAK cwd layout.
 *
 * OAK / Claude Agent SDK expects: <cwd>/.claude/skills/<name>/SKILL.md
 * Deployment bundle stores:     <runtime-pkg>/skills/<name>/...
 *   SCF:  /var/user/skills/...   (runtime pkg root; process cwd is /tmp/workspace)
 *   TCBR: /app/skills/...        (WORKDIR /app)
 */

import { existsSync, readdirSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { resolveOakWorkspaceCwd } from "../oak-runtime/workspace.js";
import { managedLog, managedTrace } from "./observability/logging.js";

const SKILL_DOC_NAMES = ["SKILL.md", "skill.md"] as const;

const BUNDLE_SKILLS_DIR_CANDIDATES = ["/var/user/skills", "/app/skills"] as const;

export interface MaterializeManagedSkillsResult {
  materialized: string[];
  skipped: string[];
}

export interface MaterializeManagedSkillsOptions {
  /** Bundle skills root (default: resolveBundleSkillsDir()). */
  bundleSkillsDir?: string;
  /** OAK session cwd (default: {@link resolveOakWorkspaceCwd}). */
  workspaceCwd?: string;
}

export interface ResolveBundleSkillsDirOptions {
  cwd?: string;
  /** Override runtime package root (tests); default: dirname(import.meta.url)/../.. */
  runtimePkgRoot?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Destination SKILL.md path for a skill name under the OAK workspace cwd. */
export function oakSkillDestPath(workspaceCwd: string, skillName: string): string {
  return path.join(workspaceCwd, ".claude", "skills", skillName, "SKILL.md");
}

function bundleSkillsDirCandidates(opts: ResolveBundleSkillsDirOptions): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const runtimePkgRoot =
    opts.runtimePkgRoot ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  return [
    path.join(runtimePkgRoot, "skills"),
    path.resolve(cwd, "skills"),
    ...BUNDLE_SKILLS_DIR_CANDIDATES,
  ];
}

/**
 * Locate deploy-bundle skills/ regardless of process cwd.
 * SCF starts with cwd=/tmp/workspace but skills live under /var/user/skills.
 */
export function resolveBundleSkillsDirSync(
  opts: ResolveBundleSkillsDirOptions = {},
): string {
  const runtimePkgRoot =
    opts.runtimePkgRoot ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const fallback = path.join(runtimePkgRoot, "skills");

  const seen = new Set<string>();
  for (const dir of bundleSkillsDirCandidates(opts)) {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (existsSync(normalized)) return normalized;
  }

  return fallback;
}

export async function resolveBundleSkillsDir(
  opts: ResolveBundleSkillsDirOptions = {},
): Promise<string> {
  return resolveBundleSkillsDirSync(opts);
}

/** Skill directory names present in the deploy bundle (sync). */
export function listBundledSkillNames(bundleSkillsDir: string): string[] {
  if (!existsSync(bundleSkillsDir)) return [];
  const names: string[] = [];
  for (const entry of readdirSync(bundleSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(bundleSkillsDir, entry.name);
    if (SKILL_DOC_NAMES.some((n) => existsSync(path.join(dir, n)))) {
      names.push(entry.name);
    }
  }
  return names;
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
  const bundleSkillsDir = opts.bundleSkillsDir ?? (await resolveBundleSkillsDir());
  const workspaceCwd = opts.workspaceCwd ?? resolveOakWorkspaceCwd();
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
