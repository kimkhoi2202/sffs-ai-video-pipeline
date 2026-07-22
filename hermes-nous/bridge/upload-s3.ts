#!/usr/bin/env node
/**
 * upload-s3.ts (bridge) — the Node entry the `sffs` plugin shells into to UPLOAD a
 * rendered mp4 to object storage and get back a fetchable URL. It wraps ONLY
 * tools/upload-media.ts:
 *
 *   - `upload`           -> uploadFile(localPath, destKey?) : push the local file to
 *                          the configured MEDIA_HOST (DEFAULT s3 — a PRIVATE bucket
 *                          with a presigned GET URL) and return { url, key, provider,
 *                          bytes }. The URL is what Publer can fetch during a later
 *                          DRAFT import.
 *   - `upload --dry-run` -> validate the file + preview the destination key WITHOUT
 *                          uploading (no network, no credentials needed).
 *
 * tools/upload-media.ts imports ONLY node builtins (fs / path / crypto) + global
 * fetch. It has NO Publer/create/schedule/publish/delete/update import anywhere, so
 * this bridge is physically unable to create, publish, schedule, or mutate any post
 * — it only HOSTS media (uploads a file, returns a URL). Attaching that URL to a
 * Publer DRAFT is a separate, later step (sffs_publer_draft).
 *
 * MEDIA HOST = S3 (operator directive: everything in AWS). The Supabase/R2 providers
 * in upload-media.ts are not targeted here; MEDIA_HOST defaults to s3.
 *
 * USAGE (stdin = a JSON object of params):
 *   node upload-s3.ts upload            {local_path, dest_key?}  -> { ok, url, key, provider, bytes }
 *   node upload-s3.ts upload --dry-run  {local_path, dest_key?}  -> { ok, dry_run, provider, key, bytes }
 *
 * A LIVE upload needs S3 creds (AWS_ACCESS_KEY_ID/SECRET or the EC2 instance role
 * via IMDSv2) + S3_BUCKET (default hermes-sffs-media) + AWS_REGION. dry-run needs
 * none of these.
 *
 * EXIT CODES: 0 ok · 1 runtime error · 2 bad stdin JSON · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { uploadFile } from "../../tools/upload-media.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Preview the dest key exactly as tools/upload-media.ts buildKey() would (prefix +
 *  tail), so dry-run reports the real destination without importing the internal. */
function previewKey(localPath: string, destArg: string | undefined): string {
  const prefix = (process.env.MEDIA_DEST_PREFIX ?? "").trim().replace(/^\/+|\/+$/g, "");
  const tail = (destArg ?? basename(localPath)).replace(/^\/+/, "");
  return prefix ? `${prefix}/${tail}` : tail;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_UPLOAD_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "upload") {
    console.error("upload-s3: usage: upload-s3.ts upload [--dry-run]  (stdin = {local_path, dest_key?})");
    process.exit(3);
    return;
  }

  const raw = (await readStdin()).trim();
  let params: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      } else {
        console.error("upload-s3: stdin must be a JSON object of params");
        process.exit(2);
        return;
      }
    } catch (e) {
      console.error(`upload-s3: invalid JSON on stdin: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
  }

  const localPath = typeof params.local_path === "string" ? params.local_path.trim() : "";
  const destKey =
    typeof params.dest_key === "string" && params.dest_key.trim() ? params.dest_key.trim() : undefined;
  if (!localPath) {
    console.error("upload-s3: 'local_path' (string) is required on stdin");
    process.exit(3);
    return;
  }
  if (!existsSync(localPath)) {
    console.error(`upload-s3: local file not found: ${localPath}`);
    process.exit(3);
    return;
  }
  const bytes = statSync(localPath).size;
  const provider = (process.env.MEDIA_HOST ?? "s3").trim().toLowerCase();

  // ── dry-run: validate + preview the destination; no upload, no creds ──
  if (dryRun) {
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        sub,
        provider,
        local_path: localPath,
        key: previewKey(localPath, destKey),
        bytes,
        note: "upload dry-run made no network call and used no credentials",
      }),
    );
    return;
  }

  // ── live upload ──────────────────────────────────────────────────────────
  const result = await uploadFile(localPath, destKey);
  console.log(
    JSON.stringify({
      ok: true,
      sub,
      url: result.url,
      key: result.key,
      provider: result.provider,
      bytes: result.bytes,
    }),
  );
}

main().catch((e) => {
  console.error(`upload-s3: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
