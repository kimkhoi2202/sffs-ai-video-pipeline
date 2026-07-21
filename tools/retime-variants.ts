#!/usr/bin/env node
/**
 * retime-variants.ts — move scheduled A/B variant posts to new times (a TIME A/B).
 *
 * WHY RECREATE: Publer's PUT can change a post's text but NOT its scheduled_at/state,
 * so re-timing = recreate at the new time (reusing the same media_id, zero re-imports)
 * then delete the old post. Each variant's two platform posts have DIFFERENT captions
 * (per-platform hashtag_set), so we recreate PER PLATFORM, preserving each post's exact
 * current caption. createPost() sets networks.instagram.details.feed=true by default, so
 * recreated IG posts get "Also share to Feed" automatically.
 *
 * SAFETY:
 *   - earliest-first; skip (and report) any variant whose OLD or NEW time is within 30 min
 *     of go-live.
 *   - create BOTH new posts and verify they exist BEFORE deleting the old ones (never two
 *     live for one slot at publish time). If a recreate half-fails, ROLL BACK the new post(s)
 *     just created so we never leave a duplicate.
 *   - no-answer is NOT moved here (guarded by move:false).
 *
 * USAGE
 *   node tools/retime-variants.ts                 # all 6 moving variants (time order)
 *   node tools/retime-variants.ts no-narration    # a subset
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createPost, deletePosts, listAccounts, listPosts, loadEnv } from "./post-to-publer.ts";
import { VARIANTS, localIso, serializeDb } from "./post-variant.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(REPO_ROOT, "ab-testing", "ab-database.json");

/** New schedule (America/Chicago, CDT=-05:00) + time_bucket, keyed by variant. */
const PLAN: Record<string, { at: string; bucket: string; move: boolean }> = {
  "no-answer": { at: "2026-07-21T18:30:00-05:00", bucket: "evening", move: false },
  "no-narration": { at: "2026-07-21T20:30:00-05:00", bucket: "evening", move: true },
  "no-question-vo": { at: "2026-07-21T23:00:00-05:00", bucket: "late-night", move: true },
  "no-options-vo": { at: "2026-07-22T01:30:00-05:00", bucket: "overnight", move: true },
  speed: { at: "2026-07-22T03:30:00-05:00", bucket: "overnight-trough", move: true },
  "one-question": { at: "2026-07-22T06:30:00-05:00", bucket: "early-morning", move: true },
  mascot: { at: "2026-07-22T08:30:00-05:00", bucket: "morning", move: true },
};
const MOVING_ORDER = ["no-narration", "no-question-vo", "no-options-vo", "speed", "one-question", "mascot"];
const SAFETY_MS = 30 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sameInstant = (a: string, b: string) =>
  Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Math.abs(Date.parse(a) - Date.parse(b)) <= 60_000;
const mediaIdsOf = (p: any) => (Array.isArray(p.media) ? p.media.map((m: any) => m && String(m.id)) : []);
const log = (m: string) => console.error(`[retime] ${m}`);

async function gatherScheduled(): Promise<any[]> {
  let o: any[] = [];
  for (let p = 0; p < 12; p++) {
    const r = await listPosts({ state: "scheduled", page: p });
    if (!r.length) break;
    o = o.concat(r);
  }
  return o;
}

/** Find the NEW post (same media+account, at the new time, id != old) after a recreate. */
async function findNew(mediaId: string, accountId: string, newIso: string, excludeId: string | number, tries = 40, delay = 3000): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const all = await gatherScheduled();
    const m = all.find(
      (x) =>
        String(x.account_id) === String(accountId) &&
        mediaIdsOf(x).includes(mediaId) &&
        String(x.id) !== String(excludeId) &&
        sameInstant(x.scheduled_at, newIso),
    );
    if (m) return m;
    await sleep(delay);
  }
  return null;
}

