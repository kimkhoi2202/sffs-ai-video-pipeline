#!/usr/bin/env node
/**
 * upload-media.ts — host-swappable media uploader for the SFFS video pipeline.
 *
 * WHY THIS EXISTS
 *   Social posting is automated via Publer, which imports media BY URL only.
 *   Rendered shorts therefore need to live at a fetchable URL. This uploader takes
 *   a local file, pushes it to whichever object host is configured, and prints the
 *   resulting URL on stdout so a caller (or a human) can hand it to Publer.
 *
 * HOST-SWAPPABLE BY DESIGN
 *   The provider is chosen at runtime via the MEDIA_HOST env var:
 *       MEDIA_HOST=s3         -> AWS S3 (private bucket + presigned GET URL)  [DEFAULT]
 *       MEDIA_HOST=supabase   -> Supabase Storage (public bucket URL)
 *       MEDIA_HOST=r2         -> Cloudflare R2 (stub)
 *   Every provider is one entry in the PROVIDERS registry and returns the same
 *   UploadResult. NO credentials are hardcoded — everything comes from env (or,
 *   for S3, the EC2 instance role via IMDSv2).
 *
 * S3 (the Hermes VPS default): the bucket is PRIVATE (public access blocked); we
 *   PutObject with SigV4 and return a PRESIGNED GET URL (TTL S3_PRESIGN_TTL, default
 *   21600s = 6h) that Publer can fetch during import. Implemented with Node built-ins
 *   ONLY (node:crypto + global fetch) so this tool stays dependency-light — no
 *   @aws-sdk install required. Credentials resolve from AWS_ACCESS_KEY_ID/SECRET
 *   (+ optional AWS_SESSION_TOKEN) if present, else from the EC2 instance role
 *   (IMDSv2). The presigned URL is what makes a private object fetchable.
 *
 * USAGE
 *   node tools/upload-media.ts <local-file> [dest-key]
 *   stdout = the URL (and nothing else). stderr = diagnostics.
 *
 * ENV
 *   Common:   MEDIA_HOST, MEDIA_DEST_PREFIX
 *   s3:       AWS_REGION (or S3_REGION), S3_BUCKET, S3_PRESIGN_TTL,
 *             [AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_SESSION_TOKEN | EC2 role]
 *   supabase: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_KEY), SUPABASE_BUCKET
 *   r2:       R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createHash, createHmac } from "node:crypto";

type Provider = "supabase" | "s3" | "r2";

interface UploadArgs {
  localPath: string;
  key: string;
  body: Uint8Array;
  contentType: string;
}

interface UploadResult {
  url: string;
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
// Provider: Supabase Storage (public bucket)
// ---------------------------------------------------------------------------
async function uploadSupabase({ key, body, contentType }: UploadArgs): Promise<UploadResult> {
  const base = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
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
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Supabase upload failed (HTTP ${res.status}): ${detail}`);
  }
  const url = `${base}/storage/v1/object/public/${bucket}/${encodeKey(key)}`;
  return { url, key, provider: "supabase", bytes: body.length };
}

// ---------------------------------------------------------------------------
// Provider: AWS S3 (private bucket + presigned GET URL) — pure Node SigV4
// ---------------------------------------------------------------------------
interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Uint8Array =>
  new Uint8Array(createHmac("sha256", key).update(data, "utf8").digest());
const hmacHex = (key: Uint8Array, data: string): string => createHmac("sha256", key).update(data, "utf8").digest("hex");

/** Strict RFC-3986 percent-encoding (AWS canonicalization). */
function rfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function encodePath(key: string): string {
  return "/" + key.split("/").map(rfc3986).join("/");
}

function amzDates(d = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = d.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Uint8Array {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service), "aws4_request");
}

/** Resolve AWS credentials: env first, then the EC2 instance role via IMDSv2. */
async function resolveAwsCreds(): Promise<AwsCreds> {
  const ak = process.env.AWS_ACCESS_KEY_ID?.trim();
  const sk = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  if (ak && sk) return { accessKeyId: ak, secretAccessKey: sk, sessionToken: process.env.AWS_SESSION_TOKEN?.trim() || undefined };

  const IMDS = "http://169.254.169.254";
  const tokRes = await fetch(`${IMDS}/latest/api/token`, {
    method: "PUT",
    headers: { "X-aws-ec2-metadata-token-ttl-seconds": "21600" },
  });
  if (!tokRes.ok) throw new Error(`IMDSv2 token failed (HTTP ${tokRes.status}); set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY instead`);
  const token = await tokRes.text();
  const h = { "X-aws-ec2-metadata-token": token };
  const roleRes = await fetch(`${IMDS}/latest/meta-data/iam/security-credentials/`, { headers: h });
  if (!roleRes.ok) throw new Error(`IMDS role list failed (HTTP ${roleRes.status})`);
  const role = (await roleRes.text()).trim().split("\n")[0];
  const credRes = await fetch(`${IMDS}/latest/meta-data/iam/security-credentials/${role}`, { headers: h });
  if (!credRes.ok) throw new Error(`IMDS creds failed (HTTP ${credRes.status})`);
  const c = await credRes.json();
  return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token };
}

