#!/usr/bin/env node
/**
 * backfill-scheduled-covers.ts — ONE-TIME: give each CURRENTLY-SCHEDULED SFFS post the
 * branded "SMART FELLA OR FART SMELLA?" cover it missed (the cover step is now wired into
 * the live loop; see hermes/src/covers.ts). Publer's PUT cannot set a video cover (only at
 * CREATE), so per post we DELETE + RECREATE at the SAME scheduled_at/caption/account
 * REUSING the existing video media_id (same bytes => same cold-open) with the branded
 * cover appended as the default thumbnail.
 *
 * SAFETY (prior bulk-delete incident):
 *   - SINGLE-ID delete ONLY: deletePosts([oldId]) then assert deleted_ids === EXACTLY
 *     [oldId] (length 1). Any other result ABORTS (no recreate, stop).
 *   - Serial, soonest-first; skip any post within 20 min of go-live (re-guarded live).
 *   - Delete-first (Publer 1-min gap) then recreate + verify; any failure STOPS.
 *   - Re-persist the NEW post id into run-state (+ ab-database). The media_id + caption
 *     are ALSO unchanged, so the dashboard already resolves the recreated post.
 *   - Never touches published posts / kickoff / timer / the video bytes.
 *
 * USAGE (caller sources the loop env):
 *   node tools/backfill-scheduled-covers.ts                 # DRY RUN (plan only)
 *   node tools/backfill-scheduled-covers.ts --commit            # execute all coverable
 *   node tools/backfill-scheduled-covers.ts --commit --only ID  # only that live post id
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPost, deletePosts, listPosts, pollJob } from "./post-to-publer.ts";
import { COVER_COLOR_ORDER, videoMediaObjectWithCover, loadCoverManifest } from "../hermes/src/covers.ts";

const REPO = join(import.meta.dirname, "..");
const RUNS_DIR = process.env.HERMES_RUNS_DIR || "/home/ec2-user/hermes-data/runs";
const AB_DB = join(REPO, "ab-testing", "ab-database.json");
const SAFETY_MS = 20 * 60 * 1000;
const PLATFORM_BY_ACCT: Record<string, "instagram" | "tiktok"> = {
  "6a5fc9dc4ccd63dc1f041549": "instagram",
  "6a5fc5451bee22495517bcc5": "tiktok",
};

const log = (m: string) => console.error(`[backfill-covers] ${m}`);
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
function coverApplied(post: any, coverId: string): boolean {
  const md = Array.isArray(post?.media) ? post.media[0] : null;
  if (!md) return false;
  const th = Array.isArray(md.thumbnails) ? md.thumbnails : [];
  const di = Number(md.default_thumbnail);
  const u = String(th[di]?.real ?? th[di]?.small ?? "");
  return u.includes(coverId);
}

/** run-state videos (for re-persist): {file, run_id, id, index, media_id, caption}. */
function loadRunVideos(): any[] {
  const vids: any[] = [];
  try {
    for (const f of readdirSync(RUNS_DIR).filter((x) => x.endsWith(".json"))) {
      let run: any;
      try { run = JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")); } catch { continue; }
      for (const v of run.videos || []) vids.push({ file: join(RUNS_DIR, f), id: v.id, media_id: v.publer?.media_id, caption: v.caption });
    }
  } catch {}
  return vids;
}
function repersist(mediaId: string, caption: string, oldId: string, newId: string, byMedia: Map<string, any>, byCap: Map<string, any>): string {
  let v = byMedia.get(String(mediaId)) || byCap.get(normCap(caption)) || null;
  let where = "none";
  if (v && v.file) {
    try {
      const run = JSON.parse(readFileSync(v.file, "utf8"));
      const vid = (run.videos || []).find((x: any) => x.id === v.id);
      if (vid) {
        vid.publer = vid.publer || {};
        const ids = new Set<string>([...(vid.publer.post_ids || [])].map(String));
        ids.delete(oldId);
        ids.add(newId);
        vid.publer.post_ids = [...ids];
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
        if (String(rec.publer_post_id) === oldId) { rec.prior_cover_swap_post_id = oldId; rec.publer_post_id = newId; changed = true; }
      }
      if (changed) { db.updated_at = new Date().toISOString(); writeFileSync(AB_DB, JSON.stringify(db, null, 2) + "\n"); where += " + ab-db"; }
    }
  } catch (e) { log(`  repersist ab-db failed: ${e instanceof Error ? e.message : String(e)}`); }
  return where;
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const onlyId = args.includes("--only") ? String(args[args.indexOf("--only") + 1]) : undefined;

  const manifest = loadCoverManifest();
  if (!manifest) throw new Error("no covers manifest at ab-testing/covers-manifest.json — render + upload covers first");

  const live = await gatherScheduled();
  const runVids = loadRunVideos();
  const byMedia = new Map(runVids.filter((v) => v.media_id).map((v) => [String(v.media_id), v]));
  const byCap = new Map<string, any>();
  for (const v of runVids) { const c = normCap(v.caption); if (!c) continue; if (byCap.has(c)) { const p = byCap.get(c); if (p && p.id !== v.id) byCap.set(c, null); } else byCap.set(c, v); }

  const coverable = live.filter((p) => Array.isArray(p.media) && p.media[0]?.id && p.text);
  // group by caption (the 2 platform twins share it) → rotate colors per video, twins differ
  const videoKeys = [...new Set(coverable.map((p) => normCap(p.text)))].sort((a, b) => {
    const e = (k: string) => Math.min(...coverable.filter((p) => normCap(p.text) === k).map((p) => Date.parse(p.scheduled_at)));
    return e(a) - e(b);
  });
  const colorFor = (p: any) => {
    const j = videoKeys.indexOf(normCap(p.text));
    const off = (PLATFORM_BY_ACCT[String(p.account_id)] || "instagram") === "tiktok" ? 2 : 0;
    const n = COVER_COLOR_ORDER.length;
    return COVER_COLOR_ORDER[(((j + off) % n) + n) % n];
  };

  let plans = coverable
    .map((p) => ({ oldId: String(p.id), accountId: String(p.account_id), platform: PLATFORM_BY_ACCT[String(p.account_id)] || "?", color: colorFor(p), scheduledAt: stripMs(p.scheduled_at) }))
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  if (onlyId) plans = plans.filter((p) => p.oldId === onlyId);

  const now = Date.now();
  console.log(`\n=== BACKFILL SCHEDULED COVERS (${commit ? "COMMIT" : "DRY RUN"}) ===`);
  console.log(`live scheduled: ${live.length} | coverable plans: ${plans.length}`);
  for (const p of plans) {
    const mins = Math.round((Date.parse(p.scheduledAt) - now) / 60000);
    const safe = Date.parse(p.scheduledAt) - now < SAFETY_MS;
    console.log(`  ${p.scheduledAt} ${p.platform.padEnd(9)} bg=${p.color.padEnd(6)} old=${p.oldId} (in ${mins}m)${safe ? "  [SKIP <20m]" : ""}`);
  }
  if (!commit) { console.log("\n(dry run — no mutations. --commit to apply, --only ID for a canary.)"); return; }

  const results: any[] = [];
  for (const plan of plans) {
    try {
      const fresh = (await gatherScheduled()).find((p) => String(p.id) === plan.oldId);
      if (!fresh || fresh.state !== "scheduled") { results.push({ ...plan, skipped: true, reason: `not scheduled (state=${fresh?.state ?? "gone"})` }); log(`SKIP ${plan.oldId}: not scheduled`); continue; }
      if (Date.parse(fresh.scheduled_at) - Date.now() < SAFETY_MS) { results.push({ ...plan, skipped: true, reason: "within 20m safety window" }); log(`SKIP ${plan.oldId}: safety window`); continue; }
      const caption = String(fresh.text ?? ""); if (!caption) throw new Error(`no caption ${plan.oldId}`);
      const vmedia = Array.isArray(fresh.media) ? fresh.media[0] : null; if (!vmedia?.id) throw new Error(`no media ${plan.oldId}`);
      const cover = manifest.covers[plan.color]; if (!cover?.id) throw new Error(`no cover media for ${plan.color}`);
      const existingThumbs = (Array.isArray(vmedia.thumbnails) ? vmedia.thumbnails : []).map((t: any) => ({ ...(t.id ? { id: String(t.id) } : {}), small: String(t.small), real: String(t.real) }));
      const mediaObject = videoMediaObjectWithCover(String(vmedia.id), cover, existingThumbs);

      log(`=== ${plan.platform} bg=${plan.color} old=${plan.oldId} @ ${plan.scheduledAt} (media ${vmedia.id}, cover ${cover.id}@${(mediaObject as any).default_thumbnail}) ===`);
      // SINGLE-ID delete + STRICT confirm (exactly the one intended, nothing else).
      const del = await deletePosts([plan.oldId]);
      const deleted = (del?.deleted_ids ?? []).map(String);
      if (!(deleted.length === 1 && deleted[0] === plan.oldId)) {
        results.push({ ...plan, error: `UNSAFE delete result ${JSON.stringify(del)} — expected exactly [${plan.oldId}]; ABORT` });
        log(`ABORT ${plan.oldId}: delete not exactly one id (${JSON.stringify(deleted)})`);
        break;
      }
      log(`  deleted exactly [${plan.oldId}]; recreating with cover`);
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
      const where = repersist(String(vmedia.id), caption, plan.oldId, String(np.id), byMedia, byCap);
      log(`  new=${np.id} state=${np.state} at=${np.scheduled_at} feed=${np?.details?.feed ?? "n/a"} default_thumb=${np?.media?.[0]?.default_thumbnail} coverApplied=${okCover} repersist=${where}`);
      if (!okState || !okTime || !okFeed) { results.push({ ...plan, new_id: String(np.id), applied: false, error: `identity check failed (state=${okState} time=${okTime} feed=${okFeed})` }); log(`STOP: identity check`); break; }
      if (!okCover) { results.push({ ...plan, new_id: String(np.id), applied: false, error: `cover not applied` }); log(`STOP: cover not applied`); break; }
      results.push({ ...plan, new_id: String(np.id), cover_media: cover.id, applied: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`ERROR ${plan.oldId}: ${msg}`);
      results.push({ ...plan, error: msg });
      break;
    }
  }
  console.log(`\n=== RESULT ===`);
  console.log(JSON.stringify({ ok: results.every((r) => !r.error), applied: results.filter((r) => r.applied).length, results: results.map((r) => ({ old: r.oldId, new: r.new_id, platform: r.platform, color: r.color, applied: !!r.applied, skipped: !!r.skipped, error: r.error, reason: r.reason })) }, null, 2));
  if (results.some((r) => r.error)) process.exitCode = 1;
}

main().catch((e) => { console.error(`[backfill-covers] FATAL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
