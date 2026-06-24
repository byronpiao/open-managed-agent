// ── magent init ──────────────────────────────────────────────────────────────
// Download or update the OMA template to ~/.magent, then build runtime.

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { MAGENT_DIR } from "../config.mjs";
import { dim, green, bold, red } from "../ui.mjs";

const REPO_URL = "https://github.com/yhsunshining/open-managed-agent.git";

export function registerInitCommand(program) {
  program
    .command("init")
    .description("Download or update the OMA template to ~/.magent (clone + build)")
    .option("--ref <ref>", "Git ref to check out", "main")
    .action((options) => handleInit(options));
}

async function handleInit(options) {
  const ref = options.ref ?? "main";

  console.log(bold("magent init"));
  console.log(dim(`  target: ${MAGENT_DIR}`));
  console.log(dim(`  ref:    ${ref}`));
  console.log();

  if (existsSync(`${MAGENT_DIR}/.git`)) {
    console.log(dim("Updating existing clone ..."));
    execSync(`git -C "${MAGENT_DIR}" fetch origin`, { stdio: "inherit" });
    execSync(`git -C "${MAGENT_DIR}" checkout "${ref}"`, { stdio: "inherit" });
    try {
      execSync(`git -C "${MAGENT_DIR}" pull --ff-only origin "${ref}"`, { stdio: "inherit" });
    } catch {
      // pull may fail on dirty trees; non-fatal
    }
  } else if (existsSync(MAGENT_DIR)) {
    console.error(red(`${MAGENT_DIR} exists but is not a git repo — remove it first.`));
    process.exit(1);
  } else {
    console.log(dim(`Cloning ${REPO_URL} ...`));
    execSync(`git clone --depth 1 --branch "${ref}" "${REPO_URL}" "${MAGENT_DIR}"`, { stdio: "inherit" });
  }

  console.log();
  console.log(dim("Installing dependencies ..."));
  execSync("npm install", { cwd: MAGENT_DIR, stdio: "inherit" });

  console.log();
  console.log(dim("Building runtime ..."));
  execSync("npm run build:runtime", { cwd: MAGENT_DIR, stdio: "inherit" });

  console.log();
  console.log(green(`${bold("✓")} Template ready at ${MAGENT_DIR}/packages/agent-runtime`));
  console.log(dim(`  agent:create will now find code automatically.`));
}
