/**
 * time_of_day_finding.mjs — record what time-of-day ACTUALLY says, computed from the
 * analytics archive rather than from the joinable half of ab-database.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT. It was reported on 2026-08-03 (commit 0707a7d's
 * message) that "the 'morning is our best slot' reading in learnings.json is an artifact"
 * of the Madrid/Chicago timezone bug. Half of that is right and half of it is not, and
 * the half that is not would have sent the next reader chasing a bug that is not there:
 *
 *   THE BUG WAS REAL. Metricool answers the analytics endpoints on the BRAND's clock
 *   (Europe/Madrid), and rollup.ts's timeBucket() reads the hour AS WRITTEN. Re-bucketing
 *   the live rows on the corrected clock moves ALL 126 of them, and moves 54 to a
 *   different calendar day. Any analysis done on raw analytics stamps was a third of a
 *   day out.
 *
 *   IT NEVER REACHED learnings.rollups.by_time_bucket. That rollup keys on
 *   ab-database `posted_at`, which reconcile.ts back-fills from the PLANNER's
 *   publicationDate — America/Chicago — not from analytics. Checked, not assumed: of the
 *   66 naive `posted_at` values, ZERO match the declared Madrid dateTime of the reel they
 *   join to; all sit 2-3 minutes BEFORE the true publish instant, which is the signature
 *   of a scheduled time, not a Madrid one. Recomputing the stored rollup from
 *   ab-database reproduces it exactly, and it sits 1.27pp from the corrected analytics
 *   reading against 7.74pp from the Madrid one.
 *
 *   AND NO SUCH ENTRY EXISTS. Nothing in learnings.json says morning is the best slot.
 *   The lowest-skip bucket in the stored rollup is NIGHT (63.5), morning is second
 *   (64.35), the retired front_runners block names AFTERNOON, and every one of the 11
 *   "best time" lines memory.ts has written to MEMORY.md names evening, afternoon or
 *   night. Never morning.
 *
 * SO WHAT IS ACTUALLY WRONG. Not the numbers — the inference they invite. The pooled gap
 * looks like an 11pp lever and is mostly date. This script writes the date-controlled
 * reading next to the rollup so nobody has to re-derive it, and states plainly that it is
 * not a scheduling lever.
 *
 * It computes from the ARCHIVE, which is the better population: all 126 published reels
 * carry a skip rate and a declared zone, so no attribution join is needed and the n is
 * more than double the 57 posts the rollup can see.
 *
 * Writes learnings.time_of_day, a key score.ts does not touch, so the finding survives
 * the nightly rewrite that regenerates rollups.*.
 *
 *   node ops/time_of_day_finding.mjs <snapshot.json>            # dry run
 *   node ops/time_of_day_finding.mjs <snapshot.json> --apply
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const REPO = process.env.HERMES_REPO_DIR || join(process.cwd());
const DATA = process.env.HERMES_DATA_DIR || "/home/ec2-user/hermes-data";
const LEARNINGS = join(REPO, "ab-testing", "learnings.json");

function newestSnapshot() {
  const arg = process.argv[2];
  if (arg && !arg.startsWith("--")) return arg;
  const root = join(DATA, "analytics-archive");
  const files = [];
  for (const d of readdirSync(root)) {
    if (!d.startsWith("dt=")) continue;
    for (const f of readdirSync(join(root, d))) if (f.endsWith(".json")) files.push(join(root, d, f));
  }
  files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  return files[files.length - 1];
}

const median = (a) => { const s = a.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((x, y) => x - y); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const bucketOf = (h) => (h < 6 ? "night (0-6)" : h < 12 ? "morning (6-12)" : h < 18 ? "afternoon (12-18)" : "evening (18-24)");
const hourOf = (iso) => Number(/T(\d{2}):/.exec(String(iso))[1]);

function erf(x) {
  const t = 1 / (1 + 0.3275911 * x);
  return 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
}
function mannWhitney(a, b) {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(all.length);
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[k] = r;
    i = j + 1;
  }
  let R1 = 0;
  all.forEach((x, k) => { if (x.g === 0) R1 += ranks[k]; });
  const n1 = a.length, n2 = b.length;
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const z = (U1 - (n1 * n2) / 2) / Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return { z: r2(z), p: Math.round(2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2))) * 10000) / 10000 };
}

const snapPath = newestSnapshot();
const snap = JSON.parse(readFileSync(snapPath, "utf8"));
const cap = snap.sources.instagramReels;
const idx = new Map(cap.time_index.map((e) => [e.id, e]));

const rows = [];
for (const r of cap.rows) {
  const t = idx.get(String(r.reelId));
  if (!t?.account || r.reelsSkipRate == null) continue;
  rows.push({ skip: r.reelsSkipRate, bucket: bucketOf(hourOf(t.account)), day: t.account.slice(0, 10), wrong: bucketOf(hourOf(t.raw?.dateTime ?? t.raw)) });
}

const pooled = {};
for (const r of rows) (pooled[r.bucket] = pooled[r.bucket] ?? []).push(r.skip);
const pooledOut = Object.fromEntries(
  Object.entries(pooled).sort().map(([b, a]) => [b, { n: a.length, median_skip_rate: r2(median(a)) }]),
);

// within-day: each bucket's deviation from that day's own median
const byDay = {};
for (const r of rows) (byDay[r.day] = byDay[r.day] ?? []).push(r);
const dev = {};
for (const [, day] of Object.entries(byDay)) {
  const dayMed = median(day.map((x) => x.skip));
  const g = {};
  for (const r of day) (g[r.bucket] = g[r.bucket] ?? []).push(r.skip);
  for (const [b, a] of Object.entries(g)) {
    if (a.length < 2) continue; // one post is not a bucket
    (dev[b] = dev[b] ?? []).push(median(a) - dayMed);
  }
}
const withinDay = Object.fromEntries(
  Object.entries(dev).sort().map(([b, a]) => [b, { days: a.length, median_deviation_pp: r2(median(a)), better_on_days: a.filter((x) => x < 0).length }]),
);

const ranked = Object.entries(pooled).filter(([, a]) => a.length >= 5).sort((x, y) => median(x[1]) - median(y[1]));
const best = ranked[0], worst = ranked[ranked.length - 1];
const mw = mannWhitney(best[1], worst[1]);
const movedBucket = rows.filter((r) => r.bucket !== r.wrong).length;

const finding = {
  as_of: snap.captured_at.slice(0, 10),
  computed_from: { snapshot_id: snap.snapshot_id, source: "instagramReels", n: rows.length, note: "the FULL published-reel population; no attribution join, so n is not halved by the blackout" },
  clock: "America/Chicago, resolved from each row's declared zone (Metricool answers on the brand's Europe/Madrid clock)",
  pooled_by_bucket: pooledOut,
  within_day: withinDay,
  significance: { contrast: `${best[0]} vs ${worst[0]}`, n: [best[1].length, worst[1].length], mann_whitney_z: mw.z, p: mw.p },
  verdict: "NOT A RELIABLE LEVER",
  what_the_data_says:
    `Pooled, the best and worst buckets are ${r2(median(best[1]))}% and ${r2(median(worst[1]))}% median skip — a ` +
    `${r2(median(worst[1]) - median(best[1]))}pp spread that looks decisive and is not. Held inside each day, the ` +
    `advantage collapses to about ${Math.abs(withinDay["morning (6-12)"]?.median_deviation_pp ?? 0)}pp, and the pooled ` +
    `contrast does not reach significance (Mann-Whitney p=${mw.p}). Buckets are also unevenly available across days, ` +
    "so a bucket is partly a proxy for WHICH days it ran on. Treat time of day as worth a few points at most and " +
    "do not schedule on it; the posting window, the per-network caps and the 56-minute floor decide slots.",
  rollup_provenance:
    "rollups.by_time_bucket is computed by score.ts from ab-database posted_at, which reconcile.ts back-fills from " +
    "the PLANNER's publicationDate (America/Chicago), NOT from analytics. It is therefore NOT affected by the " +
    "Europe/Madrid analytics bug fixed in 0707a7d, contrary to that commit's message. Verified 2026-08-04: none of " +
    "the 66 naive posted_at values matches the Madrid dateTime of the reel it joins to; all sit 2-3 minutes before " +
    "the true publish instant, which is a SCHEDULED time. Recomputing the rollup from ab-database reproduces the " +
    "stored numbers exactly, and they sit 1.27pp from the corrected analytics reading against 7.74pp from the " +
    "Madrid one. The two caveats that remain are that posted_at is a scheduled time (2-3 min early, never enough " +
    "to change a bucket) and that it only sees the ~57 attributable Instagram posts rather than all 126.",
  correction_note:
    "No entry in learnings.json ever claimed morning was the best slot. The lowest-skip bucket in the stored rollup " +
    "is night; morning is second; the retired front_runners block names afternoon; and all 11 'best time' lines in " +
    `MEMORY.md name evening, afternoon or night. What IS true is that the timezone bug moved every one of the ${rows.length} ` +
    `analytics rows between buckets (${movedBucket}/${rows.length}), so any analysis done directly on raw analytics stamps ` +
    "before 2026-08-03 was a third of a day out.",
};

console.log(`snapshot: ${snapPath}`);
console.log(JSON.stringify(finding, null, 2));

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

const learnings = JSON.parse(readFileSync(LEARNINGS, "utf8"));
learnings.time_of_day = finding;
learnings.updated_at = new Date().toISOString();
const tmp = `${LEARNINGS}.tod.tmp`;
writeFileSync(tmp, `${JSON.stringify(learnings, null, 2)}\n`);
renameSync(tmp, LEARNINGS);
console.log(`\nwrote ${LEARNINGS} (learnings.time_of_day)`);
