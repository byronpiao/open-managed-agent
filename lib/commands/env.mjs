// ── Environment commands ──────────────────────────────────────────────────────

import { spawnSync } from "child_process";
import { getNodeExecutable, getTcbScript } from "../tcb.mjs";
import { post, del } from "../api.mjs";
import { green } from "../ui.mjs";
import { printEnv } from "../ui.mjs";

async function handleEnvList(options) {
  // Forward all unknown args to tcb env:list
  const rawIdx = process.argv.indexOf("env:list");
  const rest = rawIdx >= 0 ? process.argv.slice(rawIdx + 1) : [];
  spawnSync(getNodeExecutable(), [getTcbScript(), "env:list", ...rest], { stdio: "inherit" });
}

async function handleEnvCreate(options) {
  if (!options.name) throw new Error("--name is required");
  const env = await post("/environments", {
    name:   options.name,
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  console.log(green("✅ Environment created:"));
  printEnv(env);
}

async function handleEnvDelete(options) {
  if (!options.id) throw new Error("-i / --id is required");
  await del(`/environments/${options.id}`);
  console.log(green(`✅ Environment ${options.id} deleted.`));
}

export function registerEnvCommands(program) {
  program.command("env:list")
    .description("List CloudBase environments (proxied to tcb)")
    .allowUnknownOption()
    .action(handleEnvList);

  program.command("env:create")
    .description("Create a new environment")
    .option("--name <name>", "Environment name (required)")
    .action(handleEnvCreate);

  program.command("env:delete")
    .description("Delete an environment")
    .option("-i, --id <id>", "Environment ID (required)")
    .action(handleEnvDelete);
}
