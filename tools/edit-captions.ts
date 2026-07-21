#!/usr/bin/env node
/**
 * edit-captions.ts — in-place caption + hashtag edits for the A/B batch.
 *
 * Publer CAN edit a scheduled/draft post's TEXT in place: PUT /posts/{id} with
 * { post: { text } } changes the caption while preserving state + scheduled_at
 * (verified). So captions are edited in place — NO delete/recreate, no double-post
 * risk, media + scheduled time untouched.
 *
 * NOTE: the update endpoint only accepts text/title, NOT network options, so the
 * Instagram "also share to Feed" flag CANNOT be set here (it's a creation-time
 * network option). See tools/README / the run report for the manual-toggle list.
 *
 * Caption: "Are you SMART or FART? <brain><wind> Comment your <score|answer> below
 * <point> and follow for more!!" (no-answer uses "answer"; all else "score"), plus
 * one rotating hashtag set (A/B/C) appended per post, recorded as hashtag_set.
 *
 * USAGE
 *   node tools/edit-captions.ts                # all 14 scheduled (time order) + 6 controls
 *   node tools/edit-captions.ts no-answer      # one scheduled variant (both platforms)
 *   node tools/edit-captions.ts controls       # only the control drafts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listPosts, listAccounts, loadEnv, updatePost } from "./post-to-publer.ts";
import { ALL_ORDER, VARIANTS, localIso, serializeDb } from "./post-variant.ts";

const REPO_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(REPO_ROOT, "ab-testing", "ab-database.json");

// Hashtag A/B sets (recorded per post as hashtag_set).
const HASHTAGS: Record<string, string> = {
  A: "#fyp #foryou #quiz #trivia #brainteaser",
  B: "#smartorfart #iqtest #puzzletok #riddles #mindgames",
  C: "#quiztime #braintest #canyoupass #puzzle #trivianight",
};
const SETS = ["A", "B", "C"];

const PLATFORMS = ["instagram", "tiktok"] as const;

function baseCaption(isNoAnswer: boolean): string {
  const verb = isNoAnswer ? "answer" : "score";
  return `Are you SMART or FART? \u{1f9e0}\u{1f4a8} Comment your ${verb} below \u{1f447} and follow for more!!`;
}
function fullCaption(isNoAnswer: boolean, set: string): string {
  return `${baseCaption(isNoAnswer)} ${HASHTAGS[set]}`;
}

const sameInstant = (a: string, b: string) =>
  Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Math.abs(Date.parse(a) - Date.parse(b)) <= 60_000;

function log(m: string) {
  console.error(`[edit-captions] ${m}`);
}

/**
 * Deterministic per-post hashtag rotation across the 20-post batch:
 *   14 scheduled (ALL_ORDER x [instagram, tiktok]) then 6 controls, cycling A,B,C.
 * Returns { scheduledSlots, controlStartIdx }.
 */
function scheduledSlots(): Array<{ key: string; platform: string; set: string }> {
  const slots: Array<{ key: string; platform: string; set: string }> = [];
  let i = 0;
  for (const key of ALL_ORDER) {
    for (const platform of PLATFORMS) {
      slots.push({ key, platform, set: SETS[i % 3] });
      i++;
    }
  }
  return slots;
}

