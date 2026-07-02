// ── Skill 同步逻辑（managed 部署包）────────────────────────────────────────

import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { resolve, join, dirname, basename, extname } from "path";
import { createHash } from "crypto";

import {
  resolveSkillArtifacts,
  copySkillDirToDeploy,
  isValidSkillDir,
  readInstallManifest,
  writeInstallManifest,
  MANIFEST_FILE,
} from "./skill-sources.mjs";
import { tmpdir } from "os";
import { downloadScfCode, downloadCloudRunCode } from "./tcb.mjs";
import { callTcbCloudApi } from "./api.mjs";
import { dim, green, yellow, red } from "./ui.mjs";
import {
  skillSyncPhase,
  skillSyncMilestone,
  skillSyncLog,
  managedTrace,
  managedLog,
} from "./managed-logging.mjs";

/**
 * 从本地 agent.yaml 加载 skill 配置
 */
export async function loadLocalSkillConfig(yamlPath) {
  let configPath = yamlPath;
  if (!configPath) {
    const candidates = [
      join(process.cwd(), "agent.yaml"),
      join(process.cwd(), "agent.yml"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        configPath = c;
        break;
      }
    }
  }

  if (!configPath || !existsSync(configPath)) {
    throw new Error(
      "agent.yaml not found. Specify with -f <path> or create agent.yaml in current directory.",
    );
  }

  const content = readFileSync(configPath, "utf-8");
  let config;
  if (content.trim().startsWith("{")) {
    config = JSON.parse(content);
  } else {
    const yaml = await import("yaml");
    config = yaml.parse(content);
  }

  return {
    skills: config.skills || [],
    configPath,
    configDir: dirname(configPath),
    runtime: config.runtime ?? "managed",
    fullConfig: config,
  };
}

/**
 * @param {string} skillsDir - skills/ 目录本身
 */
export function listSkillNamesInDir(skillsDir) {
  if (!existsSync(skillsDir)) return [];

  const names = new Set();
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE || entry.name.startsWith(".")) continue;
    if (entry.isDirectory() && isValidSkillDir(join(skillsDir, entry.name))) {
      names.add(entry.name);
      continue;
    }
    if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
      names.add(basename(entry.name, extname(entry.name)));
    }
  }
  return [...names];
}

/**
 * 列出部署代码中已有的 skills
 */
export function listSkillsInDeployedCode(codeDir) {
  return listSkillNamesInDir(resolve(codeDir, "skills"));
}

function hashSkillDir(dir) {
  if (!existsSync(dir)) return null;
  const hash = createHash("sha256");
  const walk = (current, prefix = "") => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      const rel = `${prefix}${e.name}`;
      const fp = join(current, e.name);
      if (e.isDirectory()) {
        hash.update(`d:${rel}\n`);
        walk(fp, `${rel}/`);
      } else if (e.isFile()) {
        hash.update(`f:${rel}\n`);
        hash.update(readFileSync(fp));
      }
    }
  };

  if (statSync(dir).isFile()) {
    hash.update(readFileSync(dir));
    return hash.digest("hex");
  }
  walk(dir);
  return hash.digest("hex");
}

function hashDeployedSkill(skillsDir, name) {
  const dir = join(skillsDir, name);
  if (existsSync(dir) && statSync(dir).isDirectory()) {
    return hashSkillDir(dir);
  }
  for (const ext of [".md", ".txt"]) {
    const fp = join(skillsDir, name + ext);
    if (existsSync(fp)) return hashSkillDir(fp);
  }
  return null;
}

/** Content hashes for skills/ in a deploy directory (SCF verify + metadata). */
export function hashSkillsInDeployDir(deployDir, skillNames) {
  const skillsDir = join(deployDir, "skills");
  const hashes = {};
  for (const name of skillNames ?? []) {
    if (!name) continue;
    const h = hashDeployedSkill(skillsDir, name);
    if (h) hashes[name] = h;
  }
  return hashes;
}

/**
 * Poll cloud code download until deployed skills/ hashes match expected.
 * @param {{ download: (destDir: string) => void | Promise<void>, expectedHashes: Record<string, string>, label?: string, maxWaitMs?: number, intervalMs?: number }} opts
 */
