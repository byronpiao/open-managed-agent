/**
 * AGS COS workspace mount for harness sandboxes.
 * Aligns with code_sandbox/一条龙.md §4–§5 (BucketPath + SubPath pre-create).
 */

import COS from "cos-nodejs-sdk-v5";
import { resolveHarnessToolName } from "../../config.js";
import { assertHarnessCosEnv, requireEnv } from "../harness-env.js";
import { generateHarnessSecretMasterKey } from "../session-secrets.js";

export interface HarnessCosConfig {
  enabled: boolean;
  bucket: string;
  bucketPath: string;
  endpoint: string;
  region: string;
  mountName: string;
  mountDir: string;
  /** Instance SubPath under BucketPath (COS prefix). */
  subPath: string;
  secretMasterKey: string;
}

function truthyEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function stripLeadingSlash(p: string): string {
  return p.replace(/^\/+/, "");
}

/** @deprecated prefer resolveHarnessToolName(envId) from config.js */
export function harnessCosToolNameForEnv(envId: string): string {
  return resolveHarnessToolName(envId);
}

export function resolveHarnessCosConfig(args?: {
  subPathOverride?: string;
  acpSessionId?: string;
  /** From harness_sessions or per-acquire fallback when scripts call orchestrator directly. */
  secretMasterKey?: string;
}): HarnessCosConfig | null {
  if (!truthyEnv("HARNESS_COS_ENABLED")) return null;

  assertHarnessCosEnv();

  const bucket = requireEnv("HARNESS_COS_BUCKET");
  const bucketPath = requireEnv("HARNESS_COS_BUCKET_PATH");
  const endpoint = requireEnv("HARNESS_COS_ENDPOINT");
  const region = requireEnv("HARNESS_COS_REGION");
  const mountName = requireEnv("HARNESS_COS_MOUNT_NAME");
  const mountDir = requireEnv("HARNESS_COS_MOUNT_DIR");

  const pinned = process.env.HARNESS_COS_SUBPATH?.trim() || args?.subPathOverride?.trim();
  const fromSession =
    args?.acpSessionId && args.acpSessionId.length >= 8
      ? `harness-sess-${args.acpSessionId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12)}`
      : "";
  const subPath =
    pinned ||
    fromSession ||
    `harness-inst-${Date.now().toString(36)}`;

  const secretMasterKey = args?.secretMasterKey?.trim() || generateHarnessSecretMasterKey();

  return {
    enabled: true,
    bucket,
    bucketPath,
    endpoint,
    region,
    mountName,
    mountDir,
    subPath,
    secretMasterKey,
  };
}

export function buildCosStorageMounts(cos: HarnessCosConfig): Array<Record<string, unknown>> {
  return [
    {
      Name: cos.mountName,
      StorageSource: {
        Cos: {
          Endpoint: cos.endpoint,
          BucketName: cos.bucket,
          BucketPath: cos.bucketPath.startsWith("/") ? cos.bucketPath : `/${cos.bucketPath}`,
        },
      },
      MountPath: cos.mountDir,
      ReadOnly: false,
    },
  ];
}

export function buildCosMountOptions(cos: HarnessCosConfig): Array<Record<string, unknown>> {
  return [{ Name: cos.mountName, SubPath: cos.subPath }];
}

export function cosObjectKeyForSubPath(cos: HarnessCosConfig): string {
  const prefix = stripLeadingSlash(cos.bucketPath);
  return `${prefix}/${cos.subPath}/.keep`;
}

/** Pre-create BucketPath/SubPath on COS (platform requires prefix before instance start). */
export async function ensureCosSubPath(
  cos: HarnessCosConfig,
  cred: { secretId: string; secretKey: string; sessionToken?: string },
): Promise<void> {
  const client = new COS({
    SecretId: cred.secretId,
    SecretKey: cred.secretKey,
    ...(cred.sessionToken ? { SecurityToken: cred.sessionToken } : {}),
  });
  const Key = cosObjectKeyForSubPath(cos);
  await new Promise<void>((resolve, reject) => {
    client.putObject(
      {
        Bucket: cos.bucket,
        Region: cos.region,
        Key,
        Body: "",
      },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

export function mergeCosInstanceEnv(
  instanceEnv: Array<{ Name: string; Value: string }>,
  cos: HarnessCosConfig,
): Array<{ Name: string; Value: string }> {
  const map = new Map(instanceEnv.map((e) => [e.Name, e.Value]));
  map.set("COS_MOUNT_DIR", cos.mountDir);
  map.set("SECRET_MASTER_KEY", cos.secretMasterKey);
  return [...map.entries()].map(([Name, Value]) => ({ Name, Value }));
}
