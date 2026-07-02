// Skill source installers — prefix schema, directory deploy layout.

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  cpSync,
} from "fs";
import { resolve, join, dirname, basename, extname } from "path";
import { execSync } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { managedTrace } from "./managed-logging.mjs";

const SKILL_DOC_NAMES = ["SKILL.md", "skill.md"];
export const MANIFEST_FILE = ".install-manifest.json";
const WALK_SKIP = new Set([".git", "node_modules", "dist", "build", ".agents"]);

/**
 * @returns {{ kind: 'local'|'git'|'skillhub'|'skillssh', payload: string }}
 */
export function parseSkillSource(source) {
  if (source.startsWith("git:")) return { kind: "git", payload: source.slice(4) };
  if (source.startsWith("skillhub:")) return { kind: "skillhub", payload: source.slice(9) };
  if (source.startsWith("skills.sh:")) return { kind: "skillssh", payload: source.slice(10) };
  return { kind: "local", payload: source };
}

export function isValidSkillDir(dir) {
  if (!existsSync(dir)) return false;
  return SKILL_DOC_NAMES.some((n) => existsSync(join(dir, n)));
}

/**
 * @param {string} source
 * @param {{ cwd?: string, configDir?: string }} ctx
 */
export function resolveLocalSource(source, ctx = {}) {
  const cwd = ctx.cwd ?? process.cwd();
  const configDir = ctx.configDir ?? cwd;
  const candidates = [
    resolve(cwd, source),
    resolve(configDir, source),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Local skill source not found: ${source}`);
}

/**
 * @param {string} url
 * @returns {{ cloneUrl: string, branch?: string, subpath?: string }}
 */
export function normalizeGitUrl(url) {
  let raw = url.trim();
  let subpath;

  const hashIdx = raw.indexOf("#");
  if (hashIdx >= 0) {
    subpath = raw.slice(hashIdx + 1).replace(/\/SKILL\.md$/i, "").replace(/\/skill\.md$/i, "");
    raw = raw.slice(0, hashIdx);
  }

  const treeMatch = raw.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.*)/);
  if (treeMatch) {
    const [, owner, repo, branch, pathPart] = treeMatch;
    return {
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      branch,
      subpath: pathPart.replace(/\/SKILL\.md$/i, "").replace(/\/skill\.md$/i, "") || subpath,
    };
  }

  const treeRootMatch = raw.match(/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?$/);
  if (treeRootMatch) {
    const [, owner, repo, branch] = treeRootMatch;
    return {
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      branch,
      subpath,
    };
  }

  if (/^[\w.-]+\/[\w.-]+$/.test(raw) && !raw.includes("://")) {
    raw = `https://github.com/${raw}.git`;
  }
  if (!raw.endsWith(".git") && raw.includes("github.com")) {
    raw = raw.replace(/\/?$/, ".git");
  }

  return { cloneUrl: raw, subpath };
}

/**
 * @param {string} repoDir
 * @param {{ subpath?: string, skillId?: string }} opts
 */
export function findSkillDir(repoDir, opts = {}) {
  if (opts.subpath) {
    let p = join(repoDir, opts.subpath);
    if (existsSync(p) && !statSync(p).isDirectory()) p = dirname(p);
    if (isValidSkillDir(p)) return p;
    throw new Error(`Skill directory not found at subpath: ${opts.subpath}`);
  }

  if (opts.skillId) {
    const id = opts.skillId;
    const direct = [
      join(repoDir, ".agents", "skills", id),
      join(repoDir, "skills", id),
      join(repoDir, id),
    ];
    for (const d of direct) {
      if (isValidSkillDir(d)) return d;
    }
    const found = walkForSkillId(repoDir, id, 6);
    if (found) return found;
    throw new Error(`Skill '${id}' not found in repository`);
  }

  if (isValidSkillDir(repoDir)) return repoDir;
  throw new Error(`No valid skill directory under ${repoDir}`);
}

