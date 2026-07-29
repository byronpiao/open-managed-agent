// ── Cloud Run commands ─────────────────────────────────────────────────────────
// Internal commands — not advertised in `magent --help`. They power the
// container deploy path and provide a fast local-build feedback loop.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync, spawnSync } from "child_process";

import { requireEnvId } from "../env.mjs";
import { getNodeExecutable, getTcbScript } from "../tcb.mjs";
import { callTcbCloudApi } from "../api.mjs";
import { toAlias } from "../alias.mjs";
import { resolveCodePath } from "../config.mjs";
import { normalizeAgentRuntime } from "../harness-deploy.mjs";
import { zipDir, describeBuildService, uploadZipBuffer, buildCloudRunEnvParam, waitForCloudRunDeploy } from "../cloudrun.mjs";
import { applySkillsToDeployDir, stampDeployMetadata, confirmManagedSkillDeploy } from "../skills-sync.mjs";
import { withSkillSyncContext, managedLog } from "../managed-logging.mjs";
import { stringify as yamlStringify } from "yaml";
import { dim, green, yellow, red, bold, cyan } from "../ui.mjs";
import { pollAndReportAgentReady } from "../agent-ready.mjs";
import { getAcpUrl, buildPlaygroundUrl } from "../acp.mjs";
import { assertHarnessDeployPreflight } from "../harness-preflight.mjs";

