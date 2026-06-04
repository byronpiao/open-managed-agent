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
import { zipDir, describeBuildService, uploadZipBuffer, buildCloudRunEnvParam, waitForCloudRunDeploy } from "../cloudrun.mjs";
import { dim, green, yellow, red, bold } from "../ui.mjs";

export const cloudrunCommands = {

  "cloudrun:create": async (args) => {
    const { name, model, system } = args;
    if (!name) throw new Error("-n / --name is required");
    const envId = requireEnvId(args);
    const code  = args.code ?? "./packages/agent-runtime";

    // Compose agent config
    const config = {
      name,
      model:  model  ?? "hunyuan-t1-latest",
      system: system ?? "You are a helpful assistant.",
    };
    if (args.file) {
      try {
        const content = readFileSync(args.file, "utf-8");
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

    const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

    const slug = toAlias(name);
    const rand = Math.random().toString(36).slice(2, 8);
    const serviceName = args.service ?? `${slug}-${rand}`;
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
      const { envMap, credsSource } = buildCloudRunEnvParam({ envId, configB64 });
      if (!credsSource) {
        console.log();
        console.log(yellow("⚠️  no TCB_SECRET_* found in shell or tcb login — agent may fail with MISSING_CREDENTIALS"));
        process.stdout.write(dim("            "));
      } else if (credsSource === "sts") {
        console.log();
        process.stdout.write(dim("            (warning: forwarded short-lived STS creds; will expire in ~2h)\n            "));
      }

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
    console.log();
    console.log("Next steps (container build typically takes 2-5 minutes):");
    console.log(dim(`  1. Wait for ready: tcb agent detail ${createdAgentId} -e ${envId}`));
    console.log(dim(`  2. Start chatting: magent run -a ${createdAgentId} -e ${envId} -m "Hello"`));
  },

  "cloudrun:list": async (args) => {
    const envId = requireEnvId(args);
    spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "cloudrun", "list", "-e", envId, "--serverType", "container"],
      { stdio: "inherit" },
    );
  },

  "cloudrun:delete": async (args) => {
    if (!args.name) throw new Error("-n / --name is required (the cloudrun service name)");
    const envId = requireEnvId(args);
    spawnSync(
      getNodeExecutable(),
      [getTcbScript(), "cloudrun", "delete", "-s", args.name, "-e", envId, "--force"],
      { stdio: "inherit" },
    );
  },
};
