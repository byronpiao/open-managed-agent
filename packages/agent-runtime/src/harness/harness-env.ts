/**
 * Harness 宿主机 env 解析与校验。
 * 除 HARNESS_PUBLIC_MAGENT_IMAGE 外不设兜底魔法值。
 */

import { resolveAnthropicApiKeyFromEnv } from "./llm-providers.js";

/** 唯一允许内置的默认：公开 CCR magent 镜像（可用 HARNESS_SANDBOX_IMAGE 覆盖）。 */
export const HARNESS_PUBLIC_MAGENT_IMAGE =
  "ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d:260609-1950-68a1e7-magent";

export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    const suffix = hint ? ` (${hint})` : "";
    throw new Error(`Missing required env ${name}${suffix}`);
  }
  return value;
}

export function resolveHarnessSandboxImage(): string {
  return process.env.HARNESS_SANDBOX_IMAGE?.trim() || HARNESS_PUBLIC_MAGENT_IMAGE;
}

/** AGS instance auth — production uses TOKEN (sit_* via X-Access-Token); NONE is debug-only. */
export function resolveHarnessSandboxAuthMode(): "TOKEN" | "NONE" {
  const raw = process.env.HARNESS_SANDBOX_AUTH_MODE?.trim().toUpperCase();
  if (raw === "NONE") return "NONE";
  return "TOKEN";
}

/** CreateSandboxTool RoleArn — 必须显式配置，禁止写死测试 UIN。 */
export function resolveHarnessToolRoleArn(): string {
  return requireEnv(
    "HARNESS_TOOL_ROLE_ARN",
    "e.g. qcs::cam::uin/<uin>:roleName/agent-sandbox",
  );
}

/** CloudBase / COS SDK region（有 DB 凭证时必填）。 */
export function resolveTcbRegion(): string {
  return requireEnv("TCB_REGION", "e.g. ap-shanghai");
}

export function missingHarnessCloudCreds(): string[] {
  const missing: string[] = [];
  if (!process.env.CLOUDBASE_ENV_ID?.trim() && !process.env.TCB_ENV_ID?.trim()) {
    missing.push("CLOUDBASE_ENV_ID");
  }
  if (
    !process.env.TCB_SECRET_ID?.trim() &&
    !process.env.TENCENTCLOUD_SECRETID?.trim()
  ) {
    missing.push("TCB_SECRET_ID");
  }
  if (
    !process.env.TCB_SECRET_KEY?.trim() &&
    !process.env.TENCENTCLOUD_SECRETKEY?.trim()
  ) {
    missing.push("TCB_SECRET_KEY");
  }
  return missing;
}

export function assertHarnessCloudCreds(): void {
  const missing = missingHarnessCloudCreds();
  if (missing.length) {
    throw new Error(
      `Missing CloudBase credentials: ${missing.join(", ")}. cp .env.example .env`,
    );
  }
}

const LLM_REQUIRED = ["LLM_API_KEY", "LLM_MODEL", "OPENAI_BASE_URL"] as const;

export function missingHarnessLlmEnv(): string[] {
  return LLM_REQUIRED.filter((k) => !process.env[k]?.trim());
}

export function assertHarnessLlmEnv(): void {
  const missing = missingHarnessLlmEnv();
  if (missing.length) {
    throw new Error(
      `Missing LLM env for live harness: ${missing.join(", ")}. See .env.harness.example`,
    );
  }
}

/** Host has custom OpenAI-compatible provider (Mimo tp/sk, etc.). */
export function hasHarnessCustomLlmEnv(): boolean {
  return missingHarnessLlmEnv().length === 0;
}

const ANTHROPIC_LLM_HINT = "LLM_API_KEY";

/** Claude / Mimo Anthropic Messages (engine=claude). */
export function missingHarnessAnthropicLlmEnv(): string[] {
  const missing: string[] = [];
  if (!resolveAnthropicApiKeyFromEnv()) missing.push(ANTHROPIC_LLM_HINT);
  if (!process.env.LLM_MODEL?.trim()) missing.push("LLM_MODEL");
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) missing.push("ANTHROPIC_BASE_URL");
  return missing;
}