function walkForSkillId(dir, skillId, maxDepth, depth = 0) {
  if (depth > maxDepth) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || WALK_SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.name === skillId && isValidSkillDir(p)) return p;
    const nested = walkForSkillId(p, skillId, maxDepth, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function readSkillDocument(skillDir) {
  for (const name of SKILL_DOC_NAMES) {
    const fp = join(skillDir, name);
    if (existsSync(fp)) {
      return { fileName: name, content: readFileSync(fp, "utf-8") };
    }
  }
  throw new Error(`No SKILL.md in ${skillDir}`);
}

/**
 * @param {string} repoDir
 * @returns {Array<{ name: string, skillDir: string }>}
 */
export function scanForSkills(repoDir) {
  if (isValidSkillDir(repoDir)) {
    return [{ name: basename(repoDir), skillDir: repoDir }];
  }
  const out = [];
  walkSkillDirs(repoDir, 8, 0, out);
  if (out.length === 0) throw new Error("No skills found in repository");
  return out;
}

function walkSkillDirs(dir, maxDepth, depth, out) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || WALK_SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (isValidSkillDir(p)) {
      out.push({ name: e.name, skillDir: p });
      continue;
    }
    walkSkillDirs(p, maxDepth, depth + 1, out);
  }
}

export function copySkillDirToDeploy(skillDir, deployedSkillsDir, destName) {
  const dest = join(deployedSkillsDir, destName);
  if (resolve(skillDir) === resolve(dest)) return;
  rmSync(dest, { recursive: true, force: true });
  cpSync(skillDir, dest, { recursive: true });
}

function cloneGitRepo(cloneUrl, branch, tempParent) {
  const tempDir = mkdtempSync(join(tempParent, "magent-skill-"));
  const branchArg = branch ? `--branch ${JSON.stringify(branch)}` : "";
  try {
    execSync(
      `git clone --depth 1 ${branchArg} ${JSON.stringify(cloneUrl)} ${JSON.stringify(tempDir)}`,
      { encoding: "utf-8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] },
    );
    return tempDir;
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`git clone failed: ${err.message}`);
  }
}

export { cloneGitRepo };

