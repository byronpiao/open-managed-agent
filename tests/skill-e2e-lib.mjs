/**
 * Shared skill E2E helpers — workspace prep, expectations, cloud CLI.
 */

import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { listSkillNamesInDir } from "../lib/skills-sync.mjs";
import { readInstallManifest } from "../lib/skill-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const FIXTURE_ROOT = join(__dirname, "fixtures", "skills-e2e");

/** Nine explicitly named skills from the canonical schema (bundle installs extra dirs). */
export const EXPECTED_NAMED_SKILLS = [
  "local-rel",
  "local-abs",
  "handoff",
  "poster",
  "academic-review",
  "edit-article",
  "tdd",
  "no-source-dir",
  "flat-legacy",
];

export const BUNDLE_YAML_NAME = "public-skills-bundle";

/** Remote sources used in the full schema (network E2E). */
export const REMOTE_SKILL_SOURCES = {
  handoff:
    "git:https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff",
  [BUNDLE_YAML_NAME]:
    "git:https://github.com/RealAlexandreAI/public-skills/tree/main",
  poster: "skillhub:poster",
  "academic-review":
    "skillhub:https://skillhub.cn/skills/academic-pre-review-committee",
  "edit-article": "skills.sh:mattpocock/skills/edit-article",
  tdd: "skills.sh:https://www.skills.sh/mattpocock/skills/tdd",
};

/** Cloud skill E2E deploy env (TCBR needs normal tenant). Override with SKILL_E2E_ENV_ID. */
export const SKILL_E2E_CLOUD_ENV_DEFAULT = "lowcode-8gtybv2a87db84a3";

export function resolveSkillE2eEnvId({ cloud = false } = {}) {
  loadDotEnv();
  if (cloud) {
    return (
      process.env.SKILL_E2E_ENV_ID?.trim() ||
      SKILL_E2E_CLOUD_ENV_DEFAULT
    );
  }
  return process.env.CLOUDBASE_ENV_ID?.trim() || "";
}