async function editScheduled(keys: string[]): Promise<any[]> {
  const results: any[] = [];
  const slots = scheduledSlots().filter((s) => keys.includes(s.key));
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  for (const slot of slots) {
    const v = VARIANTS[slot.key];
    const rec = db.posts.find(
      (p: any) => p.post_state === "scheduled" && p.source_video === v.mp4 && p.platform === slot.platform,
    );
    if (!rec) {
      log(`WARN: no scheduled DB row for ${slot.key}/${slot.platform}`);
      continue;
    }
    const caption = fullCaption(slot.key === "no-answer", slot.set);
    const res = await updatePost(rec.publer_post_id, { post: { text: caption } });
    const okText = res?.text === caption;
    const okState = res?.state === "scheduled";
    const okTime = res?.scheduled_at ? sameInstant(res.scheduled_at, rec.scheduled_at) : false;
    log(`${okText && okState && okTime ? "OK " : "BAD"} ${slot.key}/${slot.platform} set=${slot.set} id=${rec.publer_post_id} [text:${okText} state:${okState} time:${okTime}]`);
    if (!okText || !okState || !okTime) {
      throw new Error(`in-place edit failed for ${slot.key}/${slot.platform} (${rec.publer_post_id}): ${JSON.stringify({ okText, okState, okTime, got: res?.text })}`);
    }
    rec.caption = caption;
    rec.hashtag_set = slot.set;
    results.push({ variant: slot.key, platform: slot.platform, hashtag_set: slot.set, publer_post_id: rec.publer_post_id, scheduled_at: rec.scheduled_at });
  }
  db.updated_at = localIso();
  writeFileSync(DB_PATH, serializeDb(db));
  return results;
}

/** Media ids on a post (list shape). */
const mediaIdsOf = (p: any) => (Array.isArray(p.media) ? p.media.map((m: any) => m && String(m.id)) : []);

async function editControls(startIdx: number): Promise<any[]> {
  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a: any) => [a.id, a.provider]));
  // All current drafts are the control drafts (variant drafts were deleted at scheduling).
  let drafts: any[] = [];
  for (let p = 0; p < 12; p++) {
    const r = await listPosts({ state: "draft", page: p });
    if (!r.length) break;
    drafts = drafts.concat(r);
  }
  // Group by media_id (each control video = 1 media across 2 platform posts).
  const byMedia = new Map<string, any[]>();
  for (const d of drafts) {
    const mid = mediaIdsOf(d)[0] ?? `nomedia-${d.id}`;
    if (!byMedia.has(mid)) byMedia.set(mid, []);
    byMedia.get(mid)!.push(d);
  }
  const mediaOrder = [...byMedia.keys()].sort(); // deterministic
  const results: any[] = [];
  let i = startIdx;
  for (const mid of mediaOrder) {
    const group = byMedia.get(mid)!;
    // instagram first, then tiktok, for stable rotation
    group.sort((a, b) => (providerById.get(a.account_id) === "instagram" ? -1 : 1));
    for (const post of group) {
      const platform = providerById.get(post.account_id) ?? "unknown";
      const set = SETS[i % 3];
      i++;
      const caption = fullCaption(false, set); // controls = standard quiz -> "score"
      const res = await updatePost(post.id, { post: { text: caption } });
      const okText = res?.text === caption;
      const okState = res?.state === "draft" || res?.state === "draft_undated" || res?.state === "draft_dated";
      log(`${okText && okState ? "OK " : "BAD"} control/${platform} set=${set} id=${post.id} media=${mid} [text:${okText} state:${okState}]`);
      if (!okText) throw new Error(`control edit failed for ${post.id}: got ${JSON.stringify(res?.text)}`);
      results.push({ control_media: mid, platform, hashtag_set: set, publer_post_id: post.id, state: res?.state });
    }
  }
  return results;
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const doControls = args.includes("controls") || args.length === 0;
  const keyArgs = args.filter((a) => a !== "controls");
  const keys = keyArgs.length ? keyArgs : args.length === 0 ? [...ALL_ORDER] : [];
  const unknown = keys.filter((k) => !VARIANTS[k]);
  if (unknown.length) throw new Error(`unknown variant key(s): ${unknown.join(", ")}`);

  const scheduled = keys.length ? await editScheduled(keys) : [];
  // Controls always occupy slots 14..19 in the global rotation.
  const controls = doControls ? await editControls(ALL_ORDER.length * PLATFORMS.length) : [];

  console.log(JSON.stringify({ ok: true, scheduled, controls }, null, 2));
}

main().catch((err: unknown) => {
  console.error(`[edit-captions] FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