export async function handleCloudrunCreate(options) {
  const { name, model, system } = options;
  if (!name) throw new Error("-n / --name is required");
  const envId = requireEnvId(options);
  const code  = resolveCodePath(options.code);

  // Compose agent config
  const config = {
    name,
    model:  model  ?? "hy3-preview",
    system: system ?? "You are a helpful assistant.",
  };
  if (options.file) {
    try {
      const content = readFileSync(options.file, "utf-8");
      const fileConfig = content.trim().startsWith("{")
        ? JSON.parse(content)
        : (await import("yaml")).parse(content);
      Object.assign(config, fileConfig);
    } catch (err) {
      throw new Error(`Failed to load config file: ${err.message}`);
    }
  }
  if (name)   config.name   = name;
  if (model)  config.model  = model;
  if (system) config.system = system;
  normalizeAgentRuntime(config, { ...options, "agent-runtime": options.agentRuntime });

  if (config.runtime === "harness") {
    try {
      await assertHarnessDeployPreflight({ envId });
    } catch (err) {
      console.error(red(err.message ?? String(err)));
      process.exit(1);
    }
  }

  let deployConfig = config;

  const slug = toAlias(name);
  const rand = Math.random().toString(36).slice(2, 8);
  const serviceName = options.service ?? `${slug}-${rand}`;
  const suggestedAgentId = `agent-${slug}`;

  console.log(bold("Creating cloud-run agent..."));
  console.log(dim(`  name:        ${config.name}`));
  console.log(dim(`  model:       ${typeof config.model === "string" ? config.model : `${config.model?.id ?? "?"}${config.model?.apiBaseUrl ? ` @ ${config.model.apiBaseUrl}` : ""}`}`));
  console.log(dim(`  service:     ${serviceName}`));
  console.log(dim(`  envId:       ${envId}`));
  console.log(dim(`  code:        ${code}`));
  console.log();

  // Stage deploy directory
  const deployDir = resolve(code, ".deploy-cloudrun");
  try {
    execSync(`rm -rf "${deployDir}" && mkdir -p "${deployDir}"`, { encoding: "utf-8" });

    const required = ["Dockerfile", "dist", "package.json"];
    const optional = ["package-lock.json", ".dockerignore", "vendor", "agent.yaml", "skills"];
    for (const f of required) {
      const src = resolve(code, f);
      if (!existsSync(src)) {
        throw new Error(`Required file/dir missing in ${code}: ${f}`);
      }
      execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
    }
    for (const f of optional) {
      const src = resolve(code, f);
      if (existsSync(src)) execSync(`cp -r "${src}" "${deployDir}/"`, { encoding: "utf-8" });
    }

    if (config.runtime !== "harness" && config.skills?.length) {
      const r = await applySkillsToDeployDir(deployDir, config.skills, { configFile: options.file });
      if (r.added.length || r.updated.length || r.removed.length) {
        managedLog({ lane: "skill-sync", operation: "agent:create-tcbr-bundle" }).milestone(
          "install_complete",
          { added: r.added, updated: r.updated, removed: r.removed },
        );
      }
    }
    deployConfig = await stampDeployMetadata(config, { configFile: options.file });
    writeFileSync(resolve(deployDir, "agent.yaml"), yamlStringify(deployConfig), "utf-8");

    writeFileSync(
      resolve(deployDir, "cloudbaserc.json"),
      JSON.stringify({
        version: "2.0",
        envId,
        $schema: "https://framework-1258016615.tcloudbaseapp.com/schema/latest.json",
        cloudrun: { name: serviceName },
      }, null, 2),
    );
  } catch (err) {
    throw new Error(`Deploy prep failed: ${err.message}`);
  }

  const configB64 = Buffer.from(JSON.stringify(deployConfig)).toString("base64");

  // Phase 1: upload code package
  process.stdout.write(dim("Phase 1/3: uploading code package... "));
  let packageName, packageVersion;
  try {
    const { UploadUrl, UploadHeaders, PackageName, PackageVersion } =
      await describeBuildService(envId, serviceName);
    const zip = await zipDir(deployDir);
    await uploadZipBuffer({ uploadUrl: UploadUrl, headers: UploadHeaders, buffer: zip });
    packageName = PackageName;
    packageVersion = PackageVersion;
    console.log(green(`OK (${(zip.length / 1024).toFixed(1)} KiB)`));
  } catch (err) {
    try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}
    throw new Error(`upload failed: ${err.message}`);
  }
  try { execSync(`rm -rf "${deployDir}"`, { encoding: "utf-8" }); } catch {}

  // Phase 2: create the cloudrun service
  process.stdout.write(dim("Phase 2/3: creating cloudrun service... "));
  try {
    const { envMap } = await buildCloudRunEnvParam({ envId, configB64, config: deployConfig });

    await callTcbCloudApi({
      action: "CreateCloudRunServer",
      payload: {
        EnvId: envId,
        ServerName: serviceName,
        DeployInfo: {
          DeployType:    "package",
          PackageName:   packageName,
          PackageVersion: packageVersion,
        },
        Items: [
          { Key: "Port",           IntValue:   8080 },
          { Key: "Dockerfile",     Value:      "Dockerfile" },
          { Key: "HasDockerfile",  BoolValue:  true },
          { Key: "EnvParam",       Value:      JSON.stringify(envMap) },
          { Key: "AccessTypes",    ArrayValue: ["OA", "PUBLIC", "MINIAPP"] },
          { Key: "InternalAccess", Value:      "close" },
          { Key: "CpuSpecs",       FloatValue: 1 },
          { Key: "MemSpecs",       FloatValue: 2 },
          { Key: "LogPath",        Value:      "stdout" },
          { Key: "OperationMode",  Value:      "alwaysScale" },
          { Key: "MinNum",         IntValue:   0 },
          { Key: "MaxNum",         IntValue:   5 },
          { Key: "PolicyDetails",  PolicyDetails: [] },
          { Key: "Cmd",            ArrayValue: [] },
          { Key: "EntryPoint",     ArrayValue: [] },
        ],
        VpcInfo: {},
      },
      service: "tcbr",
      version: "2022-02-17",
    });
    console.log(green("OK"));
  } catch (err) {
    throw new Error(`CreateCloudRunServer failed: ${err.message}`);
  }

  process.stdout.write(dim("            waiting for build to finish... "));
  const lastStatus = await waitForCloudRunDeploy(envId, serviceName);
  if (!lastStatus || lastStatus === "creating" || lastStatus === "deploying") {
    throw new Error(`build still ${lastStatus || "starting"} after timeout`);
  }
  if (lastStatus !== "normal") {
    console.log(yellow(`build status=${lastStatus}, continuing anyway...`));
  } else {
    console.log(green("ready"));
  }

  // Phase 3: register the service as a TCBR agent
  process.stdout.write(dim("Phase 3/3: registering agent (CreateAgent API)... "));
  let createdAgentId;
  try {
    const resp = await callTcbCloudApi({
      action: "CreateAgent",
      payload: {
        EnvId:    envId,
        Name:     config.name,
        AgentId:  suggestedAgentId,
        Avatar:   "https://cloudcache.tencent-cloud.com/qcloud/ui/static/static_source_business/21235b0d-8db2-4e30-b946-3973e6f99c00.png",
        ServiceId: serviceName,
        EnvParams: "",
        AgentType: "tcbr",
        Template:  "alreadyExitResource",
        Source:    "",
      },
    });
    createdAgentId = resp.AgentId;
    console.log(green("OK"));
  } catch (err) {
    throw new Error(`CreateAgent API failed: ${err.message}`);
  }

  console.log();
  console.log(green(`✅ Agent created: ${createdAgentId}`));
  console.log(dim(`  service:    ${serviceName}`));
  console.log(dim(`  envId:      ${envId}`));
  const acpUrl = getAcpUrl({ env: envId, agent: createdAgentId });
  const playgroundUrl = buildPlaygroundUrl(acpUrl, process.env.CLOUDBASE_APIKEY);
  console.log(cyan(`  🔗 Playground: ${playgroundUrl}`));
  console.log();
  console.log("Next steps (container build typically takes 2-5 minutes):");
  await pollAndReportAgentReady({
    envId,
    agentId: createdAgentId,
    wait: options.wait !== false,
    timeoutMs: 5 * 60 * 1000,
  });
  if (deployConfig.skills?.length && deployConfig.runtime !== "harness") {
    await withSkillSyncContext(
      {
        operation: "agent:create-verify",
        envId,
        agentId: createdAgentId,
        agentType: "tcbr",
        serviceId: serviceName,
        skillCount: deployConfig.skills.length,
      },
      async () =>
        confirmManagedSkillDeploy({
          envId,
          agentId: createdAgentId,
          agentType: "tcbr",
          serviceId: serviceName,
          skills: deployConfig.skills,
          stamped: deployConfig,
          agentUrl: acpUrl,
        }),
    );
  }
  console.log(dim(`  1. Start chatting: magent run -a ${createdAgentId} -e ${envId} -m "Hello"`));
  console.log(dim(`  2. Open playground: magent open -a ${createdAgentId} -e ${envId}`));
}

