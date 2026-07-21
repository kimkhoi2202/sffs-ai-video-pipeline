#!/usr/bin/env node
/**
 * post-variant.ts — draft one A/B-test variant to BOTH social accounts and record it.
 *
 * WHAT IT DOES (per variant, end-to-end):
 *   1. Upload the local mp4 to the media host (Supabase) by SPAWNING the existing
 *      tools/upload-media.ts and capturing the public URL from its stdout.
 *   2. Import that URL into Publer (POST /media/from-url -> poll job -> media_id).
 *      Imports run SEQUENTIALLY across variants (Publer 403s parallel URL imports).
 *   3. Create a DRAFT post to BOTH accounts (Instagram + TikTok) with the variant
 *      caption (POST /posts/schedule state=draft -> poll job to completion).
 *   4. Find the two created drafts by their (unique) imported media_id and read back
 *      their Publer post ids.
 *   5. Append one record per platform to ab-testing/ab-database.json (schema v1),
 *      tagged with the variant's A/B dimensions + post_state:"draft", and bump the
 *      top-level updated_at.
 *
 * SAFETY: DRAFTS ONLY. Nothing is published or scheduled live.
 *
 * USAGE
 *   node tools/post-variant.ts --list                # print the variant registry
 *   node tools/post-variant.ts no-answer             # one variant
 *   node tools/post-variant.ts speed one-question    # several, sequentially
 *   node tools/post-variant.ts all                   # all remaining families (video-1)
 *
 * ENV (video/.env, auto-loaded): SUPABASE_* (for upload-media) + PUBLER_API_KEY + PUBLER_WORKSPACE_ID.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createPost,
  importMediaFromUrl,
  listAccounts,
  listPosts,
  loadEnv,
  pollJob,
} from "./post-to-publer.ts";

const execFileAsync = promisify(execFile);

// ── Repo layout ──
const REPO_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(REPO_ROOT, "ab-testing", "ab-database.json");
const UPLOAD_TOOL = join(REPO_ROOT, "tools", "upload-media.ts");

// ── Accounts (both drafts go to both) ──
const IG_ID = "6a5fc9dc4ccd63dc1f041549";
const TT_ID = "6a5fc5451bee22495517bcc5";
const ACCOUNT_IDS = [IG_ID, TT_ID];
const ACCOUNT_HANDLE = "@smartfellafartsmellatest";

// ── Captions (task-provided; used as-is since ab-tests/manifest.json carries no caption strings) ──
const CAPTION_SCORE_CTA =
  "SMART or FART? 🧠💨 Can you get all 3? Comment your score 👇 #smartorfart #iqtest #brainteaser #quiz #trivia";
const CAPTION_ONE_Q =
  "SMART or FART? 🧠💨 Can you get it? Comment 👇 #smartorfart #iqtest #brainteaser #quiz #trivia";
const CAPTION_NO_ANSWER =
  "This one's tricky! Comment your answer below 👇 #quiz #trivia #braintest #puzzle #logic";

/**
 * Variant registry — the 7 remaining A/B families, video-1 each. question_types +
 * num_questions are taken from ab-tests/manifest.json render tiers (id 1=ODD ONE OUT,
 * 11=POSITION/FIGURE SERIES, 7=NUMBER SERIES), mapped to the DB's lowercase-hyphen form.
 */
interface Variant {
  key: string;
  family: string;
  mp4: string; // repo-relative
  caption: string;
  narration: string;
  hook: string;
  question_types: string[];
  num_questions: number;
}

const VARIANTS: Record<string, Variant> = {
  "no-answer": {
    key: "no-answer",
    family: "no-answer",
    mp4: "renders.nosync/videos/ab-tests/no-answer/video-1/no-answer-video-1.mp4",
    caption: CAPTION_NO_ANSWER,
    narration: "full",
    hook: "comment-CTA",
    question_types: ["odd-one-out", "figure-series", "number-series"],
    num_questions: 3,
  },
  "no-narration": {
    key: "no-narration",
    family: "dont-narrate",
    mp4: "renders.nosync/videos/ab-tests/dont-narrate/no-narration/video-1/dont-narrate-no-narration-video-1.mp4",
    caption: CAPTION_SCORE_CTA,
    narration: "none",
    hook: "score-CTA",
    question_types: ["odd-one-out", "position", "number-series"],
    num_questions: 3,
  },
  "no-question-vo": {
    key: "no-question-vo",
    family: "dont-narrate",
    mp4: "renders.nosync/videos/ab-tests/dont-narrate/no-question-vo/video-1/dont-narrate-no-question-vo-video-1.mp4",
    caption: CAPTION_SCORE_CTA,
    narration: "no-question-vo",
    hook: "score-CTA",
    question_types: ["odd-one-out", "position", "number-series"],
    num_questions: 3,
  },
  "no-options-vo": {
    key: "no-options-vo",
    family: "dont-narrate",
    mp4: "renders.nosync/videos/ab-tests/dont-narrate/no-options-vo/video-1/dont-narrate-no-options-vo-video-1.mp4",
    caption: CAPTION_SCORE_CTA,
    narration: "no-options-vo",
    hook: "score-CTA",
    question_types: ["odd-one-out", "position", "number-series"],
    num_questions: 3,
  },
  speed: {
    key: "speed",
    family: "speed",
    mp4: "renders.nosync/videos/ab-tests/speed/video-1/speed-video-1.mp4",
    caption: CAPTION_SCORE_CTA,
    narration: "full",
    hook: "score-CTA",
    question_types: ["odd-one-out", "position", "number-series"],
    num_questions: 3,
  },
  "one-question": {
    key: "one-question",
    family: "one-question",
    mp4: "renders.nosync/videos/ab-tests/one-question/video-1/one-question-video-1.mp4",
    caption: CAPTION_ONE_Q,
    narration: "full",
    hook: "score-CTA",
    question_types: ["odd-one-out"],
    num_questions: 1,
  },
  mascot: {
    key: "mascot",
    family: "mascot",
    mp4: "renders.nosync/videos/ab-tests/mascot/video-1/mascot-video-1.mp4",
    caption: CAPTION_SCORE_CTA,
    narration: "full",
    hook: "score-CTA",
    question_types: ["odd-one-out", "position", "number-series"],
    num_questions: 3,
  },
};

