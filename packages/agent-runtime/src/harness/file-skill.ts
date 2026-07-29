/**
 * Harness runtime: resolve `file:` skill sources to SKILL.md on disk.
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

export interface ParsedFileSkillSource {
  payload: string;
  label: string;
}

export function parseFileSkillSource(source: string): ParsedFileSkillSource | null {
  const src = source?.trim();
  if (!src?.startsWith("file:")) return null;
  const payload = src.slice(5);
  const label = path.basename(payload).replace(/\.(md|txt)$/i, "") || path.basename(payload);
  return { payload, label };
}

function skillDocInDir(dir: string): string | null {
  for (const doc of ["SKILL.md", "skill.md"]) {
    const fp = path.join(dir, doc);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

/** Sync lookup — deploy manifest packing. */
export function resolveHarnessSkillDocSync(
  baseDir: string,
  source: string,
): { label: string; srcPath: string } | null {
  const parsed = parseFileSkillSource(source);
  if (!parsed) return null;

  const { payload, label } = parsed;
  const skillsDir = path.resolve(baseDir, "skills");
  const direct = path.resolve(baseDir, payload);

  if (fs.existsSync(direct)) {
    if (direct.endsWith(".md") || direct.endsWith(".txt")) {
      return { label, srcPath: direct };
    }
    if (fs.statSync(direct).isDirectory()) {
      const doc = skillDocInDir(direct);
      if (doc) return { label, srcPath: doc };
    }
  }

  const fromLabelDir = skillDocInDir(path.join(skillsDir, label));
  if (fromLabelDir) return { label, srcPath: fromLabelDir };

  for (const ext of [".md", ".txt"]) {
    const fp = path.join(skillsDir, `${label}${ext}`);
    if (fs.existsSync(fp)) return { label, srcPath: fp };
  }

  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Async lookup — config system-prompt injection. */
export async function resolveHarnessSkillDoc(
  baseDir: string,
  source: string,
): Promise<{ label: string; srcPath: string } | null> {
  const parsed = parseFileSkillSource(source);
  if (!parsed) return null;

  const { payload, label } = parsed;
  const skillsDir = path.resolve(baseDir, "skills");
  const direct = path.resolve(baseDir, payload);

  if (await pathExists(direct)) {
    if (direct.endsWith(".md") || direct.endsWith(".txt")) {
      return { label, srcPath: direct };
    }
    const stat = await fsPromises.stat(direct);
    if (stat.isDirectory()) {
      for (const doc of ["SKILL.md", "skill.md"]) {
        const fp = path.join(direct, doc);
        if (await pathExists(fp)) return { label, srcPath: fp };
      }
    }
  }

  for (const doc of ["SKILL.md", "skill.md"]) {
    const fp = path.join(skillsDir, label, doc);
    if (await pathExists(fp)) return { label, srcPath: fp };
  }

  for (const ext of [".md", ".txt"]) {
    const fp = path.join(skillsDir, `${label}${ext}`);
    if (await pathExists(fp)) return { label, srcPath: fp };
  }

  const labelDir = path.join(skillsDir, label);
  if (await pathExists(labelDir)) {
    for (const doc of ["SKILL.md", "skill.md"]) {
      const fp = path.join(labelDir, doc);
      if (await pathExists(fp)) return { label, srcPath: fp };
    }
  }

  return null;
}
