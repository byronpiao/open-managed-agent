/**
 * Smoke: applySkillsToDeployDir produces skills/<name>/SKILL.md
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "fs";

import { applySkillsToDeployDir } from "../lib/skills-sync.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP = join("/tmp", "oma-smoke-bundle-skills");

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const skillSrc = join(TMP, "cfg", "skills", "demo");
mkdirSync(skillSrc, { recursive: true });
writeFileSync(join(skillSrc, "SKILL.md"), "# Smoke demo");
writeFileSync(join(skillSrc, "note.txt"), "asset");

const agentYaml = join(TMP, "cfg", "agent.yaml");
writeFileSync(
  agentYaml,
  `name: smoke
runtime: managed
skills:
  - name: demo
    source: ./skills/demo
`,
);

const deployDir = join(TMP, "deploy");
mkdirSync(deployDir, { recursive: true });

const result = await applySkillsToDeployDir(
  deployDir,
  [{ name: "demo", source: "./skills/demo" }],
  { configFile: agentYaml },
);

if (!result.added.includes("demo")) {
  console.error("FAIL: demo not in added", result);
  process.exit(1);
}

const skillMd = join(deployDir, "skills", "demo", "SKILL.md");
if (!existsSync(skillMd)) {
  console.error("FAIL: missing", skillMd);
  process.exit(1);
}
if (!existsSync(join(deployDir, "skills", "demo", "note.txt"))) {
  console.error("FAIL: asset not copied");
  process.exit(1);
}
if (!readFileSync(skillMd, "utf-8").includes("Smoke demo")) {
  console.error("FAIL: content mismatch");
  process.exit(1);
}

console.log("smoke-bundle-skills: OK");
