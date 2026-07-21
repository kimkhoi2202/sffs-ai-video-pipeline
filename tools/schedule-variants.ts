#!/usr/bin/env node
/**
 * schedule-variants.ts — move the A/B variant DRAFTS to SCHEDULED (auto-publish) at
 * fixed times, cross-posted to both accounts, and update the A/B database.
 *
 * WHY RECREATE INSTEAD OF UPDATE
 *   Publer has NO in-place draft->scheduled transition: PUT /posts/{id} changes
 *   neither state nor scheduled_at (confirmed via publer.com/docs + the
 *   publer-mcp-server author's own reschedule/publish-draft tools, which all
 *   recreate + delete). So for each variant we:
 *     1. Recreate the post as state="scheduled" with per-account scheduled_at,
 *        REUSING the already-imported Publer media_id (no re-import -> respects the
 *        one-URL-import-at-a-time rule; zero imports happen here).
 *     2. Confirm the 2 new scheduled posts exist (by media_id).
 *     3. Delete the 2 original draft posts.
 *     4. Rewrite the DB rows (new post_ids, scheduled_at, post_state="scheduled").
 *   The recreated posts get NEW ids (expected, per Publer's model).
 *
 * IDEMPOTENT: if a variant's media already has 2 scheduled posts, it reuses them
 *   (no duplicate), then reconciles the DB + deletes any leftover drafts.
 *
 * SAFETY: nothing is published now; posts auto-publish at their scheduled time.
 *   Only the 14 A/B variant rows are touched — pre-existing control drafts + the
 *   original posted rows are matched out by source_video and left alone.
 *
 * USAGE
 *   node tools/schedule-variants.ts                 # all 7 variants (time order)
 *   node tools/schedule-variants.ts no-answer       # a subset
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  deletePosts,
  findPostsByMedia,
  listAccounts,
  loadEnv,
  schedulePost,
} from "./post-to-publer.ts";
import { ALL_ORDER, VARIANTS, localIso, serializeDb } from "./post-variant.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(REPO_ROOT, "ab-testing", "ab-database.json");

const IG_ID = "6a5fc9dc4ccd63dc1f041549";
const TT_ID = "6a5fc5451bee22495517bcc5";
const ACCOUNT_IDS = [IG_ID, TT_ID];

/** Target auto-publish times (America/Chicago, CDT = -05:00 in July), keyed by variant. */
const SCHEDULE: Record<string, string> = {
  "no-answer": "2026-07-21T18:30:00-05:00",
  "no-narration": "2026-07-21T19:45:00-05:00",
  "no-question-vo": "2026-07-21T21:00:00-05:00",
  "no-options-vo": "2026-07-21T22:15:00-05:00",
  speed: "2026-07-22T07:00:00-05:00",
  "one-question": "2026-07-22T08:00:00-05:00",
  mascot: "2026-07-22T08:45:00-05:00",
};

const SCHEDULED_STATES = new Set(["scheduled", "scheduled_approved", "scheduled_pending"]);

