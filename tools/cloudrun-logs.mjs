// Probe: get deploy record + build logs for a TCBR service.
import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";

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
  if (body?.Response?.Error) {
    throw new Error(`${action} ${body.Response.Error.Code}: ${body.Response.Error.Message}`);
  }
  return body?.Response ?? body;
}

const envId = "test-6g2rfs50c69b7fb8";
const serviceName = process.argv[2] || "magtest-rtzay9";

console.log(`\n=== DeployRecord for ${serviceName} ===`);
const dr = await callTcbr("DescribeCloudRunDeployRecord", { EnvId: envId, ServerName: serviceName });
console.log(JSON.stringify(dr, null, 2));

const records = dr?.DeployRecords || [];
if (records.length > 0) {
  const r = records[0];
  console.log(`\n=== ProcessLog for RunId=${r.RunId} ===`);
  try {
    const pl = await callTcbr("DescribeCloudRunProcessLog", { EnvId: envId, RunId: r.RunId });
    console.log(JSON.stringify(pl, null, 2));
  } catch (e) { console.error("ProcessLog failed:", e.message); }

  console.log(`\n=== BuildLog for BuildId=${r.BuildId} ===`);
  try {
    const bl = await callTcbr("DescribeCloudRunServerBuildLog", { EnvId: envId, ServerName: serviceName, BuildId: r.BuildId });
    console.log(JSON.stringify(bl, null, 2).slice(0, 4000));
  } catch (e) { console.error("BuildLog failed:", e.message); }
}
