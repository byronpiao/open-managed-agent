// One-off helper: push EnvParams to a service via SubmitServerConfigChangeDiff.
import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";
import { loadProjectEnv } from "../scripts/env.mjs";
import { loadEnv as loadHarnessEnv } from "../scripts/harness/load-env.mjs";

loadProjectEnv();
try {
  loadHarnessEnv();
} catch {
  /* harness overlay optional for this tool */
}

const _require = createRequire(import.meta.url);
const { sign } = _require("@cloudbase/signature-nodejs");
const home = process.env.HOME;
const c = JSON.parse(readFileSync(resolve(home, ".config/.cloudbase/auth.json"), "utf-8")).credential;

async function callTcbr(action, payload) {
  const host = "tcbr.tencentcloudapi.com";
  const url = `https://${host}/`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": "2022-02-17",
    "X-TC-Region": "ap-shanghai",
    ...(c.tmpToken ? { "X-TC-Token": c.tmpToken } : {}),
  };
  const ts = Math.floor(Date.now() / 1000) - 1;
  const { authorization } = sign({
    secretId: c.tmpSecretId, secretKey: c.tmpSecretKey,
    method: "POST", url, headers, params: payload, timestamp: ts,
    withSignedParams: false, isCloudApi: true, service: "tcbr",
  });
  headers["Authorization"] = authorization;
  headers["X-TC-Timestamp"] = String(ts);
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (body?.Response?.Error) throw new Error(`${action} ${body.Response.Error.Code}: ${body.Response.Error.Message}`);
  return body?.Response ?? body;
}

const envId = process.env.CLOUDBASE_ENV_ID?.trim();
const serviceName = process.argv[2] || "magtest-v2";
// .env.harness overlays .env — prefer LLM_API_KEY so token matches ANTHROPIC_BASE_URL.
const anthropicToken =
  process.env.LLM_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim();
const anthropicBase = process.env.ANTHROPIC_BASE_URL?.trim();
const model = process.env.LLM_MODEL?.trim() || process.env.AGENT_MODEL?.trim() || "mimo-v2.5-pro";

if (!envId) {
  console.error("Missing CLOUDBASE_ENV_ID — set in .env or export before running.");
  process.exit(1);
}
if (!anthropicToken || !anthropicBase) {
  console.error(
    "Missing LLM creds — set ANTHROPIC_AUTH_TOKEN (or LLM_API_KEY) and ANTHROPIC_BASE_URL in .env / .env.harness.",
  );
  process.exit(1);
}

const config = { name: "magtest", model, system: "You are a helpful assistant." };
const configB64 = Buffer.from(JSON.stringify(config)).toString("base64");

const envMap = {
  CLOUDBASE_ENV_ID: envId,
  AGENT_CONFIG_B64: configB64,
  ANTHROPIC_BASE_URL: anthropicBase,
  ANTHROPIC_AUTH_TOKEN: anthropicToken,
  AGENT_MODEL: model,
  OAK_DISABLE_SANDBOX: "1",
  OAK_USE_MEMORY_STORE: "1",
};

console.log("Submitting EnvParam change for", serviceName);
const r = await callTcbr("SubmitServerConfigChangeDiff", {
  EnvId: envId,
  ServerName: serviceName,
  Items: [{ Key: "EnvParam", Value: JSON.stringify(envMap) }],
});
console.log(JSON.stringify(r, null, 2));
