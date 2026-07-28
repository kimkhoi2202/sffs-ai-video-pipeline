/**
 * yt_catalogue_backfill.mjs — seed the YouTube channel from the PROVEN catalogue.
 *
 * WHY NOT JUST "TOP N BY VIEWS". Ordering the catalogue purely by views puts the wrong
 * videos first, and the reason is concrete rather than theoretical. A large block of the
 * high-view tail is TikTok-only, and those views came from For You distribution in a
 * window (2026-07-19..07-23) that the account no longer has — a view count with no
 * retention signal behind it is evidence that an algorithm once pushed the video, not
 * that it holds an audience. Worse, several videos that WON on TikTok lost badly on
 * Instagram (996 vs 133; 307 vs 110 at an 89.3% skip rate, the worst in the campaign).
 * Leading a channel that has zero history with those is the worst possible first
 * impression. So the order is views-ranked and then SKIP-RATE GATED:
 *
 *   1. de-duplicate first — the same video runs on both networks and would otherwise
 *      be ranked twice;
 *   2. rank by peak views;
 *   3. DROP anything with no measured retention at all (Instagram is the only network
 *      that reports a 3-second skip rate, so TikTok-only == unmeasured);
 *   4. DROP anything whose skip rate is WORSE than the campaign median.
 *
 * IDENTITY IS THE HARD PART, and getting it wrong is worse than dropping a video: it
 * attaches a real performance record to a video that did not earn it. A published post
 * is tied back to a render three ways, in descending confidence — the /go/<id>
 * attribution link the caption carries, then a UNIQUE render-duration match corroborated
 * by the caption, and nothing else. Captions alone are NOT enough: a whole run can share
 * one caption, so caption-only matching silently merges different videos.
 *
 * EVERY PICK IS RE-RENDERED, never re-uploaded. The existing masters carry the Instagram
 * or TikTok outro rather than YouTube's SUBSCRIBE CTA, and the Instagram cut is laid out
 * for the IG safe box, which does NOT clear the Shorts caption band (measured: it sits
 * 55px inside it, where the YouTube cut clears by 84px). Re-rendering from the stored
 * props sidecar reproduces the SAME video through the corrected path.
 *
 * A pick whose PROPS ARE GONE IS DROPPED, not reconstructed. Rebuilding a video from a
 * surviving caption produces a lookalike carrying the original's performance record,
 * which corrupts the premise of the exercise.
 *
 * Usage:  node ops/yt_catalogue_backfill.mjs [--dry] [--limit N]
 *         --dry (default) prints the ranked selection and the slot plan, writes nothing.
 */
const REPO = "/home/ec2-user/sffs-ai-video-pipeline";
const M = await import(`${REPO}/hermes/src/metricool.ts`);
const R = await import(`${REPO}/hermes/src/render.ts`);
const A = await import(`${REPO}/hermes/src/attribution.ts`);
const S = await import(`${REPO}/hermes/src/s3.ts`);
const L = await import(`${REPO}/hermes/src/loopPublish.ts`);
const AP = await import(`${REPO}/hermes/src/approval.ts`);
const P = await import(`${REPO}/hermes/src/postingPolicy.ts`);
const { CONFIG } = await import(`${REPO}/hermes/src/config.ts`);
const fs = await import("node:fs");
const path = await import("node:path");

const DRY = !process.argv.includes("--execute");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 0);
const FROM = "2026-06-01T00:00:00", TO = new Date().toISOString().slice(0, 19);
const BOARD = ["2026-01-01T00:00:00", "2030-12-31T23:59:59"];