export function hasHarnessAnthropicLlmEnv(): boolean {
  return missingHarnessAnthropicLlmEnv().length === 0;
}

export function assertHarnessAnthropicLlmEnv(): void {
  const missing = missingHarnessAnthropicLlmEnv();
  if (missing.length) {
    throw new Error(
      `Missing Anthropic LLM env for claude harness: ${missing.join(", ")}. See .env.harness.example`,
    );
  }
}

/** Custom LLM suite: CloudBase + LLM_* (probe / hitl / Mimo pong). Not required for test:full. */
export function assertHarnessLlmSuiteEnv(): void {
  assertHarnessCloudCreds();
  assertHarnessLlmEnv();
  if (!process.env.TCB_REGION?.trim()) {
    throw new Error("Missing TCB_REGION (e.g. ap-shanghai) for CloudBase data stores");
  }
}

const COS_REQUIRED = [
  "HARNESS_COS_BUCKET",
  "HARNESS_COS_BUCKET_PATH",
  "HARNESS_COS_ENDPOINT",
  "HARNESS_COS_REGION",
  "HARNESS_COS_MOUNT_NAME",
  "HARNESS_COS_MOUNT_DIR",
] as const;

export function missingHarnessCosEnv(): string[] {
  if (process.env.HARNESS_COS_ENABLED !== "1") return [];
  return COS_REQUIRED.filter((k) => !process.env[k]?.trim());
}

export function assertHarnessCosEnv(): void {
  if (process.env.HARNESS_COS_ENABLED !== "1") return;
  const missing = missingHarnessCosEnv();
  if (missing.length) {
    throw new Error(
      `HARNESS_COS_ENABLED=1 requires: ${missing.join(", ")}. See .env.harness.example`,
    );
  }
}

/** CAM control-plane creds for harness (DB, AGS, COS). SCF uses role temp keys (+ SessionToken). */
export function resolveCamControlPlaneCredentials(): {
  secretId: string;
  secretKey: string;
  sessionToken?: string;
} {
  if (isScfServerless()) {
    return {
      secretId:
        process.env.TENCENTCLOUD_SECRETID?.trim() ??
        process.env.TCB_SECRET_ID?.trim() ??
        "",
      secretKey:
        process.env.TENCENTCLOUD_SECRETKEY?.trim() ??
        process.env.TCB_SECRET_KEY?.trim() ??
        "",
      sessionToken: resolveCamSessionToken(),
    };
  }
  return {
    secretId:
      process.env.TCB_SECRET_ID?.trim() ??
      process.env.TENCENTCLOUD_SECRETID?.trim() ??
      "",
    secretKey:
      process.env.TCB_SECRET_KEY?.trim() ??
      process.env.TENCENTCLOUD_SECRETKEY?.trim() ??
      "",
    sessionToken: resolveCamSessionToken(),
  };
}

function resolveCamSessionToken(): string | undefined {
  return (
    process.env.TCB_TOKEN?.trim() ??
    process.env.TENCENTCLOUD_SESSIONTOKEN?.trim() ??
    process.env.TENCENTCLOUD_TOKEN?.trim()
  );
}

/** True inside Tencent SCF zip/image web functions (stateless; no in-memory prewarm). */
export function isScfServerless(): boolean {
  const runEnv = process.env.TENCENTCLOUD_RUNENV?.trim().toUpperCase();
  if (runEnv === "SCF") return true;
  if (process.env.SCF_RUNTIME?.trim()) return true;
  if (process.env._SCF_SERVER_PORT?.trim()) return true;
  return false;
}

/** 真 AGS 验收前：CloudBase + TCB_REGION +（可选）COS。local 主链用 TCB_API_KEY → hy3-preview，不要求 LLM_*。 */
export function assertHarnessAgsRuntimeEnv(): void {
  assertHarnessCloudCreds();
  if (!process.env.TCB_REGION?.trim()) {
    throw new Error("Missing TCB_REGION (e.g. ap-shanghai) for CloudBase data stores");
  }
  assertHarnessCosEnv();
}
