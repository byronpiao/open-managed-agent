/**
 * Harness 宿主机 env 解析与校验。
 * 除 HARNESS_PUBLIC_MAGENT_IMAGE 外不设兜底魔法值。
 */

/** 唯一允许内置的默认：公开 CCR magent 镜像（可用 HARNESS_SANDBOX_IMAGE 覆盖）。 */
export const HARNESS_PUBLIC_MAGENT_IMAGE =
  "ccr.ccs.tencentyun.com/tcb-sandbox-public-cbe88d/tcb-sandbox-public-cbe88d:260608-1044-2d795e-magent";

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
  if (!process.env.TCB_API_KEY?.trim()) missing.push("TCB_API_KEY");
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
      sessionToken:
        process.env.TENCENTCLOUD_SESSIONTOKEN?.trim() ??
        process.env.TCB_TOKEN?.trim(),
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
    sessionToken:
      process.env.TCB_TOKEN?.trim() ??
      process.env.TENCENTCLOUD_SESSIONTOKEN?.trim(),
  };
}

/** True inside Tencent SCF zip/image web functions (stateless; no in-memory prewarm). */
export function isScfServerless(): boolean {
  const runEnv = process.env.TENCENTCLOUD_RUNENV?.trim().toUpperCase();
  if (runEnv === "SCF") return true;
  if (process.env.SCF_RUNTIME?.trim()) return true;
  if (process.env._SCF_SERVER_PORT?.trim()) return true;
  return false;
}

/** 真 AGS 验收前：CloudBase + TCB_REGION +（可选）COS。主链用 opencode zen，不要求 LLM_*。 */
export function assertHarnessAgsRuntimeEnv(): void {
  assertHarnessCloudCreds();
  if (!process.env.TCB_REGION?.trim()) {
    throw new Error("Missing TCB_REGION (e.g. ap-shanghai) for CloudBase data stores");
  }
  assertHarnessCosEnv();
}