export async function waitForSkillPackageLive({
  download,
  expectedHashes,
  label = "skill",
  maxWaitMs = 3 * 60 * 1000,
  intervalMs = 5000,
}) {
  const names = Object.keys(expectedHashes ?? {});
  if (!names.length) return true;

  const verifyDir = join(tmpdir(), `magent-skill-verify-${label}-${Date.now()}`);
  const startedAt = Date.now();

  skillSyncPhase("verify_package_start", {
    agentType: label.startsWith("scf") ? "scf" : "tcbr",
    skillCount: names.length,
  });

  try {
    while (Date.now() - startedAt < maxWaitMs) {
      try {
        if (existsSync(verifyDir)) rmSync(verifyDir, { recursive: true, force: true });
        mkdirSync(verifyDir, { recursive: true });
        await download(verifyDir);
        const live = hashSkillsInDeployDir(verifyDir, names);
        if (names.every((n) => live[n] && live[n] === expectedHashes[n])) {
          skillSyncMilestone("verify_package_ok", {
            elapsedMs: Date.now() - startedAt,
            skillCount: names.length,
          });
          return true;
        }
        managedTrace("skill-sync.verify_poll", {
          label,
          elapsedMs: Date.now() - startedAt,
          matched: names.filter((n) => live[n] === expectedHashes[n]).length,
          total: names.length,
        });
      } catch (err) {
        managedTrace("skill-sync.verify_poll_error", {
          label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    skillSyncPhase("verify_package_timeout", {
      label,
      elapsedMs: Date.now() - startedAt,
      maxWaitMs,
    });
    return false;
  } finally {
    try { rmSync(verifyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function waitForManagedAgentLive(agentUrl, stampedConfig, { initialDelayMs, maxWaitMs } = {}) {
  if (!agentUrl || !stampedConfig?.metadata?.__deployedAt) return true;
  const { waitForConfigLive } = await import("./cloudrun.mjs");
  return waitForConfigLive({
    agentUrl,
    expectedDeployedAt: stampedConfig.metadata.__deployedAt,
    expectedSkillHashes: stampedConfig.metadata.__skillHashes,
    initialDelayMs,
    maxWaitMs,
  });
}

/** Post-deploy: wait for package propagation + live initialize (cold start). */
export async function confirmManagedSkillDeploy({
  envId,
  agentId,
  agentType,
  serviceId,
  codeDir,
  skills,
  stamped,
  agentUrl,
}) {
  const skillNames = (skills ?? []).map((s) => s.name).filter(Boolean);
  const expectedHashes = stamped?.metadata?.__skillHashes;

  skillSyncPhase("confirm_deploy_start", {
    agentType,
    agentId,
    serviceId,
    skillCount: skillNames.length,
  });

  if (agentType === "scf" && skillNames.length && codeDir) {
    process.stdout.write(dim("  Verifying SCF skill package... "));
    const expected = hashSkillsInDeployDir(codeDir, skillNames);
    const pkgOk = await waitForSkillPackageLive({
      download: (dir) => downloadScfCode(envId, agentId, dir),
      expectedHashes: expected,
      label: `scf-${agentId}`,
    });
    if (!pkgOk) {
      console.log(red("timeout"));
      skillSyncLog()?.error(new Error("SCF skill package verification timed out"), {
        phase: "verify_package",
        agentType: "scf",
      });
      throw new Error("SCF skill package verification timed out");
    }
    console.log(green("OK"));
  } else if (agentType === "tcbr" && serviceId && expectedHashes && Object.keys(expectedHashes).length) {
    process.stdout.write(dim("  Verifying TCBR skill package... "));
    const pkgOk = await waitForSkillPackageLive({
      download: (dir) => downloadCloudRunCode(envId, serviceId, dir),
      expectedHashes,
      label: `tcbr-${serviceId}`,
    });
    if (!pkgOk) {
      console.log(red("timeout"));
      skillSyncLog()?.error(new Error("TCBR skill package verification timed out"), {
        phase: "verify_package",
        agentType: "tcbr",
      });
      throw new Error("TCBR skill package verification timed out");
    }
    console.log(green("OK"));
  }

  if (agentUrl) {
    skillSyncPhase("verify_live_start", { agentType });
    process.stdout.write(dim("  Waiting for live agent (cold start)... "));
    const live = await waitForManagedAgentLive(agentUrl, stamped, {
      initialDelayMs: agentType === "scf" ? 10_000 : 20_000,
      maxWaitMs: 3 * 60 * 1000,
    });
    if (!live) {
      console.log(red("timeout"));
      skillSyncLog()?.error(new Error("Agent did not become live after skill deploy"), {
        phase: "verify_live",
        agentType,
      });
      throw new Error("Agent did not become live after skill deploy");
    }
    console.log(green("ready"));
    skillSyncMilestone("confirm_deploy_ok", { agentType, skillCount: skillNames.length });
  }
}

function removeDeployedSkill(skillsDir, name) {
  const dir = join(skillsDir, name);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    return true;
  }
  let removed = false;
  for (const ext of [".md", ".txt"]) {
    const fp = join(skillsDir, name + ext);
    if (existsSync(fp)) {
      rmSync(fp);
      removed = true;
    }
  }
  return removed;
}

function removeBundleSkills(skillsDir, manifest, bundleKey) {
  const bundle = manifest.bundles?.[bundleKey];
  if (!bundle?.installed?.length) return [];
  const removed = [];
  for (const name of bundle.installed) {
    if (removeDeployedSkill(skillsDir, name)) removed.push(name);
  }
  delete manifest.bundles[bundleKey];
  return removed;
}

/**
 * @param {Array} currentSkills
 * @param {Array} newSkills
 * @param {{ forceSync?: boolean }} opts
 */
export function skillsChanged(currentSkills, newSkills, { forceSync = false } = {}) {
  if (forceSync) return true;
  const norm = (arr) =>
    JSON.stringify(
      (arr ?? []).map((s) => ({ name: s.name, source: s.source ?? null })),
    );
  return norm(currentSkills) !== norm(newSkills);
}

/**
 * Hash skill sources from local yaml (for change detection vs deployed metadata).
 */
export async function computeSkillContentHashes(
  skills,
  { configDir, cwd = process.cwd(), cloneGitRepo, fetchImpl } = {},
) {
  if (!skills?.length || !configDir) return {};
  const tempParent = join(tmpdir(), `magent-skill-hash-${Date.now()}-`);
  mkdirSync(tempParent, { recursive: true });
  const hashes = {};
  const ctx = { configDir, cwd, tempParent, cloneGitRepo, fetchImpl };
  const tempsToClean = new Set();

  try {
    for (const skill of skills) {
      const artifacts = await resolveSkillArtifacts(skill, ctx);
      for (const art of artifacts) {
        if (art.tempRoot) tempsToClean.add(art.tempRoot);
        hashes[art.destName] = hashSkillDir(art.skillDir);
      }
    }
  } finally {
    for (const t of tempsToClean) {
      try { rmSync(t, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try { rmSync(tempParent, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return hashes;
}

/** Stamp deploy metadata used by waitForConfigLive and skill change detection. */
export async function stampDeployMetadata(config, { configFile } = {}) {
  const metadata = {
    ...(config.metadata ?? {}),
    __deployedAt: String(Date.now()),
  };
  if (config.runtime !== "harness" && config.skills?.length && configFile) {
    const configDir = dirname(resolve(configFile));
    metadata.__skillHashes = await computeSkillContentHashes(config.skills, { configDir });
    skillSyncMilestone("stamp_metadata", {
      deployedAt: metadata.__deployedAt,
      skillHashCount: Object.keys(metadata.__skillHashes ?? {}).length,
      skillNames: Object.keys(metadata.__skillHashes ?? {}),
    });
  }
  return { ...config, metadata };
}

/**
 * Whether managed skill sync is needed (yaml list and/or local file content).
 */
export async function skillsNeedSync({
  currentSkills,
  newSkills,
  currentConfig,
  configFile,
  cloneGitRepo,
  fetchImpl,
}) {
  const prev = currentSkills ?? [];
  const next = newSkills ?? [];
  if (next.length === 0) return prev.length > 0;
  if (skillsChanged(prev, next)) {
    skillSyncPhase("detect_need_sync", { reason: "yaml_list_or_source_changed" });
    return true;
  }
  if (!configFile) return false;

  const deployed = currentConfig?.metadata?.__skillHashes;
  if (!deployed || typeof deployed !== "object") {
    skillSyncPhase("detect_need_sync", { reason: "missing_deployed_hashes" });
    return true;
  }

  const configDir = dirname(resolve(configFile));
  const localHashes = await computeSkillContentHashes(next, {
    configDir,
    cloneGitRepo,
    fetchImpl,
  });
  const keys = new Set([...Object.keys(deployed), ...Object.keys(localHashes)]);
  for (const name of keys) {
    if (localHashes[name] !== deployed[name]) {
      skillSyncPhase("detect_need_sync", {
        reason: "hash_mismatch",
        skill: name,
        deployedHash: deployed[name]?.slice(0, 12),
        localHash: localHashes[name]?.slice(0, 12),
      });
      return true;
    }
  }
  skillSyncPhase("detect_skip", { skillCount: next.length, hashKeys: keys.size });
  return false;
}

/**
 * @param {Array} desiredSkills
 * @param {string} deployedSkillsDir
 * @param {{ configDir: string, cwd?: string }} opts
 */
export async function syncSkillsInDir(desiredSkills, deployedSkillsDir, opts = {}) {
  const result = { added: [], removed: [], updated: [] };
  const configDir = opts.configDir ?? process.cwd();
  const cwd = opts.cwd ?? process.cwd();

  skillSyncPhase("install_start", {
    desiredCount: desiredSkills?.length ?? 0,
    deployDir: deployedSkillsDir,
  });

  mkdirSync(deployedSkillsDir, { recursive: true });

  const manifest = readInstallManifest(deployedSkillsDir);
  const desiredNames = new Set(desiredSkills.map((s) => s.name));

  // Remove bundle-installed skills when bundle row removed from YAML
  for (const bundleKey of Object.keys(manifest.bundles ?? {})) {
    if (!desiredNames.has(bundleKey)) {
      const removed = removeBundleSkills(deployedSkillsDir, manifest, bundleKey);
      result.removed.push(...removed);
    }
  }

  const existingBefore = listSkillNamesInDir(deployedSkillsDir);
  for (const name of existingBefore) {
    if (!desiredNames.has(name)) {
      if (removeDeployedSkill(deployedSkillsDir, name)) {
        result.removed.push(name);
      }
    }
  }

  const ctx = {
    configDir,
    cwd,
    tempParent: join(deployedSkillsDir, ".tmp"),
    cloneGitRepo: opts.cloneGitRepo,
    fetchImpl: opts.fetchImpl,
  };
  mkdirSync(ctx.tempParent, { recursive: true });

  for (const skill of desiredSkills) {
    console.log(`  Processing skill '${skill.name}'...`);
    const sourceKind = skill.source?.trim()
      ? (skill.source.startsWith("git:")
        ? "git"
        : skill.source.startsWith("skillhub:")
          ? "skillhub"
          : skill.source.startsWith("skills.sh:")
            ? "skillssh"
            : "local")
      : "default";
    skillSyncPhase("install_skill_start", {
      skill: skill.name,
      sourceKind,
      hasSource: Boolean(skill.source?.trim()),
    });
    const tempsToClean = new Set();

    try {
      const artifacts = await resolveSkillArtifacts(skill, ctx);
      for (const art of artifacts) {
        if (art.tempRoot) tempsToClean.add(art.tempRoot);

        const destName = art.destName;
        const destPath = join(deployedSkillsDir, destName);
        const existed = hashDeployedSkill(deployedSkillsDir, destName) !== null;
        const oldHash = hashDeployedSkill(deployedSkillsDir, destName);

        copySkillDirToDeploy(art.skillDir, deployedSkillsDir, destName);
        const newHash = hashDeployedSkill(deployedSkillsDir, destName);

        if (!existed) result.added.push(destName);
        else if (oldHash !== newHash) result.updated.push(destName);

        skillSyncPhase("install_skill_artifact", {
          skill: destName,
          bundleKey: art.bundleKey,
          action: !existed ? "added" : oldHash !== newHash ? "updated" : "unchanged",
          hash: newHash?.slice(0, 12),
        });

        if (art.bundleKey) {
          manifest.bundles ??= {};
          const prev = manifest.bundles[art.bundleKey]?.installed ?? [];
          const installed = [...new Set([...prev, destName])];
          manifest.bundles[art.bundleKey] = {
            source: skill.source.slice(4),
            installed,
          };
        }
      }
    } catch (err) {
      console.warn(yellow(`    ⚠️  ${err.message}`));
      skillSyncLog()?.error(err, { phase: "install_skill", skill: skill.name });
      throw err;
    } finally {
      for (const t of tempsToClean) {
        try {
          rmSync(t, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    }
  }

  writeInstallManifest(deployedSkillsDir, manifest);

  // Clean unused bundle keys still in manifest but not in yaml names
  for (const key of Object.keys(manifest.bundles ?? {})) {
    if (!desiredNames.has(key)) {
      removeBundleSkills(deployedSkillsDir, manifest, key);
    }
  }

  skillSyncMilestone("install_complete", {
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    deployedSkills: listSkillNamesInDir(deployedSkillsDir),
  });

  return result;
}

/**
 * create/update 共用
 */
export async function applySkillsToDeployDir(deployDir, skills, { configFile } = {}) {
  if (!skills?.length) return { added: [], removed: [], updated: [] };
  const configDir = configFile ? dirname(resolve(configFile)) : deployDir;
  const deployedSkillsDir = join(deployDir, "skills");
  mkdirSync(deployedSkillsDir, { recursive: true });
  return syncSkillsInDir(skills, deployedSkillsDir, {
    configDir,
    cwd: process.cwd(),
  });
}

/** SCF code download uses agentId (function name); TCBR uses cloudrun serviceId. */
export function resolveDeployDownloadTarget(agentType, agentId, serviceId) {
  if (agentType === "scf") {
    if (!agentId) throw new Error("agentId is required for SCF code download");
    return agentId;
  }
  if (agentType === "tcbr") {
    if (!serviceId) throw new Error("serviceId is required for TCBR code download");
    return serviceId;
  }
  throw new Error(`Unsupported agent type: ${agentType}`);
}

export async function downloadDeployedCode(envId, agentType, destDir, { agentId, serviceId } = {}) {
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });

  const target = resolveDeployDownloadTarget(agentType, agentId, serviceId);
  skillSyncPhase("pull_start", { agentType, downloadTarget: target, destDir });

  const pullStarted = Date.now();
  try {
    if (agentType === "scf") {
      downloadScfCode(envId, target, destDir);
    } else if (agentType === "tcbr") {
      downloadCloudRunCode(envId, target, destDir);
    } else {
      throw new Error(`Unsupported agent type: ${agentType}`);
    }
    skillSyncMilestone("pull_ok", {
      agentType,
      downloadTarget: target,
      elapsedMs: Date.now() - pullStarted,
      skillsPresent: listSkillNamesInDir(join(destDir, "skills")),
    });
  } catch (err) {
    skillSyncLog()?.error(err, { phase: "pull", agentType, downloadTarget: target });
    throw err;
  }

  return destDir;
}

export async function redeployCloudRunWithEnv(
  envId,
  serviceId,
  codeDir,
  mergedConfig,
  agentUrl,
  { configFile, skipLiveVerify = false } = {},
) {
  const configWithTs = await stampDeployMetadata(mergedConfig, { configFile });
  const expectedDeployedAt = configWithTs.metadata.__deployedAt;

  skillSyncPhase("redeploy_start", { serviceId, agentType: "tcbr" });

  const { uploadCloudRunSourcePackage, buildImageViaCloudRun, buildCloudRunEnvParam, waitForCloudRunDeploy, waitForConfigLive } =
    await import("./cloudrun.mjs");
  const pkg = await uploadCloudRunSourcePackage(envId, serviceId, codeDir);

  console.log(dim("  Rebuilding container image..."));
  const buildServiceName = `${serviceId}-imgbuild`;
  const result = await buildImageViaCloudRun({ envId, code: codeDir, serviceName: buildServiceName });
  const imageUri = result.imageUri;
  console.log(dim(`  Image: ${imageUri}`));

  const configBase64 = Buffer.from(JSON.stringify(configWithTs)).toString("base64");
  const { envMap } = await buildCloudRunEnvParam({ envId, configB64: configBase64, config: configWithTs });

  const submitResp = await callTcbCloudApi({
    action: "SubmitServerConfigChangeDiff",
    payload: {
      EnvId: envId,
      ServerName: serviceId,
      Items: [
        { Key: "ImageUri", Value: imageUri },
        { Key: "EnvParam", Value: JSON.stringify(envMap) },
        { Key: "PackageName", Value: pkg.packageName },
        { Key: "PackageVersion", Value: pkg.packageVersion },
      ],
    },
    service: "tcbr",
    version: "2022-02-17",
  });
  console.log(dim(`  submitted (TaskId=${submitResp.TaskId})`));
  skillSyncPhase("redeploy_submitted", { taskId: submitResp.TaskId, imageUri });

  process.stdout.write(dim("  Waiting for new version to deploy... "));
  const finalStatus = await waitForCloudRunDeploy(envId, serviceId);
  console.log(finalStatus === "normal" ? green("ready") : yellow(`status=${finalStatus || "timeout"}`));
  skillSyncMilestone("redeploy_build_ok", { serviceId, finalStatus, imageUri });

  if (agentUrl && !skipLiveVerify) {
    process.stdout.write(dim("  Waiting for traffic switchover... "));
    const matched = await waitForConfigLive({
      agentUrl,
      expectedDeployedAt,
      expectedSkillHashes: configWithTs.metadata.__skillHashes,
      maxWaitMs: 5 * 60 * 1000,
    });
    if (!matched) {
      console.log(red("timeout"));
      throw new Error("TCBR config did not become live after redeploy");
    }
    console.log(green("done"));
  }
}
