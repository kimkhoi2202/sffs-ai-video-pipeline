#!/usr/bin/env node
/**
 * rerender-prominent-swap.ts — ONE-TIME: re-render each CURRENTLY-SCHEDULED SFFS short
 * with the now-visible PROMINENT brain (mascot=prominent overlay on the cold-open plates;
 * see remotion FullVideo MascotCorner) and swap it into Publer while PRESERVING the
 * branded cover, caption, scheduled_at, account, and IG feed.
 *
 * The mp4s must be PRE-RENDERED (mascot=prominent) to PROM_DIR/<videoId>.<platform>.mp4
 * (rendered from the existing per-platform props.json, no TTS). This tool only does the
 * Publer swap: upload the new mp4 -> import (NEW media id) -> recreate the post reusing the
 * SAME branded cover -> single-id delete the old -> re-persist the new post + media id.
 *
 * SAFETY (prior bulk-delete incident):
 *   - SINGLE-ID delete ONLY: deletePosts([oldId]) then assert deleted_ids === EXACTLY [oldId].
 *   - Serial, soonest-first; skip any post within 20 min of go-live.
 *   - Delete-first then recreate + verify (state/time/feed/cover/media); any failure STOPS.
 *   - Re-persist the NEW post id + NEW media id into run-state (+ ab-database).
 *   - Never touches published posts / kickoff / timer.
 *
 * USAGE (caller sources the loop env):
 *   node tools/rerender-prominent-swap.ts                 # DRY RUN (plan only)
 *   node tools/rerender-prominent-swap.ts --commit            # execute all
 *   node tools/rerender-prominent-swap.ts --commit --only ID  # only that live post id
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPost, deletePosts, listPosts, pollJob, importMediaFromUrl } from "./post-to-publer.ts";
import { videoMediaObjectWithCover, loadCoverManifest, COVER_COLOR_ORDER } from "../hermes/src/covers.ts";
import { uploadToS3 } from "../hermes/src/s3.ts";

const REPO = join(import.meta.dirname, "..");
const RUNS_DIR = process.env.HERMES_RUNS_DIR || "/home/ec2-user/hermes-data/runs";
const PROM_DIR = process.env.PROM_DIR || "/home/ec2-user/hermes-data/renders/prom";
const AB_DB = join(REPO, "ab-testing", "ab-database.json");
const SAFETY_MS = 20 * 60 * 1000;
const PLATFORM_BY_ACCT: Record<string, "instagram" | "tiktok"> = {
  "6a5fc9dc4ccd63dc1f041549": "instagram",
  "6a5fc5451bee22495517bcc5": "tiktok",
};

const log = (m: string) => console.error(`[rerender-swap] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const normCap = (t: string) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
const stripMs = (iso: string) => String(iso).replace(/\.\d{1,3}(?=[+-]\d{2}:?\d{2}|Z)/, "");
const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

async function gatherScheduled(): Promise<any[]> {
  let out: any[] = [];
  for (let p = 0; p < 20; p++) {
    const r = await listPosts({ state: "scheduled", page: p });
    if (!r.length) break;
    out = out.concat(r);
  }
  return out;
}
function jobFailure(job: { payload: any }): string | null {
  const f = job?.payload?.failures;
  if (!f || typeof f !== "object" || !Object.keys(f).length) return null;
  const m: string[] = [];
  for (const arr of Object.values(f)) for (const e of Array.isArray(arr) ? arr : [arr]) m.push(String((e as any)?.message ?? JSON.stringify(e)));
  return m.join(" | ");
}
function loadRunVideos(): any[] {
  const vids: any[] = [];
  try {
    for (const f of readdirSync(RUNS_DIR).filter((x) => x.endsWith(".json"))) {
      let run: any;
      try { run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")); } catch { continue; }
      for (const v of run.videos || []) vids.push({ file: join(RUNS_DIR, f), id: v.id, media_id: v.publer?.media_id, caption: v.caption, post_ids: (v.publer?.post_ids || []).map(String) });
    }
  } catch {}
  return vids;
}
function matchVideo(fresh: any, runVids: any[]): any | null {
  const byPost = runVids.find((v) => (v.post_ids || []).includes(String(fresh.id)));
  if (byPost) return byPost;
  const mid = String(fresh?.media?.[0]?.id ?? "");
  const byMedia = runVids.find((v) => String(v.media_id) === mid);
  if (byMedia) return byMedia;
  const cap = normCap(fresh.text);
  const byCap = runVids.filter((v) => normCap(v.caption) === cap);
  return byCap.length === 1 ? byCap[0] : null;
}
function repersist(v: any, oldId: string, newId: string, newMediaId: string): string {
  let where = "none";
  if (v && v.file) {
    try {
      const run = JSON.parse(readFileSync(v.file, "utf8"));
      const vid = (run.videos || []).find((x: any) => x.id === v.id);
      if (vid) {
        vid.publer = vid.publer || {};
        const ids = new Set<string>([...(vid.publer.post_ids || [])].map(String));
        ids.delete(oldId); ids.add(newId);
        vid.publer.post_ids = [...ids];
        vid.publer.media_id = newMediaId;
        run.updated_at = new Date().toISOString();
        writeFileSync(v.file, JSON.stringify(run, null, 2) + "\n");
        where = `run-state ${vid.id}`;
      }
    } catch (e) { log(`  repersist run-state failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  try {
    if (existsSync(AB_DB)) {
      const db = JSON.parse(readFileSync(AB_DB, "utf8"));
      let changed = false;
      for (const rec of db.posts || []) {
        if (String(rec.publer_post_id) === oldId) { rec.prior_rerender_post_id = oldId; rec.publer_post_id = newId; changed = true; }
      }
      if (changed) { db.updated_at = new Date().toISOString(); writeFileSync(AB_DB, JSON.stringify(db, null, 2) + "\n"); where += " + ab-db"; }
    }
  } catch (e) { log(`  repersist ab-db failed: ${e instanceof Error ? e.message : String(e)}`); }
  return where;
}
/** The freshly-imported media's Publer-generated thumbnails (from the import job
 *  payload). The branded cover is APPENDED to these (matching the proven cover
 *  backfill) rather than replacing them — Publer ignores a lone external cover on a
 *  fresh video and regenerates its own, so we must include its auto thumbs + cover. */
