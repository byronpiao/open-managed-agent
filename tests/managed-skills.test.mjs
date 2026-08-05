import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";

const runtimeRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "agent-runtime-managed",
);

const {
  resolveOakWorkspaceCwd,
  OAK_WORKSPACE_CWD,
} = await import(join(runtimeRoot, "dist", "oak-runtime", "workspace.js"));

const {
  materializeManagedSkills,
  resolveBundleSkillsDir,
  resolveBundleSkillsDirSync,
  oakSkillDestPath,
} = await import(join(runtimeRoot, "dist", "managed", "skills.js"));

const TMP = join("/tmp", "oma-managed-skills-test");

function reset() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

test("resolveOakWorkspaceCwd returns /tmp/workspace", () => {
  assert.equal(resolveOakWorkspaceCwd(), OAK_WORKSPACE_CWD);
});

test("oakSkillDestPath matches OAK layout", () => {
  assert.equal(
    oakSkillDestPath("/tmp/workspace", "demo"),
    "/tmp/workspace/.claude/skills/demo/SKILL.md",
  );
});

test("resolveBundleSkillsDir matches sync variant", async () => {
  reset();
  const appRoot = join(TMP, "sync-parity");
  const appSkills = join(appRoot, "skills");
  mkdirSync(join(appSkills, "parity"), { recursive: true });
  writeFileSync(join(appSkills, "parity", "SKILL.md"), "# p");

  const opts = { cwd: appRoot, runtimePkgRoot: appRoot };
  assert.equal(await resolveBundleSkillsDir(opts), resolveBundleSkillsDirSync(opts));
  assert.equal(await resolveBundleSkillsDir(opts), appSkills);
});

test("resolveBundleSkillsDir prefers runtime pkg over mismatched cwd (SCF)", async () => {
  reset();
  const scfRoot = join(TMP, "var-user");
  const scfSkills = join(scfRoot, "skills");
  const scfWorkspace = join(TMP, "workspace-cwd");
  mkdirSync(join(scfSkills, "demo"), { recursive: true });
  writeFileSync(join(scfSkills, "demo", "SKILL.md"), "# scf");
  mkdirSync(scfWorkspace, { recursive: true });

  const resolved = await resolveBundleSkillsDir({
    cwd: scfWorkspace,
    runtimePkgRoot: scfRoot,
  });
  assert.equal(resolved, scfSkills);

  const dest = oakSkillDestPath(OAK_WORKSPACE_CWD, "demo");
  assert.equal(dest, "/tmp/workspace/.claude/skills/demo/SKILL.md");

  const result = await materializeManagedSkills(["demo"], {
    bundleSkillsDir: resolved,
    workspaceCwd: join(TMP, "oak-ws-scf"),
  });
  assert.deepEqual(result.materialized, ["demo"]);
  assert.ok(existsSync(join(TMP, "oak-ws-scf", ".claude", "skills", "demo", "SKILL.md")));
});

test("resolveBundleSkillsDir uses cwd/skills for TCBR layout", async () => {
  reset();
  const appRoot = join(TMP, "app");
  const appSkills = join(appRoot, "skills");
  mkdirSync(join(appSkills, "tcbr-skill"), { recursive: true });
  writeFileSync(join(appSkills, "tcbr-skill", "SKILL.md"), "# tcbr");

  const resolved = await resolveBundleSkillsDir({
    cwd: appRoot,
    runtimePkgRoot: appRoot,
  });
  assert.equal(resolved, appSkills);

  const ws = join(TMP, "oak-ws-tcbr");
  const result = await materializeManagedSkills(["tcbr-skill"], {
    bundleSkillsDir: resolved,
    workspaceCwd: ws,
  });
  assert.deepEqual(result.materialized, ["tcbr-skill"]);
  const dest = join(ws, ".claude", "skills", "tcbr-skill", "SKILL.md");
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest, "utf-8"), "# tcbr");
});

test("materialize auto-resolves bundle when cwd differs from deploy root", async () => {
  const skillName = "_oma-auto-resolve-scf";
  const skillDir = join(runtimeRoot, "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# auto");

  const fakeScfCwd = join(TMP, "scf-process-cwd");
  mkdirSync(fakeScfCwd, { recursive: true });
  const prev = process.cwd();
  process.chdir(fakeScfCwd);

  try {
    const bundle = await resolveBundleSkillsDir();
    assert.equal(bundle, join(runtimeRoot, "skills"));

    const ws = join(TMP, "auto-oak-ws");
    const result = await materializeManagedSkills([skillName], { workspaceCwd: ws });
    assert.deepEqual(result.materialized, [skillName]);
    assert.ok(existsSync(join(ws, ".claude", "skills", skillName, "SKILL.md")));
    assert.ok(!existsSync(join(fakeScfCwd, "skills")));
  } finally {
    process.chdir(prev);
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test("materializeManagedSkills copies skill directory", async () => {
  reset();
  const bundle = join(TMP, "bundle", "skills");
  const workspace = join(TMP, "workspace");
  mkdirSync(join(bundle, "foo"), { recursive: true });
  writeFileSync(join(bundle, "foo", "SKILL.md"), "# Foo skill");
  writeFileSync(join(bundle, "foo", "extra.txt"), "asset");

  const result = await materializeManagedSkills(["foo"], {
    bundleSkillsDir: bundle,
    workspaceCwd: workspace,
  });

  assert.deepEqual(result.materialized, ["foo"]);
  assert.deepEqual(result.skipped, []);
  const dest = join(workspace, ".claude", "skills", "foo", "SKILL.md");
  assert.ok(existsSync(dest));
  assert.equal(readFileSync(dest, "utf-8"), "# Foo skill");
  assert.ok(existsSync(join(workspace, ".claude", "skills", "foo", "extra.txt")));
});

test("materializeManagedSkills legacy flat md", async () => {
  reset();
  const bundle = join(TMP, "bundle2", "skills");
  const workspace = join(TMP, "workspace2");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "bar.md"), "# Bar legacy");

  const result = await materializeManagedSkills(["bar"], {
    bundleSkillsDir: bundle,
    workspaceCwd: workspace,
  });

  assert.deepEqual(result.materialized, ["bar"]);
  const dest = join(workspace, ".claude", "skills", "bar", "SKILL.md");
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, "utf-8"), /Bar legacy/);
});

test("materializeManagedSkills skips missing", async () => {
  reset();
  const bundle = join(TMP, "bundle3", "skills");
  mkdirSync(bundle, { recursive: true });
  const result = await materializeManagedSkills(["missing"], {
    bundleSkillsDir: bundle,
    workspaceCwd: join(TMP, "ws3"),
  });
  assert.deepEqual(result.materialized, []);
  assert.deepEqual(result.skipped, ["missing"]);
});
