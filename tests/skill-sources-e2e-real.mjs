/**
 * Real-network skill source E2E (local sync only).
 *
 * Run: npm run test:skills-e2e
 *
 * Requires network for git / skillhub / skills.sh sources.
 * Local paths use tests/fixtures/skills-e2e + /tmp abs skill (no ~/.skills-manager-plus).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, mkdirSync, existsSync } from "node:fs";

import { normalizeGitUrl } from "../lib/skill-sources.mjs";
import { syncSkillsInDir, applySkillsToDeployDir, listSkillNamesInDir } from "../lib/skills-sync.mjs";
import { readInstallManifest } from "../lib/skill-sources.mjs";
import {
  prepareSkillE2eWorkspace,
  loadSkillsFromAgentYaml,
  assertFullSchemaDeployed,
  assertSkillMd,
  EXPECTED_NAMED_SKILLS,
  REMOTE_SKILL_SOURCES,
  BUNDLE_YAML_NAME,
} from "./skill-e2e-lib.mjs";

const DEPLOY_ROOT = join("/tmp", "oma-skill-e2e-real");

function resetDeploy(sub) {
  const dir = join(DEPLOY_ROOT, sub);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("normalizeGitUrl: public-skills tree/main (whole repo)", () => {
  const r = normalizeGitUrl(REMOTE_SKILL_SOURCES["public-skills-bundle"].slice(4));
  assert.equal(r.cloneUrl, "https://github.com/RealAlexandreAI/public-skills.git");
  assert.equal(r.branch, "main");
  assert.equal(r.subpath, undefined);
});

test("normalizeGitUrl: mattpocock handoff tree path (single skill)", () => {
  const r = normalizeGitUrl(REMOTE_SKILL_SOURCES.handoff.slice(4));
  assert.equal(r.cloneUrl, "https://github.com/mattpocock/skills.git");
  assert.equal(r.subpath, "skills/productivity/handoff");
});

test("1. local relative: ./skills/local-rel", async () => {
  const { workspaceDir } = prepareSkillE2eWorkspace(join(DEPLOY_ROOT, "ws-rel"));
  const deployDir = resetDeploy("local-rel");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });

  const result = await syncSkillsInDir(
    [{ name: "local-rel", source: "./skills/local-rel" }],
    deploySkills,
    { configDir: workspaceDir, cwd: workspaceDir },
  );
  assert.ok(result.added.includes("local-rel"));
  assertSkillMd(deploySkills, "local-rel");
});

test("2. local absolute: /tmp abs skill", async () => {
  const { workspaceDir, absSkillPath } = prepareSkillE2eWorkspace(join(DEPLOY_ROOT, "ws-abs"));
  const deployDir = resetDeploy("local-abs");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });

  const result = await syncSkillsInDir(
    [{ name: "local-abs", source: absSkillPath }],
    deploySkills,
    { configDir: workspaceDir, cwd: workspaceDir },
  );
  assert.ok(result.added.includes("local-abs"));
});

test("3. git single: mattpocock handoff", async () => {
  const deployDir = resetDeploy("git-single");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });
  const result = await syncSkillsInDir(
    [{ name: "handoff", source: REMOTE_SKILL_SOURCES.handoff }],
    deploySkills,
    { configDir: "/tmp", cwd: "/tmp" },
  );
  assert.ok(result.added.includes("handoff"));
}, { timeout: 180_000 });

test("4. git bundle: RealAlexandreAI/public-skills", async () => {
  const deployDir = resetDeploy("git-bundle");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });
  await syncSkillsInDir(
    [{ name: BUNDLE_YAML_NAME, source: REMOTE_SKILL_SOURCES[BUNDLE_YAML_NAME] }],
    deploySkills,
    { configDir: "/tmp", cwd: "/tmp" },
  );
  const names = listSkillNamesInDir(deploySkills);
  assert.ok(names.length >= 1);
  const manifest = readInstallManifest(deploySkills);
  assert.ok(manifest.bundles?.[BUNDLE_YAML_NAME]);
}, { timeout: 300_000 });

test("5. skillhub slug: poster", async () => {
  const deployDir = resetDeploy("skillhub-slug");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });
  const result = await syncSkillsInDir(
    [{ name: "poster", source: REMOTE_SKILL_SOURCES.poster }],
    deploySkills,
    { configDir: "/tmp", cwd: "/tmp" },
  );
  assert.ok(result.added.includes("poster"));
}, { timeout: 120_000 });

test("6. skillhub full URL: academic-review", async () => {
  const deployDir = resetDeploy("skillhub-url");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });
  const result = await syncSkillsInDir(
    [{ name: "academic-review", source: REMOTE_SKILL_SOURCES["academic-review"] }],
    deploySkills,
    { configDir: "/tmp", cwd: "/tmp" },
  );
  assert.ok(result.added.includes("academic-review"));
}, { timeout: 120_000 });

test("7. skills.sh shorthand: edit-article", async () => {
  const deployDir = resetDeploy("skillssh-short");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });
  const result = await syncSkillsInDir(
    [{ name: "edit-article", source: REMOTE_SKILL_SOURCES["edit-article"] }],
    deploySkills,
    { configDir: "/tmp", cwd: "/tmp" },
  );
  assert.ok(result.added.includes("edit-article"));
}, { timeout: 180_000 });

test("8. skills.sh full URL: tdd", async () => {
  const deployDir = resetDeploy("skillssh-url");
  const deploySkills = join(deployDir, "skills");
  mkdirSync(deploySkills, { recursive: true });
  const result = await syncSkillsInDir(
    [{ name: "tdd", source: REMOTE_SKILL_SOURCES.tdd }],
    deploySkills,
    { configDir: "/tmp", cwd: "/tmp" },
  );
  assert.ok(result.added.includes("tdd"));
}, { timeout: 180_000 });

test("9. no source: skills/<name>/ directory", async () => {
  const { workspaceDir } = prepareSkillE2eWorkspace(join(DEPLOY_ROOT, "ws-nosrc-dir"));
  const deployDir = resetDeploy("no-source-dir");
  const result = await applySkillsToDeployDir(
    deployDir,
    [{ name: "no-source-dir" }],
    { configFile: join(workspaceDir, "agent.yaml") },
  );
  assert.ok(result.added.includes("no-source-dir"));
});

test("10. no source: skills/<name>.md flat file", async () => {
  const { workspaceDir } = prepareSkillE2eWorkspace(join(DEPLOY_ROOT, "ws-nosrc-flat"));
  const deployDir = resetDeploy("no-source-flat");
  const result = await applySkillsToDeployDir(
    deployDir,
    [{ name: "flat-legacy" }],
    { configFile: join(workspaceDir, "agent.yaml") },
  );
  assert.ok(result.added.includes("flat-legacy"));
});

test("full schema: all 10 scenarios in one deploy dir", async () => {
  const { workspaceDir, agentYaml } = prepareSkillE2eWorkspace(join(DEPLOY_ROOT, "ws-full"));
  const deployDir = resetDeploy("full-schema");
  const skills = loadSkillsFromAgentYaml(agentYaml);
  assert.equal(skills.length, 10);

  await applySkillsToDeployDir(deployDir, skills, { configFile: agentYaml });

  const { names } = assertFullSchemaDeployed(deployDir, { minBundleSkills: 1 });
  for (const name of EXPECTED_NAMED_SKILLS) {
    assert.ok(names.includes(name), `full schema missing ${name}`);
  }
  assert.equal(skills.length, 10);
  assert.ok(existsSync(join(workspaceDir, "skills", "local-rel", "SKILL.md")));
}, { timeout: 600_000 });
