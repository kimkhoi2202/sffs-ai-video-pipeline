#!/usr/bin/env node
/**
 * publish-carousel.ts — import carousel slide images into Publer and create ONE
 * multi-image post (IG carousel + TikTok photo mode) on both accounts.
 *
 * Unlike the hermes loop (DRAFT-ONLY by invariant), this is a HUMAN-invoked
 * publishing tool: it creates a *scheduled* post that goes live at the given
 * time. Default is +5 minutes, which leaves a short cancel window in Publer.
 *
 * USAGE
 *   node tools/publish-carousel.ts <urls.json> [--caption "..."] [--at ISO8601] [--draft]
 *
 *   urls.json = JSON array of image URLs in slide order (presigned S3 URLs work;
 *   Publer downloads at import time, so TTL only needs to outlive this run).
 *
 * NOTES
 *   - Media imports run SEQUENTIALLY (Publer allows one from-url job at a time).
 *   - Instagram: multi-photo post => feed carousel (no reel details).
 *   - TikTok: multi-photo post => photo mode. A trending sound CANNOT be attached
 *     via the API — sounds are added in the TikTok app only.
 *   - ENV: PUBLER_API_KEY, PUBLER_WORKSPACE_ID (from .env via loadEnv()).
 */

import { readFileSync } from "node:fs";
import {
  loadEnv,
  listAccounts,
  importMediaFromUrl,
  pollJob,
} from "./post-to-publer.ts";

const BASE_URL = "https://app.publer.com/api/v1";

function args(): { urlsFile: string; caption: string; at: string; draft: boolean } {
  const argv = process.argv.slice(2);
  const urlsFile = argv.find((a) => !a.startsWith("--"));
  if (!urlsFile) {
    console.error('usage: publish-carousel.ts <urls.json> [--caption "..."] [--at ISO8601] [--draft]');
    process.exit(2);
  }
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const at = flag("at") ?? new Date(Date.now() + 5 * 60_000).toISOString();
  return {
    urlsFile,
    caption: flag("caption") ?? "",
    at,
    draft: argv.includes("--draft"),
  };
}

async function main(): Promise<void> {
  loadEnv();
  const { urlsFile, caption, at, draft } = args();
  const urls: string[] = JSON.parse(readFileSync(urlsFile, "utf8"));
  if (!Array.isArray(urls) || urls.length < 2) throw new Error("urls.json must be an array of 2+ image URLs");

  // 1) Sequential media imports (parallel from-url imports 403).
  const mediaIds: string[] = [];
  for (let i = 0; i < urls.length; i++) {
    process.stderr.write(`[publish-carousel] importing slide ${i + 1}/${urls.length}...\n`);
    const { mediaId } = await importMediaFromUrl(urls[i], `carousel-slide-${i + 1}.png`);
    mediaIds.push(mediaId);
  }
  process.stderr.write(`[publish-carousel] media ids: ${mediaIds.join(", ")}\n`);

  // 2) One multi-photo post per network provider. IG multi-photo => carousel;
  //    TikTok multi-photo => photo mode. No reel details (these are stills).
  const accounts = await listAccounts();
  const targets = accounts.filter((a) => a.provider === "instagram" || a.provider === "tiktok");
  if (targets.length === 0) throw new Error("no instagram/tiktok accounts connected");

  const media = mediaIds.map((id) => ({ id }));
  const networks: Record<string, unknown> = {};
  for (const t of targets) networks[t.provider!] = { type: "photo", text: caption, media };

  const state = draft ? "draft" : "scheduled";
  const post = {
    accounts: targets.map((t) => ({ id: t.id, ...(draft ? {} : { scheduled_at: at }) })),
    networks,
  };

  const headers = {
    Authorization: `Bearer-API ${process.env.PUBLER_API_KEY}`,
    "Publer-Workspace-Id": process.env.PUBLER_WORKSPACE_ID!,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const res = await fetch(`${BASE_URL}/posts/schedule`, {
    method: "POST",
    headers,
    body: JSON.stringify({ bulk: { state, posts: [post] } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST /posts/schedule -> HTTP ${res.status}: ${text}`);
  const jobId = JSON.parse(text)?.job_id;
  if (!jobId) throw new Error(`no job_id in response: ${text.slice(0, 400)}`);

  const job = await pollJob(jobId, { label: "post-create" });
  console.log(JSON.stringify({ state, scheduled_at: draft ? null : at, accounts: targets.map((t) => `${t.provider}:${t.id}`), job: job.payload }, null, 2));
}

main().catch((err: unknown) => {
  console.error(`[publish-carousel] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