function log(msg: string): void {
  console.error(`[schedule-variants] ${msg}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Read the DB and return the (draft or scheduled) A/B rows for one variant by source_video. */
function variantRows(db: any, sourceVideo: string): any[] {
  return db.posts.filter(
    (p: any) => p.source_video === sourceVideo && (p.post_state === "draft" || p.post_state === "scheduled"),
  );
}

/** Same instant? (tolerant of format/offset differences; 60s tolerance) */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && Math.abs(ta - tb) <= 60_000;
}

/**
 * Poll until >=n posts with this media_id appear under state=scheduled.
 *
 * NOTE: the /posts/schedule job is fire-and-forget here — job_status returns
 * `status:null` for schedule jobs (unlike media-import / draft-create jobs), so we
 * do NOT poll the job. The authoritative success signal is the scheduled posts
 * appearing, which lags the 200 OK by ~10-60s. Hence the generous default window.
 */
async function waitForScheduled(mediaId: string, n = 2, tries = 40, delay = 3000): Promise<any[]> {
  let found: any[] = [];
  for (let i = 0; i < tries; i++) {
    found = await findPostsByMedia(mediaId, ACCOUNT_IDS, { state: "scheduled" });
    if (found.length >= n) return found;
    await sleep(delay);
  }
  return found;
}

/** Apply the scheduled result for one variant to the DB (match rows by account_id). */
function applyToDb(
  sourceVideo: string,
  scheduledIso: string,
  updates: Map<string, { newId: string | number; postLink: string | null }>,
): void {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  for (const rec of db.posts) {
    if (rec.source_video !== sourceVideo) continue;
    if (rec.post_state !== "draft" && rec.post_state !== "scheduled") continue;
    const u = updates.get(rec.account_id);
    if (!u) continue;
    if (rec.post_state === "draft" && rec.publer_post_id !== u.newId) {
      rec.prior_draft_post_id = rec.publer_post_id; // traceability
    }
    rec.publer_post_id = u.newId;
    rec.post_state = "scheduled";
    rec.scheduled_at = scheduledIso;
    rec.permalink = u.postLink ?? rec.permalink ?? null;
    rec.notes =
      `Scheduled via tools/schedule-variants.ts to ${scheduledIso} (auto-publish at that time). ` +
      `Recreated as state=scheduled${rec.prior_draft_post_id ? ` from draft ${rec.prior_draft_post_id}` : ""} + ` +
      `original draft deleted (Publer has no in-place draft->scheduled). ` +
      `Not yet published; platform_post_id/posted_at fill on publish. Publer media_id ${rec.publer_media_id}.`;
  }

  // Refresh additive per-family draft/scheduled counts (published-metrics fields untouched).
  if (db.variant_families && typeof db.variant_families === "object") {
    const today = localIso().slice(0, 10);
    for (const fam of Object.keys(db.variant_families)) {
      const d = db.posts.filter((p: any) => p?.variant?.family === fam && p?.post_state === "draft").length;
      const s = db.posts.filter((p: any) => p?.variant?.family === fam && p?.post_state === "scheduled").length;
      db.variant_families[fam].drafts = d;
      db.variant_families[fam].scheduled = s;
      if (s > 0) {
        db.variant_families[fam].scheduled_note = `${s} post(s) scheduled via schedule-variants.ts (video-1, both platforms) as of ${today}; auto-publish at the set time (no metrics yet).`;
      }
    }
  }
  db.updated_at = localIso();
  writeFileSync(DB_PATH, serializeDb(db));
}

async function processVariant(
  key: string,
  providerById: Map<string, string | undefined>,
): Promise<any> {
  const scheduledIso = SCHEDULE[key];
  const v = VARIANTS[key];
  if (!scheduledIso) throw new Error(`no schedule time for variant ${key}`);
  if (!v) throw new Error(`unknown variant ${key}`);
  const sourceVideo = v.mp4;
  log(`=== ${key} -> ${scheduledIso} ===`);

  // Resolve the 2 A/B rows (draft or already-scheduled) for this variant.
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const rows = variantRows(db, sourceVideo);
  if (rows.length === 0) throw new Error(`no A/B rows found for ${key} (source_video ${sourceVideo})`);
  const mediaIds = [...new Set(rows.map((r) => r.publer_media_id).filter(Boolean))];
  if (mediaIds.length !== 1) throw new Error(`expected exactly 1 media_id for ${key}, got ${JSON.stringify(mediaIds)}`);
  const mediaId = mediaIds[0];
  const caption = rows[0].caption;

  // Idempotency: reuse existing scheduled posts for this media if present (so a
  // re-run never creates duplicates — it just reconciles the DB + cleans drafts).
  let scheduled = await findPostsByMedia(mediaId, ACCOUNT_IDS, { state: "scheduled" });
  if (scheduled.length >= ACCOUNT_IDS.length) {
    log(`  already scheduled (${scheduled.length}); reconciling DB + cleaning drafts`);
  } else {
    log(`  recreating as state=scheduled (media_id ${mediaId}, reused; no re-import)`);
    const jobId = await schedulePost({
      account_ids: ACCOUNT_IDS,
      text: caption,
      media_ids: [mediaId],
      state: "scheduled",
      scheduled_at: scheduledIso,
      type: "video",
    });
    // Do NOT poll job_status (null for schedule jobs). Wait for the posts to appear.
    log(`  schedule job_id: ${jobId} (waiting for scheduled posts to materialize...)`);
    scheduled = await waitForScheduled(mediaId, ACCOUNT_IDS.length);
  }
  if (scheduled.length < ACCOUNT_IDS.length) {
    throw new Error(`only found ${scheduled.length}/${ACCOUNT_IDS.length} scheduled posts for ${key} (media ${mediaId})`);
  }

  // Verify state + time on each new post.
  const updates = new Map<string, { newId: string | number; postLink: string | null }>();
  for (const p of scheduled) {
    const platform = providerById.get(p.account_id) ?? "unknown";
    const okState = SCHEDULED_STATES.has(p.state);
    const okTime = p.scheduled_at ? sameInstant(p.scheduled_at, scheduledIso) : false;
    log(`  ${platform}: id=${p.id} state=${p.state} scheduled_at=${p.scheduled_at} [state:${okState?"ok":"BAD"} time:${okTime?"ok":"BAD"}]`);
    if (!okState) throw new Error(`post ${p.id} state=${p.state} is not a scheduled state`);
    if (!okTime) throw new Error(`post ${p.id} scheduled_at=${p.scheduled_at} != target ${scheduledIso}`);
    updates.set(p.account_id, { newId: p.id, postLink: p.post_link ?? null });
  }

  // Persist to DB BEFORE deleting drafts (so the DB always points at the live scheduled posts).
  applyToDb(sourceVideo, scheduledIso, updates);
  log(`  DB updated (${updates.size} rows -> scheduled)`);

  // Delete the leftover DRAFTS for this media (the originals). Robust: query by media_id.
  const drafts = await findPostsByMedia(mediaId, ACCOUNT_IDS, { state: "draft" });
  let deleted: Array<string | number> = [];
  if (drafts.length) {
    const draftIds = drafts.map((d) => d.id);
    try {
      const res = await deletePosts(draftIds);
      deleted = Array.isArray(res?.deleted_ids) ? res.deleted_ids : draftIds;
    } catch (e) {
      log(`  WARN: failed to delete drafts ${draftIds.join(", ")}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`  deleted ${deleted.length} original draft(s)${deleted.length ? `: ${deleted.join(", ")}` : ""}`);

  return {
    variant: key,
    scheduled_at: scheduledIso,
    media_id: mediaId,
    scheduled_posts: scheduled.map((p) => ({
      platform: providerById.get(p.account_id) ?? "unknown",
      publer_post_id: p.id,
      account_id: p.account_id,
      state: p.state,
      scheduled_at: p.scheduled_at,
    })),
    deleted_drafts: deleted,
  };
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const keys = args.length ? args : ALL_ORDER.filter((k) => SCHEDULE[k]);
  const unknown = keys.filter((k) => !SCHEDULE[k]);
  if (unknown.length) throw new Error(`no schedule time for: ${unknown.join(", ")}`);

  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a) => [a.id, a.provider]));

  const results: any[] = [];
  const errors: any[] = [];
  for (const k of keys) {
    try {
      results.push(await processVariant(k, providerById));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`ERROR on ${k}: ${message}`);
      errors.push({ variant: k, error: message });
    }
  }
  console.log(JSON.stringify({ ok: errors.length === 0, results, errors }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(`[schedule-variants] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
