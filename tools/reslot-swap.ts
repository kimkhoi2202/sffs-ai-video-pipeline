#!/usr/bin/env node
/**
 * reslot-swap.ts — swap the 6 still-scheduled A/B slots (20:30..08:30) onto their
 * NEW platform-specific, fresh-question renders, at JITTERED times, then update the
 * A/B database. The 18:30 no-answer slot already auto-published and is NOT touched.
 *
 * Per scheduled post (SERIALLY — Publer 403s parallel imports & we never want two
 * live for one slot):
 *   1. re-check the OLD post is still `scheduled` (live guard). If it is gone /
 *      published / inside the safety window -> SKIP + report (never double-post).
 *   2. upload the new platform mp4 to Supabase (tools/upload-media.ts) -> public URL
 *   3. import that URL into Publer -> NEW media_id
 *   4. create a NEW scheduled post: same account, EXACT same caption (read live from
 *      the old post), state=scheduled, scheduled_at=JITTERED, type=video. IG gets
 *      details:{type:reel,feed:true} automatically (createPost default).
 *   5. verify the new post materialized (matched by its unique new media_id).
 *   6. delete the OLD post (bulk DELETE) — only AFTER the new one is confirmed.
 *   7. update the post's ab-database.json record in place (new post_id/media/time +
 *      new question set/categories; A/B identity otherwise preserved).
 *
 * JITTER: base slot time + random(1..9 min) + random(0..59 s), drawn INDEPENDENTLY
 * for IG vs TikTok (so the two accounts never fire at the same instant), small enough
 * to stay inside each slot's original time_bucket and preserve slot ordering.
 *
 * USAGE:  node tools/reslot-swap.ts            # DRY RUN (plan only, no mutations)
 *         node tools/reslot-swap.ts --commit   # execute
 *         node tools/reslot-swap.ts --commit --only s2-no-narration
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPost, deletePosts, importMediaFromUrl, listAccounts, listPosts, loadEnv } from "./post-to-publer.ts";
import { localIso, serializeDb } from "./post-variant.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(import.meta.dirname, "..");
const DB_PATH = join(REPO_ROOT, "ab-testing", "ab-database.json");
const UPLOAD_TOOL = join(REPO_ROOT, "tools", "upload-media.ts");
const RENDER_ROOT = "renders.nosync/videos/ab-reslot-20260721";
const SAFETY_MS = 20 * 60 * 1000; // never mutate a post within 20 min of go-live

const TT = "6a5fc5451bee22495517bcc5";
const IG = "6a5fc9dc4ccd63dc1f041549";

type SlotDef = { key: string; base: string; bucket: string; tt: string; ig: string };
const SLOTS: SlotDef[] = [
  { key: "s2-no-narration",   base: "2026-07-21T20:30:00-05:00", bucket: "evening",          tt: "6a5ff8bcb23bd7bf82e5b64d", ig: "6a5ff8bd324fde90b165a671" },
  { key: "s3-no-question-vo", base: "2026-07-21T23:00:00-05:00", bucket: "late-night",       tt: "6a5ff8c8324fde90b165a678", ig: "6a5ff8c9324fde90b165a679" },
  { key: "s4-no-options-vo",  base: "2026-07-22T01:30:00-05:00", bucket: "overnight",        tt: "6a5ff8ca324fde90b165a67c", ig: "6a5ff8cbb23bd7bf82e5b65e" },
  { key: "s5-speed",          base: "2026-07-22T03:30:00-05:00", bucket: "overnight-trough", tt: "6a5ff8cc324fde90b165a681", ig: "6a5ff8cdfaa7c830db5458f8" },
  { key: "s6-one-question",   base: "2026-07-22T06:30:00-05:00", bucket: "early-morning",    tt: "6a5ff8cffaa7c830db5458fa", ig: "6a5ff8d0324fde90b165a684" },
  { key: "s7-mascot",         base: "2026-07-22T08:30:00-05:00", bucket: "morning",          tt: "6a5ff8d1324fde90b165a68a", ig: "6a5ff8d2324fde90b165a68e" },
];

const TIER_TO_TYPE: Record<string, string> = {
  "ODD ONE OUT": "odd-one-out", "VERBAL ANALOGY": "word-analogy", "SENTENCE COMPLETION": "fill-in-the-blank",
  "NUMBER SERIES": "number-series", "NUMBER ANALOGY": "number-analogy", "NUMBER PUZZLE": "number-puzzle",
  "FIGURE ANALOGY": "figure-analogy", "POSITION": "position", "FIGURE SERIES": "figure-series",
};

const log = (m: string) => console.error(`[reslot-swap] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mediaIdsOf = (p: any) => (Array.isArray(p.media) ? p.media.map((m: any) => m && String(m.id)) : []);
const pad = (n: number) => String(n).padStart(2, "0");

/** base ISO (-05:00) + rand(1..9 min)+rand(0..59 s) -> ISO string in -05:00. */
function jitter(baseIso: string): { iso: string; offMin: number; offSec: number } {
  const offMin = 1 + Math.floor(Math.random() * 9); // 1..9
  const offSec = Math.floor(Math.random() * 60); // 0..59
  const epoch = Date.parse(baseIso) + offMin * 60_000 + offSec * 1000;
  const d = new Date(epoch - 5 * 3600 * 1000); // shift so getUTC* reads the -05:00 wall clock
  const iso = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}-05:00`;
  return { iso, offMin, offSec };
}

async function uploadToHost(repoRelPath: string): Promise<string> {
  const abs = join(REPO_ROOT, repoRelPath);
  if (!existsSync(abs)) throw new Error(`mp4 not found: ${repoRelPath}`);
  const destKey = `ab-reslot-20260721/${repoRelPath.split("/").slice(-1)[0]}`;
  const { stdout } = await execFileAsync("node", [UPLOAD_TOOL, repoRelPath, destKey], { cwd: REPO_ROOT, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  const url = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  if (!/^https?:\/\//.test(url)) throw new Error(`upload-media.ts did not return a URL (got: ${JSON.stringify(url)})`);
  return url;
}

async function gatherScheduled(): Promise<any[]> {
  let o: any[] = [];
  for (let p = 0; p < 12; p++) {
    const r = await listPosts({ state: "scheduled", page: p });
    if (!r.length) break;
    o = o.concat(r);
  }
  return o;
}

async function findNewByMedia(accountId: string, mediaId: string, excludeId: string, tries = 40, delay = 3000): Promise<any | null> {
  for (let i = 0; i < tries; i++) {
    const all = await gatherScheduled();
    const m = all.find((x) => String(x.account_id) === String(accountId) && mediaIdsOf(x).includes(mediaId) && String(x.id) !== String(excludeId));
    if (m) return m;
    await sleep(delay);
  }
  return null;
}

type Swap = { slotKey: string; platform: "tiktok" | "instagram"; accountId: string; oldId: string; base: string; bucket: string; iso: string; offMin: number; offSec: number; mp4: string; info: any };

function buildSwaps(onlyKey?: string): Swap[] {
  const out: Swap[] = [];
  for (const s of SLOTS) {
    if (onlyKey && s.key !== onlyKey) continue;
    for (const platform of ["tiktok", "instagram"] as const) {
      const j = jitter(s.base);
      const mp4 = `${RENDER_ROOT}/${s.key}/${platform}/${s.key}-${platform}.mp4`;
      const infoPath = join(REPO_ROOT, RENDER_ROOT, s.key, platform, "info.json");
      const info = existsSync(infoPath) ? JSON.parse(readFileSync(infoPath, "utf8")) : null;
      out.push({ slotKey: s.key, platform, accountId: platform === "tiktok" ? TT : IG, oldId: platform === "tiktok" ? s.tt : s.ig, base: s.base, bucket: s.bucket, ...j, mp4, info });
    }
  }
  // ensure IG and TT of the same slot never share an instant
  for (const s of SLOTS) {
    const tt = out.find((x) => x.slotKey === s.key && x.platform === "tiktok");
    const ig = out.find((x) => x.slotKey === s.key && x.platform === "instagram");
    if (tt && ig && tt.iso === ig.iso) { const j = jitter(s.base); ig.iso = j.iso; ig.offMin = j.offMin; ig.offSec = j.offSec; }
  }
  return out;
}

function updateDbRecord(oldId: string, sw: Swap, newId: string, newMediaId: string, newPermalink: string | null) {
  const db = JSON.parse(readFileSync(DB_PATH, "utf8"));
  const rec = db.posts.find((p: any) => String(p.publer_post_id) === String(oldId));
  if (!rec) throw new Error(`DB record not found for old post ${oldId}`);
  const qs = (sw.info?.questions ?? []) as any[];
  rec.prior_scheduled_post_id = oldId;
  rec.publer_post_id = newId;
  rec.publer_media_id = newMediaId;
  rec.scheduled_at = sw.iso;
  rec.time_bucket = sw.bucket;
  rec.permalink = newPermalink ?? rec.permalink ?? null;
  rec.source_video = sw.mp4;
  rec.source_candidates = [];
  rec.base_slot = sw.base;
  rec.jitter = { offset_min: sw.offMin, offset_sec: sw.offSec, base: sw.base };
  rec.question_round = sw.info?.round ?? null;
  rec.question_ids = sw.info?.ids ?? [];
  rec.question_categories = qs.map((q) => q.category);
  rec.questions_detail = qs.map((q) => ({ id: q.id, category: q.category, tier: q.tier, answer: q.answer }));
  if (rec.variant) {
    rec.variant.question_types = qs.map((q) => TIER_TO_TYPE[q.tier] ?? String(q.tier).toLowerCase().replace(/\s+/g, "-"));
    rec.variant.num_questions = qs.length;
  }
  rec.notes =
    `Re-rendered 2026-07-21 with the layout fixes (commit 35d8233: TikTok bigger+centered / one-question no counter / mascot placement) in ${sw.platform} format, ` +
    `and given a FRESH previously-unused question set (${sw.info?.round}, ids ${(sw.info?.ids ?? []).join(",")}; ` +
    `${qs.map((q) => q.tier).join(" / ")}) — VO regenerated/matched to the new questions. Swapped via tools/reslot-swap.ts: new media ${newMediaId}, ` +
    `recreated at JITTERED ${sw.iso} (base ${sw.base}, +${sw.offMin}m${sw.offSec}s, bucket ${sw.bucket}) + old ${oldId} deleted. ` +
    `A/B identity (family/narration/hook/hashtag_set/platform/time_bucket) preserved.${sw.platform === "instagram" ? " IG share-to-Feed on (details.feed=true)." : ""}`;
  db.updated_at = localIso();
  writeFileSync(DB_PATH, serializeDb(db));
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const onlyKey = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a) => [a.id, a.provider]));
  const swaps = buildSwaps(onlyKey);

  // live map of old scheduled posts
  const live = await gatherScheduled();
  const liveById = new Map(live.map((p) => [String(p.id), p]));
  const now = Date.now();

  console.log(`\n=== RESLOT SWAP PLAN (${commit ? "COMMIT" : "DRY RUN"}) — ${swaps.length} posts ===`);
  for (const sw of swaps) {
    const lp = liveById.get(String(sw.oldId));
    const state = lp ? lp.state : "NOT-SCHEDULED";
    const cap = lp ? String(lp.text || "").slice(0, 40) : "(old post not live)";
    console.log(`${sw.slotKey.padEnd(18)} ${sw.platform.padEnd(9)} old=${sw.oldId} [${state}] -> ${sw.iso} (+${sw.offMin}m${sw.offSec}s) | ${sw.info?.round} ids[${(sw.info?.ids ?? []).join(",")}] | ${cap}`);
  }

  if (!commit) { console.log(`\n(dry run — no mutations. re-run with --commit to execute.)`); return; }

  const results: any[] = [];
  for (const sw of swaps) {
    const lp = liveById.get(String(sw.oldId));
    try {
      if (!lp || lp.state !== "scheduled") { results.push({ ...ident(sw), skipped: true, reason: `old post ${sw.oldId} not scheduled (state=${lp?.state ?? "gone"})` }); log(`SKIP ${sw.slotKey}/${sw.platform}: old not scheduled`); continue; }
      if (Date.parse(lp.scheduled_at) - now < SAFETY_MS) { results.push({ ...ident(sw), skipped: true, reason: `within ${SAFETY_MS / 60000}min safety window (${lp.scheduled_at})` }); log(`SKIP ${sw.slotKey}/${sw.platform}: safety window`); continue; }
      const caption = String(lp.text || "");
      if (!caption) throw new Error(`no caption on live old post ${sw.oldId}`);

      log(`=== ${sw.slotKey}/${sw.platform} old=${sw.oldId} -> ${sw.iso} ===`);
      log(`  upload ${sw.mp4}`);
      const url = await uploadToHost(sw.mp4);
      log(`  import -> Publer (sequential)`);
      const { mediaId } = await importMediaFromUrl(url, `${sw.slotKey}-${sw.platform}.mp4`);
      log(`  new media_id=${mediaId}`);
      log(`  create scheduled post @ ${sw.iso}`);
      await createPost({ account_ids: [sw.accountId], text: caption, media_ids: [mediaId], state: "scheduled", scheduled_at: sw.iso, type: "video" });
      const np = await findNewByMedia(sw.accountId, mediaId, sw.oldId);
      if (!np) throw new Error(`new ${sw.platform} post did not materialize for ${sw.slotKey}`);
      log(`  new id=${np.id} state=${np.state} at=${np.scheduled_at} details=${JSON.stringify(np.details ?? null)}`);
      // new confirmed -> delete old
      const del = await deletePosts([sw.oldId]);
      log(`  deleted old ${JSON.stringify(del?.deleted_ids ?? [sw.oldId])}`);
      updateDbRecord(sw.oldId, sw, String(np.id), mediaId, np.post_link ?? null);
      results.push({ ...ident(sw), new_id: String(np.id), new_media: mediaId, scheduled_at: sw.iso, ig_feed: providerById.get(sw.accountId) === "instagram" ? (np.details?.feed ?? "n/a") : "n/a" });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      log(`ERROR ${sw.slotKey}/${sw.platform}: ${m}`);
      results.push({ ...ident(sw), error: m });
    }
  }
  console.log(JSON.stringify({ ok: results.every((r) => !r.error), results }, null, 2));
  if (results.some((r) => r.error)) process.exitCode = 1;
}

const ident = (sw: Swap) => ({ slot: sw.slotKey, platform: sw.platform, old_id: sw.oldId });

main().catch((e) => { console.error(`[reslot-swap] FATAL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