function autoThumbsFromJob(job: any): Array<Record<string, unknown>> {
  const p = job?.payload;
  let media: any = null;
  if (Array.isArray(p)) media = p[0];
  else if (p && Array.isArray(p.media)) media = p.media[0];
  else if (p && (p.id || p._id)) media = p;
  else if (p && typeof p === "object") media = Object.values(p).find((v: any) => v && typeof v === "object" && (v.id || v._id));
  const th = Array.isArray(media?.thumbnails) ? media.thumbnails : [];
  return th
    .map((t: any) => ({ ...(t.id ? { id: String(t.id) } : {}), small: String(t.small ?? t.real ?? ""), real: String(t.real ?? t.small ?? "") }))
    .filter((t: any) => t.real);
}
function coverApplied(post: any, coverId: string): boolean {
  const md = Array.isArray(post?.media) ? post.media[0] : null;
  if (!md) return false;
  const th = Array.isArray(md.thumbnails) ? md.thumbnails : [];
  const di = Number(md.default_thumbnail);
  const u = String(th[di]?.real ?? th[di]?.small ?? "");
  return !!coverId && u.includes(coverId);
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const onlyId = args.includes("--only") ? String(args[args.indexOf("--only") + 1]) : undefined;

  const manifest = loadCoverManifest();
  if (!manifest) throw new Error("no covers manifest at ab-testing/covers-manifest.json — render + upload covers first");

  const live = await gatherScheduled();
  const runVids = loadRunVideos();

  const targets = live.filter((p) => Array.isArray(p.media) && p.media[0]?.id && p.text && p.media[0]?.type === "video");
  // Deterministic rotating cover color per video (caption), twins offset — matches the
  // cover backfill so colors stay on-brand + varied across the queue.
  const videoKeys = [...new Set(targets.map((p: any) => normCap(p.text)))].sort((a, b) => {
    const e = (k: string) => Math.min(...targets.filter((p: any) => normCap(p.text) === k).map((p: any) => Date.parse(p.scheduled_at)));
    return e(a) - e(b);
  });
  const colorFor = (p: any) => {
    const j = videoKeys.indexOf(normCap(p.text));
    const off = (PLATFORM_BY_ACCT[String(p.account_id)] || "instagram") === "tiktok" ? 2 : 0;
    const n = COVER_COLOR_ORDER.length;
    return COVER_COLOR_ORDER[(((j + off) % n) + n) % n];
  };
  let plans = targets.map((p) => {
    const v = matchVideo(p, runVids);
    const platform = PLATFORM_BY_ACCT[String(p.account_id)] || "?";
    const mp4 = v ? join(PROM_DIR, `${v.id}.${platform}.mp4`) : "";
    return { oldId: String(p.id), accountId: String(p.account_id), platform, videoId: v?.id ?? "?", color: colorFor(p), mp4, hasMp4: !!mp4 && existsSync(mp4), scheduledAt: stripMs(p.scheduled_at), v };
  }).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (onlyId) plans = plans.filter((p) => p.oldId === onlyId);

  const now = Date.now();
  console.log(`\n=== RERENDER PROMINENT SWAP (${commit ? "COMMIT" : "DRY RUN"}) ===`);
  console.log(`live scheduled: ${live.length} | plans: ${plans.length}`);
  for (const p of plans) {
    const mins = Math.round((Date.parse(p.scheduledAt) - now) / 60000);
    const safe = Date.parse(p.scheduledAt) - now < SAFETY_MS;
    console.log(`  ${p.scheduledAt} ${p.platform.padEnd(9)} vid=${p.videoId} bg=${p.color.padEnd(6)} old=${p.oldId} mp4=${p.hasMp4 ? "OK" : "MISSING"} (in ${mins}m)${safe ? "  [SKIP <20m]" : ""}`);
  }
  const missing = plans.filter((p) => !p.hasMp4);
  if (missing.length) console.log(`\nMISSING mp4s: ${missing.map((m) => `${m.videoId}.${m.platform}`).join(", ")}`);
  if (!commit) { console.log("\n(dry run — no mutations. --commit to apply, --only ID for a canary.)"); return; }
  if (missing.length) { console.log("\nABORT: refuse to commit with missing mp4s."); process.exitCode = 1; return; }

  const results: any[] = [];
  for (const plan of plans) {
    try {
      const fresh = (await gatherScheduled()).find((p) => String(p.id) === plan.oldId);
      if (!fresh || fresh.state !== "scheduled") { results.push({ ...plan, skipped: true, reason: `not scheduled` }); log(`SKIP ${plan.oldId}: not scheduled`); continue; }
      if (Date.parse(fresh.scheduled_at) - Date.now() < SAFETY_MS) { results.push({ ...plan, skipped: true, reason: "within 20m safety window" }); log(`SKIP ${plan.oldId}: safety window`); continue; }
      const caption = String(fresh.text ?? ""); if (!caption) throw new Error(`no caption ${plan.oldId}`);
      const cover = manifest.covers[plan.color]; if (!cover?.id) throw new Error(`no cover media for ${plan.color}`);

      const key = `rerender/${plan.videoId}.${plan.platform}.${Date.now()}.mp4`;
      const url = uploadToS3(plan.mp4, key);
      log(`=== ${plan.platform} vid=${plan.videoId} bg=${plan.color} old=${plan.oldId} @ ${plan.scheduledAt} : uploaded -> importing ===`);
      const { mediaId: newMediaId, job: importJob } = await importMediaFromUrl(url, `${plan.videoId}-${plan.platform}-prom.mp4`, { caption });
      if (!newMediaId) throw new Error(`import returned no media id`);
      const autoThumbs = autoThumbsFromJob(importJob);
      const mediaObject = videoMediaObjectWithCover(String(newMediaId), cover, autoThumbs);

      const del = await deletePosts([plan.oldId]);
      const deleted = (del?.deleted_ids ?? []).map(String);
      if (!(deleted.length === 1 && deleted[0] === plan.oldId)) {
        results.push({ ...plan, error: `UNSAFE delete ${JSON.stringify(del)} — expected [${plan.oldId}]; ABORT` });
        log(`ABORT ${plan.oldId}: delete not exactly one id`);
        break;
      }
      log(`  deleted exactly [${plan.oldId}]; recreating with new media ${newMediaId} + cover ${cover.id || cover.path}`);

      let np: any = null, lastErr = "";
      for (let attempt = 1; attempt <= 2 && !np; attempt++) {
        const before = new Set((await gatherScheduled()).filter((p) => String(p.account_id) === plan.accountId).map((p) => String(p.id)));
        const jobId = await createPost({ account_ids: [plan.accountId], text: caption, media_objects: [mediaObject], state: "scheduled", scheduled_at: plan.scheduledAt, type: "video" });
        const job = await pollJob(jobId, { label: "recreate", timeoutMs: 120_000, intervalMs: 2500 });
        const fail = jobFailure(job); if (fail) { lastErr = `create failure: ${fail}`; log(`  attempt ${attempt}: ${lastErr}`); await sleep(2000); continue; }
        for (let i = 0; i < 40 && !np; i++) {
          const cands = (await gatherScheduled()).filter((p) => String(p.account_id) === plan.accountId && !before.has(String(p.id)));
          np = cands.find((p) => sameInstant(p.scheduled_at, plan.scheduledAt)) || (cands.length === 1 ? cands[0] : null);
          if (!np) await sleep(3000);
        }
        if (!np) { lastErr = "new post not found"; await sleep(2000); }
      }
      if (!np) throw new Error(`SLOT EMPTY: recreate failed after delete (${lastErr})`);
      const okTime = sameInstant(String(np.scheduled_at), plan.scheduledAt);
      const okState = np.state === "scheduled";
      const okFeed = plan.platform === "instagram" ? np?.details?.feed === true : true;
      const okCover = coverApplied(np, cover.id);
      const okVideo = String(np?.media?.[0]?.id) === String(newMediaId);
      const where = repersist(plan.v, plan.oldId, String(np.id), String(newMediaId));
      log(`  new=${np.id} state=${np.state} at=${np.scheduled_at} feed=${np?.details?.feed ?? "n/a"} media=${np?.media?.[0]?.id} bg=${plan.color} coverApplied=${okCover} repersist=${where}`);
      if (!okState || !okTime || !okFeed || !okVideo) { results.push({ ...plan, new_id: String(np.id), applied: false, error: `identity check failed (state=${okState} time=${okTime} feed=${okFeed} media=${okVideo})` }); log(`STOP: identity check`); break; }
      if (!okCover) { results.push({ ...plan, new_id: String(np.id), applied: false, error: `cover not applied` }); log(`STOP: cover not applied`); break; }
      results.push({ ...plan, new_id: String(np.id), new_media: String(newMediaId), applied: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ERROR ${plan.oldId}: ${msg}`);
      results.push({ ...plan, error: msg });
      break;
    }
  }
  console.log(`\n=== RESULT ===`);
  console.log(JSON.stringify({ ok: results.every((r) => !r.error), applied: results.filter((r) => r.applied).length, results: results.map((r) => ({ old: r.oldId, new: r.new_id, media: r.new_media, platform: r.platform, vid: r.videoId, bg: r.color, applied: !!r.applied, skipped: !!r.skipped, error: r.error, reason: r.reason })) }, null, 2));
  if (results.some((r) => r.error)) process.exitCode = 1;
}
main().catch((e) => { console.error(`[rerender-swap] FATAL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