async function processVariant(key: string, providerById: Map<string, string | undefined>): Promise<any> {
  const plan = PLAN[key];
  const v = VARIANTS[key];
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const rows = db.posts.filter((p: any) => p.post_state === "scheduled" && p.source_video === v.mp4);
  if (rows.length !== 2) throw new Error(`${key}: expected 2 scheduled rows, got ${rows.length}`);

  const now = Date.now();
  for (const r of rows) {
    if (Date.parse(r.scheduled_at) - now < SAFETY_MS) {
      return { variant: key, skipped: true, reason: `old post ${r.publer_post_id} within 30min of go-live (${r.scheduled_at})` };
    }
  }
  if (Date.parse(plan.at) - now < SAFETY_MS) {
    return { variant: key, skipped: true, reason: `new time ${plan.at} within 30min of now` };
  }

  log(`=== ${key} -> ${plan.at} (${plan.bucket}) ===`);
  const created: Array<string | number> = [];
  const newByAccount: Record<string, any> = {};
  try {
    for (const r of rows) {
      log(`  create ${r.platform} @ ${plan.at} (reuse media ${r.publer_media_id})`);
      await createPost({
        account_ids: [r.account_id],
        text: r.caption, // preserve EXACT current caption (incl. hashtag_set)
        media_ids: [r.publer_media_id],
        state: "scheduled",
        scheduled_at: plan.at,
        type: "video",
      });
      const np = await findNew(r.publer_media_id, r.account_id, plan.at, r.publer_post_id);
      if (!np) throw new Error(`new ${r.platform} post did not materialize for ${key}`);
      created.push(np.id);
      newByAccount[r.account_id] = np;
      log(`  new ${r.platform} id=${np.id} state=${np.state} at=${np.scheduled_at} type=${np.type} details=${JSON.stringify(np.details)}`);
    }

    // Both new exist -> safe to delete the olds.
    const oldIds = rows.map((r: any) => r.publer_post_id);
    const del = await deletePosts(oldIds);
    log(`  deleted old ${JSON.stringify(del?.deleted_ids ?? oldIds)}`);

    for (const r of rows) {
      const np = newByAccount[r.account_id];
      r.prior_scheduled_post_id = r.publer_post_id;
      r.publer_post_id = np.id;
      r.scheduled_at = plan.at;
      r.time_bucket = plan.bucket;
      r.permalink = np.post_link ?? r.permalink ?? null;
      r.notes =
        `Re-timed via tools/retime-variants.ts to ${plan.at} (${plan.bucket}); recreated (reused media ` +
        `${r.publer_media_id}, no re-import) + old ${r.prior_scheduled_post_id} deleted. Caption + hashtag_set ` +
        `preserved.${r.platform === "instagram" ? " IG share-to-Feed default on (details.feed=true)." : ""}`;
    }
    db.updated_at = localIso();
    writeFileSync(DB_PATH, serializeDb(db));

    return {
      variant: key,
      new_time: plan.at,
      time_bucket: plan.bucket,
      posts: rows.map((r: any) => ({
        platform: r.platform,
        publer_post_id: r.publer_post_id,
        prior_scheduled_post_id: r.prior_scheduled_post_id,
        ig_feed: providerById.get(r.account_id) === "instagram" ? (newByAccount[r.account_id]?.details?.feed ?? "not-in-list-object") : "n/a",
      })),
    };
  } catch (e) {
    if (created.length) {
      try {
        await deletePosts(created);
        log(`  ROLLBACK deleted just-created ${created.join(", ")} (avoid duplicate)`);
      } catch {
        /* report below */
      }
    }
    throw e;
  }
}

/** Set time_bucket on any scheduled record now sitting at a planned time (incl. no-answer). */
function reconcileBuckets(): number {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  let n = 0;
  for (const p of db.posts) {
    if (p.post_state !== "scheduled") continue;
    for (const pl of Object.values(PLAN)) {
      if (sameInstant(pl.at, p.scheduled_at)) {
        if (p.time_bucket !== pl.bucket) { p.time_bucket = pl.bucket; n++; }
        break;
      }
    }
  }
  if (n) { db.updated_at = localIso(); writeFileSync(DB_PATH, serializeDb(db)); }
  return n;
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const keys = args.length ? args : MOVING_ORDER;
  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a) => [a.id, a.provider]));

  const results: any[] = [];
  const errors: any[] = [];
  for (const k of keys) {
    if (!PLAN[k]) { errors.push({ variant: k, error: "unknown variant" }); continue; }
    if (!PLAN[k].move) { log(`skip ${k} (not moving)`); continue; }
    try {
      results.push(await processVariant(k, providerById));
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(`ERROR ${k}: ${m}`);
      errors.push({ variant: k, error: m });
    }
  }
  const bucketed = reconcileBuckets();
  console.log(JSON.stringify({ ok: errors.length === 0, results, errors, buckets_reconciled: bucketed }, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(`[retime] FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