export function loadDotEnv() {
  const envFile = resolve(REPO_ROOT, ".env");
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

export function resolveApiKey() {
  return (
    process.env.CLOUDBASE_APIKEY?.trim() ||
    process.env.CLOUDBASE_ACCESS_KEY?.trim() ||
    ""
  );
}

export function requireCloudCredentials({ cloud = false } = {}) {
  loadDotEnv();
  const envId = resolveSkillE2eEnvId({ cloud });
  const apiKey = resolveApiKey();
  if (!envId || !apiKey) {
    return null;
  }
  return { envId, apiKey };
}

/**
 * Prepare an isolated workspace under /tmp with local fixtures + abs-path skill.
 * @returns {{ workspaceDir: string, agentYaml: string, absSkillPath: string, skills: Array }}
 */
export function prepareSkillE2eWorkspace(tmpRoot = join("/tmp", `oma-skill-e2e-${Date.now()}`)) {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
  cpSync(FIXTURE_ROOT, tmpRoot, { recursive: true });

  const absSkillPath = join(tmpRoot, "abs-local-skill");
  mkdirSync(absSkillPath, { recursive: true });
  writeFileSync(
    join(absSkillPath, "SKILL.md"),
    "# Local absolute skill (E2E)\n\nmarker: local-abs-fixture\n",
    "utf-8",
  );

  const skills = buildCanonicalSkills(absSkillPath);
  const agentYaml = join(tmpRoot, "agent.yaml");
  writeFileSync(
    agentYaml,
    [
      "name: oma-skills-e2e",
      "runtime: managed",
      "model: hy3-preview",
      "system: Skill sync E2E test agent.",
      "",
      "skills:",
      ...skills.flatMap((s) => formatSkillYamlEntry(s)),
      "",
    ].join("\n"),
    "utf-8",
  );

  return { workspaceDir: tmpRoot, agentYaml, absSkillPath, skills };
}

export function buildCanonicalSkills(absSkillPath) {
  return [
    { name: "local-rel", source: "./skills/local-rel" },
    { name: "local-abs", source: absSkillPath },
    { name: "handoff", source: REMOTE_SKILL_SOURCES.handoff },
    { name: BUNDLE_YAML_NAME, source: REMOTE_SKILL_SOURCES[BUNDLE_YAML_NAME] },
    { name: "poster", source: REMOTE_SKILL_SOURCES.poster },
    { name: "academic-review", source: REMOTE_SKILL_SOURCES["academic-review"] },
    { name: "edit-article", source: REMOTE_SKILL_SOURCES["edit-article"] },
    { name: "tdd", source: REMOTE_SKILL_SOURCES.tdd },
    { name: "no-source-dir" },
    { name: "flat-legacy" },
  ];
}

function formatSkillYamlEntry(skill) {
  const lines = [`  - name: ${skill.name}`];
  if (skill.source) lines.push(`    source: ${skill.source}`);
  return lines;
}

export function loadSkillsFromAgentYaml(agentYaml) {
  const config = parseYaml(readFileSync(agentYaml, "utf-8"));
  return config.skills ?? [];
}

export function assertSkillMd(skillsDir, name) {
  const skillMd = join(skillsDir, name, "SKILL.md");
  assert.ok(existsSync(skillMd), `missing ${skillMd}`);
  const body = readFileSync(skillMd, "utf-8");
  assert.ok(body.trim().length > 10, `SKILL.md too short for ${name}`);
  return body;
}

/**
 * Verify deploy dir contains all named skills + git bundle manifest entries.
 */
export function assertFullSchemaDeployed(deployDir, { minBundleSkills = 1 } = {}) {
  const skillsDir = join(deployDir, "skills");
  assert.ok(existsSync(skillsDir), `missing skills/ under ${deployDir}`);

  const names = listSkillNamesInDir(skillsDir);
  for (const name of EXPECTED_NAMED_SKILLS) {
    assert.ok(names.includes(name), `missing skill '${name}' (have: ${names.join(", ")})`);
    assertSkillMd(skillsDir, name);
  }

  const manifest = readInstallManifest(skillsDir);
  const bundle = manifest.bundles?.[BUNDLE_YAML_NAME];
  assert.ok(bundle, `missing manifest bundle '${BUNDLE_YAML_NAME}'`);
  assert.ok(
    Array.isArray(bundle.installed) && bundle.installed.length >= minBundleSkills,
    `bundle installed too small: ${bundle.installed?.length ?? 0}`,
  );
  for (const n of bundle.installed) {
    assertSkillMd(skillsDir, n);
  }

  assert.ok(
    names.length >= EXPECTED_NAMED_SKILLS.length + minBundleSkills,
    `expected ≥${EXPECTED_NAMED_SKILLS.length + minBundleSkills} skills, got ${names.length}: ${names.join(", ")}`,
  );

  return { names, manifest };
}

export function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function extractAgentId(output) {
  const stripped = stripAnsi(output);
  const matches = (stripped.match(/(agent-[a-z0-9_-]+[a-z0-9])/g) || []).filter(
    (m) => !m.includes("runtime"),
  );
  return matches[0] ?? "";
}

export function runMagent(cmd, { envId, apiKey, agentId, timeoutMs = 900_000 } = {}) {
  const fullCmd = `node "${resolve(REPO_ROOT, "magent.mjs")}" ${cmd}`;
  return execSync(fullCmd, {
    encoding: "utf-8",
    timeout: timeoutMs,
    env: {
      ...process.env,
      CLOUDBASE_ENV_ID: envId,
      CLOUDBASE_APIKEY: apiKey,
      ...(agentId ? { CLOUDBASE_AGENT_ID: agentId } : {}),
    },
  });
}

export function deleteAgent(agentId, { envId, apiKey, throwOnFailure = true } = {}) {
  try {
    runMagent(`agent:delete -a ${agentId} -e ${envId}`, { envId, apiKey, timeoutMs: 180_000 });
  } catch (err) {
    const detail = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
    const message = `agent:delete failed for ${agentId}: ${detail}`;
    if (throwOnFailure) {
      throw new Error(message);
    }
    console.warn(message);
  }
}
