// ── Environment commands ──────────────────────────────────────────────────────

import { spawnSync } from "child_process";
import { getNodeExecutable, getTcbScript } from "../tcb.mjs";
import { post, del } from "../api.mjs";
import { green } from "../ui.mjs";
import { printEnv } from "../ui.mjs";

export const envCommands = {

  // env:list proxies to `tcb env:list`
  "env:list": async (args, rest) => {
    spawnSync(getNodeExecutable(), [getTcbScript(), "env:list", ...rest], { stdio: "inherit" });
  },

  "env:create": async (args) => {
    if (!args.name) throw new Error("--name is required");
    const env = await post("/environments", {
      name:   args.name,
      config: { type: "cloud", networking: { type: "unrestricted" } },
    });
    console.log(green("✅ Environment created:"));
    printEnv(env);
  },

  "env:delete": async (args) => {
    if (!args.id) throw new Error("-i / --id is required");
    await del(`/environments/${args.id}`);
    console.log(green(`✅ Environment ${args.id} deleted.`));
  },
};
