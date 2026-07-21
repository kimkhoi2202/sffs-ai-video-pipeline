#!/usr/bin/env node
/**
 * upload-media.ts — host-swappable media uploader for the SFFS video pipeline.
 *
 * WHY THIS EXISTS
 *   Social posting is automated via Publer, which imports media BY URL only.
 *   Rendered shorts therefore need to live at a public URL. This uploader takes a
 *   local file, pushes it to whichever object host is configured, and prints the
 *   resulting PUBLIC URL on stdout so a caller (or a human) can hand it to Publer.
 *
 * HOST-SWAPPABLE BY DESIGN
 *   The provider is chosen at runtime via the MEDIA_HOST env var:
 *       MEDIA_HOST=supabase   -> Supabase Storage (implemented)
 *       MEDIA_HOST=s3         -> AWS S3            (stub — see uploadS3)
 *       MEDIA_HOST=r2         -> Cloudflare R2     (stub — see uploadR2)
 *   Every provider is just one entry in the PROVIDERS registry below and returns
 *   the same UploadResult, so moving to R2/S3 later is "fill in one function",
 *   not a rewrite. NO credentials are hardcoded — everything comes from env.
 *
 * USAGE
 *   node tools/upload-media.ts <local-file> [dest-key]
 *   # (Node >= 23.6 runs .ts directly. Older Node: `npx tsx tools/upload-media.ts ...`)
 *
 *   <local-file>  path to the file to upload.
 *   [dest-key]    optional object key (path inside the bucket). Defaults to the
 *                 file's basename. Combined with MEDIA_DEST_PREFIX if set.
 *
 *   stdout = the public URL (and nothing else, so it is easy to capture).
 *   stderr = human-readable diagnostics.
 *
 * ENV (see tools/README-media-hosting.md for the full contract)
 *   Common:   MEDIA_HOST, MEDIA_DEST_PREFIX
 *   supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY), SUPABASE_BUCKET
 *   s3:       AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_BASE_URL
 *   r2:       R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

type Provider = "supabase" | "s3" | "r2";

interface UploadArgs {
  localPath: string;
  key: string; // object key / path inside the bucket
  body: Uint8Array;
  contentType: string;
}

interface UploadResult {
  url: string; // public, directly-fetchable URL
  key: string;
  provider: Provider;
  bytes: number;
}

type UploadFn = (args: UploadArgs) => Promise<UploadResult>;

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
};

function contentTypeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value.trim();
}

/** Percent-encode each path segment but keep "/" separators intact. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------------------
// Provider: Supabase Storage (IMPLEMENTED)
// ---------------------------------------------------------------------------
async function uploadSupabase({ key, body, contentType }: UploadArgs): Promise<UploadResult> {
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  // Prefer the service-role key (bypasses RLS). SUPABASE_KEY is accepted as an
  // alias so alternative credentials can be supplied without renaming env vars.
  const apiKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_KEY ?? "").trim();
  if (!apiKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY)");
  const bucket = (process.env.SUPABASE_BUCKET ?? "sffs-videos").trim();

  const endpoint = `${base}/storage/v1/object/${bucket}/${encodeKey(key)}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      apikey: apiKey,
      "content-type": contentType,
      "cache-control": "3600",
      "x-upsert": "true", // idempotent: re-running overwrites the same key
    },
    body,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase upload failed (HTTP ${res.status}): ${detail}`);
  }

  // Public buckets expose objects at /storage/v1/object/public/<bucket>/<key>.
  const url = `${base}/storage/v1/object/public/${bucket}/${encodeKey(key)}`;
  return { url, key, provider: "supabase", bytes: body.length };
}

// ---------------------------------------------------------------------------
// Provider: AWS S3 (STUB — adapter contract only)
// ---------------------------------------------------------------------------
// TO IMPLEMENT (no rewrite required — just fill in this function):
//   1. `npm i @aws-sdk/client-s3` in whatever package runs this tool.
//   2. const s3 = new S3Client({ region: requireEnv("AWS_REGION") });
//      (credentials picked up from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.)
//   3. await s3.send(new PutObjectCommand({
//        Bucket: requireEnv("S3_BUCKET"), Key: key, Body: body, ContentType: contentType,
//        CacheControl: "public, max-age=3600",
//      }));
//   4. Public URL: prefer an explicit CDN/base you control:
//        `${requireEnv("S3_PUBLIC_BASE_URL").replace(/\/+$/,"")}/${encodeKey(key)}`
//      (e.g. a CloudFront domain, or https://<bucket>.s3.<region>.amazonaws.com).
//      The bucket/object must be publicly readable (bucket policy or CloudFront).
async function uploadS3(_args: UploadArgs): Promise<UploadResult> {
  throw new Error(
    "MEDIA_HOST=s3 is not implemented yet. Fill in uploadS3() in tools/upload-media.ts " +
      "(env: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BUCKET, S3_PUBLIC_BASE_URL).",
  );
}

// ---------------------------------------------------------------------------
// Provider: Cloudflare R2 (STUB — adapter contract only)
// ---------------------------------------------------------------------------
// R2 is S3-compatible, so the same @aws-sdk/client-s3 code works; only the
// endpoint + public base differ.
// TO IMPLEMENT (no rewrite required — just fill in this function):
//   1. `npm i @aws-sdk/client-s3`.
//   2. const s3 = new S3Client({
//        region: "auto",
//        endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
//        credentials: { accessKeyId: requireEnv("R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY") },
//      });
//   3. await s3.send(new PutObjectCommand({
//        Bucket: requireEnv("R2_BUCKET"), Key: key, Body: body, ContentType: contentType,
//        CacheControl: "public, max-age=3600",
//      }));
//   4. Public URL: R2 objects are only public via a bound public domain
//      (r2.dev or a custom domain). Build it from R2_PUBLIC_BASE_URL:
//        `${requireEnv("R2_PUBLIC_BASE_URL").replace(/\/+$/,"")}/${encodeKey(key)}`
async function uploadR2(_args: UploadArgs): Promise<UploadResult> {
  throw new Error(
    "MEDIA_HOST=r2 is not implemented yet. Fill in uploadR2() in tools/upload-media.ts " +
      "(env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL).",
  );
}

// The single swap point: add/replace providers here.
const PROVIDERS: Record<Provider, UploadFn> = {
  supabase: uploadSupabase,
  s3: uploadS3,
  r2: uploadR2,
};

function resolveProvider(): Provider {
  const raw = (process.env.MEDIA_HOST ?? "supabase").trim().toLowerCase();
  if (raw in PROVIDERS) return raw as Provider;
  throw new Error(`Unknown MEDIA_HOST '${raw}'. Expected one of: ${Object.keys(PROVIDERS).join(", ")}.`);
}

function buildKey(localPath: string, destArg: string | undefined): string {
  const prefix = (process.env.MEDIA_DEST_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, "");
  const tail = (destArg ?? basename(localPath)).replace(/^\/+/, "");
  return prefix ? `${prefix}/${tail}` : tail;
}

async function main(): Promise<void> {
  const [localPath, destArg] = process.argv.slice(2);
  if (!localPath) {
    console.error("usage: node tools/upload-media.ts <local-file> [dest-key]");
    process.exit(2);
  }

  const provider = resolveProvider();
  const key = buildKey(localPath, destArg);
  const contentType = contentTypeFor(localPath);
  const body = await readFile(localPath);

  const result = await PROVIDERS[provider]({ localPath, key, body, contentType });

  console.error(
    `[upload-media] ${result.provider} OK: ${result.key} (${contentType}, ${result.bytes.toLocaleString()} bytes)`,
  );
  // stdout: ONLY the URL, so callers can capture it cleanly.
  console.log(result.url);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[upload-media] ERROR: ${message}`);
  process.exit(1);
});