// Default "all" order: no-answer first (it's the test-me variant), then the rest.
const ALL_ORDER = [
  "no-answer",
  "no-narration",
  "no-question-vo",
  "no-options-vo",
  "speed",
  "one-question",
  "mascot",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function log(msg: string): void {
  console.error(`[post-variant] ${msg}`);
}

/** ISO 8601 with the machine's local UTC offset, matching the DB's updated_at style. */
function localIso(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const ah = Math.floor(Math.abs(off) / 60);
  const am = Math.abs(off) % 60;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(ah)}:${pad(am)}`
  );
}

/** Serialize DB as ASCII (\uXXXX for non-ASCII) to match the existing file style + minimize diff. */
function serializeDb(db: unknown): string {
  const json = JSON.stringify(db, null, 2);
  const ascii = json.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return ascii + "\n";
}

function mediaIdsOf(post: any): string[] {
  if (!post || !Array.isArray(post.media)) return [];
  return post.media.map((m: any) => (m && (m.id ?? m._id)) != null ? String(m.id ?? m._id) : "").filter(Boolean);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upload a local file via tools/upload-media.ts, returning the public URL from its stdout. */
async function uploadToHost(repoRelPath: string): Promise<string> {
  const abs = join(REPO_ROOT, repoRelPath);
  if (!existsSync(abs)) throw new Error(`mp4 not found: ${repoRelPath}`);
  log(`uploading to media host: ${repoRelPath}`);
  const { stdout } = await execFileAsync("node", [UPLOAD_TOOL, repoRelPath], {
    cwd: REPO_ROOT,
    env: process.env, // includes SUPABASE_* loaded from .env
    maxBuffer: 8 * 1024 * 1024,
  });
  const url = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  if (!/^https?:\/\//.test(url)) throw new Error(`upload-media.ts did not return a URL (got: ${JSON.stringify(url)})`);
  log(`media host URL: ${url}`);
  return url;
}

/** After creating a draft, locate the per-account drafts by the unique imported media_id. */
async function findDraftsByMedia(
  mediaId: string,
  accountIds: string[],
  providerById: Map<string, string | undefined>,
): Promise<Array<{ publer_post_id: string | number; account_id: string; platform: string; post_link: string | null; updated_at: string | null }>> {
  const wanted = new Set(accountIds);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const drafts = await listPosts({ state: "draft" });
    const matched = drafts.filter(
      (p: any) => wanted.has(p.account_id) && mediaIdsOf(p).includes(mediaId),
    );
    if (matched.length >= accountIds.length) {
      return matched.map((p: any) => ({
        publer_post_id: p.id,
        account_id: p.account_id,
        platform: providerById.get(p.account_id) ?? "unknown",
        post_link: p.post_link ?? null,
        updated_at: p.updated_at ?? null,
      }));
    }
    log(`  draft match ${matched.length}/${accountIds.length}, retrying (${attempt}/6)...`);
    await sleep(2500);
  }
  throw new Error(`Could not find ${accountIds.length} drafts for media_id=${mediaId} after retries`);
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------
function buildRecord(
  v: Variant,
  platform: string,
  account_id: string,
  publer_post_id: string | number,
  mediaId: string,
  post_link: string | null,
  draftedAt: string,
): any {
  return {
    publer_post_id,
    platform_post_id: null, // draft: no native platform id until published
    platform,
    account_id,
    account_handle: ACCOUNT_HANDLE,
    permalink: post_link, // Publer draft edit link if present, else null
    posted_at: null, // not posted; this is a draft
    drafted_at: draftedAt,
    caption: v.caption,
    source_video: v.mp4,
    source_candidates: [],
    variant: {
      family: v.family,
      intro: false,
      narration: v.narration,
      hook: v.hook,
      question_types: v.question_types,
      num_questions: v.num_questions,
    },
    metrics: {
      reach: null,
      reach_rate: null,
      video_views: null,
      reactions: null,
      comments: null,
      shares: null,
      eng_rate: null,
      link_clicks: null,
      ctr: null,
      as_of: null,
      source: "pending",
    },
    match_confidence: "high",
    post_state: "draft",
    publer_media_id: mediaId,
    notes:
      `Drafted via tools/post-variant.ts (A/B ${v.family} / ${v.key}, video-1). ` +
      `DRAFT only — not published; platform_post_id/permalink/posted_at fill on publish. ` +
      `Source render pinned (match_confidence high). Publer media_id ${mediaId}.`,
  };
}

/** Append new draft records (idempotent on publer_post_id), refresh family draft counts + updated_at. */
function writeRecords(records: any[]): void {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  if (!Array.isArray(db.posts)) throw new Error("ab-database.json: posts[] missing");

  for (const rec of records) {
    const idx = db.posts.findIndex((p: any) => p.publer_post_id === rec.publer_post_id);
    if (idx >= 0) db.posts[idx] = rec;
    else db.posts.push(rec);
  }

  // Keep family rollups honest without touching published-metrics fields: add an
  // additive `drafts` count + note recomputed from posts[]. (count/avg_* stay
  // "published with metrics" semantics.)
  if (db.variant_families && typeof db.variant_families === "object") {
    const today = localIso().slice(0, 10);
    for (const fam of Object.keys(db.variant_families)) {
      const n = db.posts.filter((p: any) => p?.variant?.family === fam && p?.post_state === "draft").length;
      db.variant_families[fam].drafts = n;
      if (n > 0) {
        db.variant_families[fam].drafts_note = `${n} draft(s) created via post-variant.ts (video-1, both platforms) as of ${today}; pending publish (no metrics yet).`;
      }
    }
  }

  db.updated_at = localIso();
  writeFileSync(DB_PATH, serializeDb(db));
}

// ---------------------------------------------------------------------------
// Per-variant pipeline
// ---------------------------------------------------------------------------
async function processVariant(
  v: Variant,
  providerById: Map<string, string | undefined>,
): Promise<any> {
  log(`=== ${v.key} (family=${v.family}) ===`);

  // 1. Upload mp4 to media host -> public URL
  const url = await uploadToHost(v.mp4);

  // 2. Import into Publer (sequential; poll to media_id)
  const mediaName = v.mp4.split("/").pop() ?? `${v.key}.mp4`;
  log(`importing into Publer: ${mediaName}`);
  const { mediaId } = await importMediaFromUrl(url, mediaName);
  log(`Publer media_id: ${mediaId}`);

  // 3. Create DRAFT post to BOTH accounts, poll create job to completion
  log(`creating DRAFT post to ${ACCOUNT_IDS.length} accounts...`);
  const jobId = await createPost({
    account_ids: ACCOUNT_IDS,
    text: v.caption,
    media_ids: [mediaId],
    state: "draft",
    type: "video",
  });
  log(`create job_id: ${jobId}`);
  const job = await pollJob(jobId, { timeoutMs: 120_000, intervalMs: 2_000, label: "post-create" });
  log(`create job status: ${job.status}`);

  // 4. Resolve the two per-platform draft post ids by media_id
  const drafts = await findDraftsByMedia(mediaId, ACCOUNT_IDS, providerById);
  const draftedAt = localIso();
  for (const d of drafts) log(`  draft ${d.platform}: publer_post_id=${d.publer_post_id} (account ${d.account_id})`);

  // 5. Append one DB record per platform
  const records = drafts.map((d) =>
    buildRecord(v, d.platform, d.account_id, d.publer_post_id, mediaId, d.post_link, draftedAt),
  );
  writeRecords(records);
  log(`recorded ${records.length} draft(s) to ab-database.json`);

  return {
    variant: v.key,
    family: v.family,
    media_id: mediaId,
    create_job_id: jobId,
    posts: drafts.map((d) => ({ platform: d.platform, publer_post_id: d.publer_post_id, account_id: d.account_id })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.error(
      "usage: node tools/post-variant.ts <--list | all | <variant-key>...>\n" +
        `variant keys: ${Object.keys(VARIANTS).join(", ")}`,
    );
    process.exit(2);
  }
  if (args[0] === "--list") {
    console.log(JSON.stringify(VARIANTS, null, 2));
    return;
  }

  const keys = args[0] === "all" ? ALL_ORDER : args;
  const unknown = keys.filter((k) => !VARIANTS[k]);
  if (unknown.length) throw new Error(`unknown variant key(s): ${unknown.join(", ")}. Valid: ${Object.keys(VARIANTS).join(", ")}`);

  // Provider map (account_id -> "instagram"/"tiktok") for platform tagging.
  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a) => [a.id, a.provider]));

  const results: any[] = [];
  const errors: any[] = [];
  for (const k of keys) {
    try {
      results.push(await processVariant(VARIANTS[k], providerById));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`ERROR on ${k}: ${message}`);
      errors.push({ variant: k, error: message });
    }
  }

  // Machine-readable summary on stdout.
  console.log(JSON.stringify({ ok: errors.length === 0, results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`[post-variant] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