function s3Region(): string {
  return (process.env.AWS_REGION ?? process.env.S3_REGION ?? "us-east-1").trim();
}
function s3Host(bucket: string, region: string): string {
  return `${bucket}.s3.${region}.amazonaws.com`;
}

async function s3PutObject(bucket: string, key: string, body: Uint8Array, contentType: string, creds: AwsCreds, region: string): Promise<void> {
  const host = s3Host(bucket, region);
  const service = "s3";
  const { amzDate, dateStamp } = amzDates();
  const payloadHash = sha256hex(body);
  const canonicalUri = encodePath(key);

  const headerPairs: [string, string][] = [
    ["content-type", contentType],
    ["host", host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  if (creds.sessionToken) headerPairs.push(["x-amz-security-token", creds.sessionToken]);
  headerPairs.sort((a, b) => a[0].localeCompare(b[0]));
  const canonicalHeaders = headerPairs.map(([k, v]) => `${k}:${v}\n`).join("");
  const signedHeaders = headerPairs.map(([k]) => k).join(";");

  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(creds.secretAccessKey, dateStamp, region, service), stringToSign);
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    authorization,
  };
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const res = await fetch(`https://${host}${canonicalUri}`, { method: "PUT", headers, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`S3 PutObject failed (HTTP ${res.status}): ${detail.slice(0, 500)}`);
  }
}

/** Build a presigned GET URL (query-param SigV4) for a private object. */
export function s3PresignGet(bucket: string, key: string, creds: AwsCreds, region: string, expiresIn: number): string {
  const host = s3Host(bucket, region);
  const service = "s3";
  const { amzDate, dateStamp } = amzDates();
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = encodePath(key);

  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${creds.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  if (creds.sessionToken) params["X-Amz-Security-Token"] = creds.sessionToken;

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join("&");

  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = ["GET", canonicalUri, canonicalQuery, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = hmacHex(signingKey(creds.secretAccessKey, dateStamp, region, service), stringToSign);
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function uploadS3({ key, body, contentType }: UploadArgs): Promise<UploadResult> {
  const bucket = requireEnv("S3_BUCKET");
  const region = s3Region();
  const ttl = Number(process.env.S3_PRESIGN_TTL ?? 21600);
  const creds = await resolveAwsCreds();
  await s3PutObject(bucket, key, body, contentType, creds, region);
  const url = s3PresignGet(bucket, key, creds, region, ttl);
  return { url, key, provider: "s3", bytes: body.length };
}

// ---------------------------------------------------------------------------
// Provider: Cloudflare R2 (STUB)
// ---------------------------------------------------------------------------
async function uploadR2(_args: UploadArgs): Promise<UploadResult> {
  throw new Error(
    "MEDIA_HOST=r2 is not implemented. R2 is S3-compatible; adapt the S3 SigV4 path with endpoint " +
      "https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com and R2 credentials.",
  );
}

const PROVIDERS: Record<Provider, UploadFn> = {
  supabase: uploadSupabase,
  s3: uploadS3,
  r2: uploadR2,
};

function resolveProvider(): Provider {
  // DEFAULT is now s3 (Supabase -> S3 migration for the Hermes VPS loop).
  const raw = (process.env.MEDIA_HOST ?? "s3").trim().toLowerCase();
  if (raw in PROVIDERS) return raw as Provider;
  throw new Error(`Unknown MEDIA_HOST '${raw}'. Expected one of: ${Object.keys(PROVIDERS).join(", ")}.`);
}

function buildKey(localPath: string, destArg: string | undefined): string {
  const prefix = (process.env.MEDIA_DEST_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, "");
  const tail = (destArg ?? basename(localPath)).replace(/^\/+/, "");
  return prefix ? `${prefix}/${tail}` : tail;
}

/** Reusable module entry: upload a local file, return the fetchable URL + meta. */
export async function uploadFile(localPath: string, destKey?: string): Promise<UploadResult> {
  const provider = resolveProvider();
  const key = buildKey(localPath, destKey);
  const contentType = contentTypeFor(localPath);
  const body = await readFile(localPath);
  return PROVIDERS[provider]({ localPath, key, body, contentType });
}

async function main(): Promise<void> {
  const [localPath, destArg] = process.argv.slice(2);
  if (!localPath) {
    console.error("usage: node tools/upload-media.ts <local-file> [dest-key]");
    process.exit(2);
  }
  const result = await uploadFile(localPath, destArg);
  console.error(`[upload-media] ${result.provider} OK: ${result.key} (${result.bytes.toLocaleString()} bytes)`);
  console.log(result.url); // stdout: ONLY the URL
}

// Run as CLI only when invoked directly (not when imported as a module).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`[upload-media] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