export function parseSkillsShPayload(payload) {
  const urlMatch = payload.match(/skills\.sh\/([^/]+)\/skills\/([^/?#]+)/i);
  if (urlMatch) {
    return { owner: urlMatch[1], skillId: urlMatch[2] };
  }
  const parts = payload.split("/").filter(Boolean);
  if (parts.length >= 3) {
    return { owner: parts[0], skillId: parts[parts.length - 1] };
  }
  throw new Error(`Invalid skills.sh payload: ${payload}`);
}

export function parseSkillhubSlug(payload) {
  const trimmed = payload.trim();
  const urlMatch = trimmed.match(/^https?:\/\/skillhub\.cn\/skills\/([^/]+)\/?/i);
  if (urlMatch) return urlMatch[1];
  return trimmed;
}


async function fetchSkillhubDir(slug, fetchImpl = globalThis.fetch) {
  const apiBase = "https://api.skillhub.tencent.com/api/v1";
  const metaRes = await fetchImpl(`${apiBase}/skills/${encodeURIComponent(slug)}`);
  if (!metaRes.ok) {
    throw new Error(`skillhub metadata failed (${metaRes.status}) for slug: ${slug}`);
  }
  const meta = await metaRes.json();
  const version =
    meta?.latestVersion?.version ??
    meta?.latest_version ??
    meta?.latestVersion ??
    meta?.version ??
    meta?.data?.latest_version;
  if (!version) throw new Error(`skillhub: no version for slug ${slug}`);

  const fileUrl = `${apiBase}/skills/${encodeURIComponent(slug)}/file?path=SKILL.md&version=${encodeURIComponent(version)}`;
  const fileRes = await fetchImpl(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`skillhub SKILL.md fetch failed (${fileRes.status}) for ${slug}`);
  }
  const content = await fileRes.text();
  const tempDir = mkdtempSync(join(tmpdir(), "magent-skillhub-"));
  const skillDir = join(tempDir, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
  return { skillDir, tempRoot: tempDir };
}

export function readInstallManifest(deployedSkillsDir) {
  const fp = join(deployedSkillsDir, MANIFEST_FILE);
  if (!existsSync(fp)) return { bundles: {} };
  try {
    return JSON.parse(readFileSync(fp, "utf-8"));
  } catch {
    return { bundles: {} };
  }
}

export function writeInstallManifest(deployedSkillsDir, manifest) {
  writeFileSync(
    join(deployedSkillsDir, MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

/**
 * Default install when `source` is omitted: skills/<name>/ or skills/<name>.md under configDir.
 * @returns {{ destName: string, skillDir: string, tempRoot?: string } | null}
 */
export function tryResolveDefaultLocalSkill(skill, configDir, tempParent) {
  const skillsRoot = join(configDir, "skills");
  const dir = join(skillsRoot, skill.name);
  if (existsSync(dir) && statSync(dir).isDirectory() && isValidSkillDir(dir)) {
    return { destName: skill.name, skillDir: dir };
  }
  for (const ext of [".md", ".txt"]) {
    const flat = join(skillsRoot, skill.name + ext);
    if (existsSync(flat) && statSync(flat).isFile()) {
      const tempRoot = mkdtempSync(join(tempParent, "magent-flat-skill-"));
      const skillDir = join(tempRoot, skill.name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), readFileSync(flat, "utf-8").trim(), "utf-8");
      return { destName: skill.name, skillDir, tempRoot };
    }
  }
  return null;
}

/**
 * @param {{ name: string, source?: string }} skill
 * @param {{ cwd: string, configDir: string, tempParent?: string, cloneGitRepo?: typeof cloneGitRepo, fetchImpl?: typeof fetch }} ctx
 * @returns {Promise<Array<{ destName: string, skillDir: string, bundleKey?: string, tempRoot?: string }>>}
 */
export async function resolveSkillArtifacts(skill, ctx) {
  if (!skill?.source?.trim()) {
    managedTrace("skill-source.resolve", { skill: skill.name, kind: "default" });
    const local = tryResolveDefaultLocalSkill(
      skill,
      ctx.configDir ?? ctx.cwd ?? process.cwd(),
      ctx.tempParent ?? tmpdir(),
    );
    if (local) return [local];
    const slug = skill.name?.trim();
    if (!slug) throw new Error("Skill entry missing name");
    managedTrace("skill-source.skillhub_fallback", { skill: skill.name, slug });
    const { skillDir, tempRoot } = await fetchSkillhubDir(slug, ctx.fetchImpl ?? globalThis.fetch);
    return [{ destName: skill.name, skillDir, tempRoot }];
  }

  const { kind, payload } = parseSkillSource(skill.source);
  managedTrace("skill-source.resolve", { skill: skill.name, kind, payloadPreview: payload.slice(0, 120) });
  const tempParent = ctx.tempParent ?? tmpdir();
  const doClone = ctx.cloneGitRepo ?? cloneGitRepo;
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;

  if (kind === "local") {
    const localPath = resolveLocalSource(payload, ctx);
    const skillDir = statSync(localPath).isDirectory()
      ? localPath
      : dirname(localPath);
    if (!isValidSkillDir(skillDir)) {
      throw new Error(`Not a valid skill directory: ${skillDir}`);
    }
    return [{ destName: skill.name, skillDir }];
  }

  if (kind === "git") {
    const { cloneUrl, branch, subpath } = normalizeGitUrl(payload);
    managedTrace("skill-source.git_clone", { skill: skill.name, cloneUrl, branch, subpath });
    const repoDir = doClone(cloneUrl, branch, tempParent);

    if (subpath) {
      const skillDir = findSkillDir(repoDir, { subpath });
      return [{ destName: skill.name, skillDir, tempRoot: repoDir }];
    }

    try {
      const skillDir = findSkillDir(repoDir, {});
      return [{ destName: skill.name, skillDir, tempRoot: repoDir }];
    } catch {
      const scanned = scanForSkills(repoDir);
      if (scanned.length === 1) {
        return [{ destName: skill.name, skillDir: scanned[0].skillDir, tempRoot: repoDir }];
      }
      return scanned.map((s) => ({
        destName: s.name,
        skillDir: s.skillDir,
        bundleKey: skill.name,
        tempRoot: repoDir,
      }));
    }
  }

  if (kind === "skillssh") {
    const { owner, skillId } = parseSkillsShPayload(payload);
    const cloneUrl = `https://github.com/${owner}/skills.git`;
    managedTrace("skill-source.skillssh_clone", { skill: skill.name, owner, skillId, cloneUrl });
    const repoDir = doClone(cloneUrl, undefined, tempParent);
    const skillDir = findSkillDir(repoDir, { skillId });
    return [{ destName: skill.name, skillDir, tempRoot: repoDir }];
  }

  if (kind === "skillhub") {
    const slug = parseSkillhubSlug(payload);
    managedTrace("skill-source.skillhub_fetch", { skill: skill.name, slug });
    const { skillDir, tempRoot } = await fetchSkillhubDir(slug, fetchImpl);
    return [{ destName: skill.name, skillDir, tempRoot }];
  }

  throw new Error(`Unsupported skill source kind: ${kind}`);
}
