/**
 * Shared FlexDB client utilities — credential resolution, collection access.
 */

import { resolveCamControlPlaneCredentials } from "./harness-env.js";

export interface CloudBaseCredentials {
  envId: string;
  secretId?: string;
  secretKey?: string;
  sessionToken?: string;
  region?: string;
}

export function resolveCloudBaseCredentials(envId: string): CloudBaseCredentials | null {
  const cam = resolveCamControlPlaneCredentials();
  const region = process.env.TCB_REGION?.trim();
  if (cam.secretId && cam.secretKey && region) {
    return {
      envId,
      secretId: cam.secretId,
      secretKey: cam.secretKey,
      sessionToken: cam.sessionToken,
      region,
    };
  }
  // No CAM credentials — but CLOUDBASE_APIKEY allows FlexDB via Bearer auth.
  if (process.env.CLOUDBASE_APIKEY?.trim()) {
    return { envId };
  }
  return null;
}
