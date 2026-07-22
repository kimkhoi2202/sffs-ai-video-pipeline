/**
 * s3.ts — the loop's upload path. Delegates to tools/upload-media.ts (MEDIA_HOST=s3),
 * so ALL loop uploads use the exact migrated uploader (private bucket + presigned
 * GET URL). Returns the presigned URL that Publer imports the media from.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { info } from "./log.ts";

export function uploadToS3(localPath: string, key: string): string {
  const tool = join(CONFIG.REPO_DIR, "tools", "upload-media.ts");
  const res = spawnSync("node", [tool, localPath, key], {
    cwd: CONFIG.REPO_DIR,
    encoding: "utf8",
    timeout: 5 * 60_000,
    env: {
      ...process.env,
      MEDIA_HOST: "s3",
      S3_BUCKET: CONFIG.S3_BUCKET,
      AWS_REGION: CONFIG.AWS_REGION,
      S3_PRESIGN_TTL: String(CONFIG.S3_PRESIGN_TTL),
    },
  });
  if (res.status !== 0) {
    throw new Error(`upload-media.ts failed (status ${res.status}): ${(res.stderr || "").slice(-500)}`);
  }
  const url = (res.stdout || "").trim().split("\n").pop()!.trim();
  if (!/^https:\/\/.+X-Amz-Signature=/.test(url)) {
    throw new Error(`upload-media.ts returned an unexpected URL: ${url.slice(0, 120)}`);
  }
  info("uploaded to s3", { key, urlHead: url.slice(0, 90) + "…" });
  return url;
}