async function handleCloudrunList(options) {
  const envId = requireEnvId(options);
  spawnSync(
    getNodeExecutable(),
    [getTcbScript(), "cloudrun", "list", "-e", envId, "--serverType", "container"],
    { stdio: "inherit" },
  );
}

async function handleCloudrunDelete(options) {
  if (!options.name) throw new Error("-n / --name is required (the cloudrun service name)");
  const envId = requireEnvId(options);
  spawnSync(
    getNodeExecutable(),
    [getTcbScript(), "cloudrun", "delete", "-s", options.name, "-e", envId, "--force"],
    { stdio: "inherit" },
  );
}

export function registerCloudrunCommands(program) {
  program.command("cloudrun:create")
    .description("Create a cloud-run agent (internal)")
    .option("-n, --name <name>", "Agent name (required)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .option("--model <model>", "Model", "hy3-preview")
    .option("--system <prompt>", "System prompt")
    .option("-f, --file <path>", "Load config from YAML/JSON file")
    .option("--code <path>", "Code directory", "./packages/agent-runtime")
    .option("--service <name>", "Override cloudrun service name")
    .option("--agent-runtime <rt>", "Agent loop runtime (harness|managed)")
    .option("--engine <engine>", "Harness engine")
    .action(handleCloudrunCreate);

  program.command("cloudrun:list")
    .description("List cloud-run services (internal)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleCloudrunList);

  program.command("cloudrun:delete")
    .description("Delete a cloud-run service (internal)")
    .option("-n, --name <name>", "Cloudrun service name (required)")
    .option("-e, --env <envId>", "CloudBase environment ID (or set CLOUDBASE_ENV_ID)")
    .action(handleCloudrunDelete);
}