const norm = (t) => String(t ?? "").normalize("NFKC").toLowerCase()
  .replace(/https?:\/\/\S+/g, " ").replace(/#[\p{L}\p{N}_]+/gu, " ")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ── the renders catalogue: every video id we can still re-render ─────────────
const RD = CONFIG.RENDERS_DIR;
const catalogue = new Map(); // vid -> { platform -> {secs, sidecar} }
for (const f of fs.readdirSync(RD)) {
  const m = /^(.*)\.(instagram|tiktok|youtube)\.props\.json$/.exec(f);
  if (!m) continue;
  let sp; try { sp = JSON.parse(fs.readFileSync(path.join(RD, f), "utf8")); } catch { continue; }
  if (!catalogue.has(m[1])) catalogue.set(m[1], {});
  catalogue.get(m[1])[m[2]] = { secs: Number(sp.totalFrames || 0) / 30, sidecar: path.join(RD, f) };
}

// ── captions we know per video id, for corroborating a duration match ────────
const capsById = new Map();
for (const f of fs.existsSync(CONFIG.RUNS_DIR) ? fs.readdirSync(CONFIG.RUNS_DIR) : []) {
  if (!f.endsWith(".json")) continue;
  try { for (const v of (JSON.parse(fs.readFileSync(path.join(CONFIG.RUNS_DIR, f), "utf8")).videos ?? []))
    if (v.caption) capsById.set(v.id, norm(v.caption)); } catch { /* skip */ }
}

// ── every published record, both networks ────────────────────────────────────
const igRows = await M.instagramReels(FROM, TO);
const ttRows = await M.tiktokPosts(FROM, TO);
const raw = await (async () => {
  // instagramReels() drops the caption, which is a join key here; re-read it raw.
  const q = new URLSearchParams({ userId: CONFIG.METRICOOL_USER_ID, blogId: CONFIG.METRICOOL_BLOG_ID, from: FROM, to: TO, timezone: CONFIG.METRICOOL_TZ });
  const res = await fetch(`${CONFIG.METRICOOL_BASE_URL}/v2/analytics/reels/instagram?${q}`, { headers: { "X-Mc-Auth": CONFIG.METRICOOL_USER_TOKEN } });
  const j = JSON.parse(await res.text());
  return new Map((j.data ?? j).map((r) => [String(r.reelId), r]));
})();

const records = [];
for (const r of igRows) {
  const full = raw.get(String(r.platformPostId)) ?? {};
  const content = String(full.content ?? "");
  records.push({ net: "instagram", pid: r.platformPostId, views: r.views ?? 0, skip: r.skipRate,
    url: r.url, dur: r.durationSeconds ?? 0, cap: content, ncap: norm(content),
    go: (/\/go\/([A-Za-z0-9\-_]+)/.exec(content) || [])[1] || null });
}
for (const r of ttRows) records.push({ net: "tiktok", pid: r.platformPostId, views: r.views ?? 0,
  skip: null, url: r.url, dur: r.durationSeconds ?? 0, cap: "", ncap: "", go: null });

// ── resolve each record to a video id ────────────────────────────────────────
// The /go/ link is exact. A duration match is only accepted when it is UNIQUE across
// the whole catalogue AND the caption agrees, because a run can share one caption.
function resolve(rec) {
  if (rec.go) return { vid: rec.go, how: "go-link", confident: catalogue.has(rec.go) };
  if (!rec.dur) return { vid: null, how: "no-duration-signal", confident: false };
  const hits = [...catalogue.entries()].filter(([, byPlat]) =>
    byPlat[rec.net] && Math.abs(byPlat[rec.net].secs - rec.dur) <= 1);
  if (hits.length !== 1) return { vid: null, how: `duration-${hits.length === 0 ? "unmatched" : "ambiguous"}`, confident: false };
  const vid = hits[0][0], known = capsById.get(vid);
  if (known === undefined) return { vid, how: "duration-unique", confident: false };
  if (known !== rec.ncap) return { vid: null, how: "duration-match-caption-disagrees", confident: false };
  return { vid, how: "duration+caption", confident: true };
}
for (const rec of records) Object.assign(rec, resolve(rec));

// ── de-duplicate, then rank, then gate ───────────────────────────────────────
const groups = new Map();
for (const rec of records) {
  const key = rec.vid ?? `unresolved:${rec.net}:${rec.pid}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(rec);
}
const videos = [...groups.entries()].map(([key, recs]) => {
  const igr = recs.filter((r) => r.net === "instagram"), ttr = recs.filter((r) => r.net === "tiktok");
  const skips = igr.map((r) => r.skip).filter((s) => s !== null && s !== undefined);
  return { vid: recs[0].vid, how: recs[0].how, confident: recs[0].confident,
    ig: igr.length ? Math.max(...igr.map((r) => r.views)) : null,
    tt: ttr.length ? Math.max(...ttr.map((r) => r.views)) : null,
    peak: Math.max(...recs.map((r) => r.views)),
    skip: skips.length ? Math.min(...skips) : null,
    nets: [...new Set(recs.map((r) => r.net))].sort().join("+"),
    cap: (igr[0] ?? recs[0]).cap };
}).sort((a, b) => b.peak - a.peak);

const MED = median(videos.map((v) => v.skip).filter((s) => s !== null));
console.log(`published records ${records.length} -> ${videos.length} distinct videos; campaign skip median ${MED}%\n`);

const sidecarOf = (vid) => { const c = catalogue.get(vid) ?? {};
  return (c.instagram ?? c.tiktok ?? c.youtube)?.sidecar ?? null; };

const kept = [], dropped = [];
for (const v of videos) {
  let why = null;
  if (v.skip === null) why = `no retention signal (${v.nets}-only)`;
  else if (v.skip > MED) why = `skip ${v.skip}% worse than the ${MED}% median`;
  else if (!v.confident) why = `identity not certain (${v.how})`;
  else if (!sidecarOf(v.vid)) why = "render props gone — refusing to rebuild a lookalike";
  (why ? dropped : kept).push({ ...v, why, sidecar: why ? null : sidecarOf(v.vid) });
}
const picks = LIMIT ? kept.slice(0, LIMIT) : kept;
console.log(`SELECTED ${picks.length}:`);
picks.forEach((v, i) => console.log(`  ${String(i + 1).padStart(2)}. ${v.vid.padEnd(18)} ${String(v.peak).padStart(5)} views (ig ${v.ig ?? "-"}, tt ${v.tt ?? "-"})  skip ${v.skip}%  [${v.how}]`));
console.log(`\nDROPPED ${dropped.length} (top 12 by views):`);
dropped.slice(0, 12).forEach((v) => console.log(`  ${String(v.peak).padStart(5)} views  skip ${v.skip ?? "none"}  -> ${v.why}`));

// ── render, plan, place ──────────────────────────────────────────────────────
let board = await M.listPosts(...BOARD);
const start = board.length;
console.log(`\nboard census: ${start}`);
const plan = L.planSlots(picks.length, "youtube", board, `yt-catalogue-backfill`, new Date());
console.log(`slot plan (${plan.times.length}):`);
for (const s of plan.spread) console.log(`   ${s.day}: ${s.placed} (room ${s.room}, ramp cap ${P.perDayFor("youtube", s.day)})`);
const slots = plan.times.map(AP.toNaive);
slots.forEach((t, i) => console.log(`   ${t}  <- ${picks[i]?.vid}`));
if (DRY) { console.log("\nDRY RUN (pass --execute to write)"); process.exit(0); }

const baseline = new Set(board.map((p) => String(p.uuid)));
for (let i = 0; i < slots.length; i++) {
  const v = picks[i];
  const r = R.renderYouTubeFromSidecar(v.vid, v.sidecar, {});
  const chk = R.verifyShortForYouTube(r.path);
  if (!chk.ok) { console.error(`HALT: ${v.vid} is not a legal Short: ${chk.problems.join("; ")}`); process.exit(3); }
  const caption = A.withAttribution(v.cap, v.vid);
  const post = await M.createPost({
    text: caption, mediaUrl: S.uploadToS3(r.path, `hermes/yt-backfill/${v.vid}.youtube.mp4`),
    networks: ["youtube"], publicationDate: { dateTime: slots[i], timezone: CONFIG.METRICOOL_TZ },
    youtubeTitle: M.youtubeTitleFrom(caption), draft: false, autoPublish: true,
  });
  console.log(`  [${i + 1}/${slots.length}] ${v.vid} -> ${slots[i]}  uuid=${post.uuid}`);
  // EVERY write can evict a row. Census after each one and halt rather than continue.
  board = await M.listPosts(...BOARD);
  const lost = [...baseline].filter((u) => !board.some((p) => String(p.uuid) === u));
  if (lost.length || board.length !== start + i + 1) {
    console.error(`HALT: census moved unexpectedly (${board.length}, lost ${lost.length})`);
    process.exit(4);
  }
  await new Promise((res) => setTimeout(res, 6000));
}
console.log(`\ndone. board census ${board.length}`);
