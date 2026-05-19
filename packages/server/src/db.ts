import cloudbase from "@cloudbase/node-sdk";

const app = cloudbase.init({
  env: process.env.CLOUDBASE_ENV_ID ?? "",
  secretId: process.env.TENCENTCLOUD_SECRETID,
  secretKey: process.env.TENCENTCLOUD_SECRETKEY,
});

export const db = app.database();
export const ai = app.ai();
export { app };

export async function generateId(prefix: string): Promise<string> {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
