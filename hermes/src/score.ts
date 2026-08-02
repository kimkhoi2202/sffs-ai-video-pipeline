/**
 * score.ts — cadence step (a): pull matured analytics (Metricool, ~24h lag), join to
 * ab-database.json by platform_post_id, refresh metrics, and recompute the
 * decision rollups in learnings.json (medians + front-runners). Append-only logs.
 *
 * Robust to the common case where posts haven't matured yet: it simply updates
 * whatever has metrics and recomputes from those.
 */
import { pullInsights, type FlatInsight as FlatPostInsight } from "./insights.ts";
import { readJSON, writeJSONAtomic } from "./state.ts";
import { CONFIG } from "./config.ts";
import { info, warn } from "./log.ts";
import { groupMedian, hasMatureMetrics, timeBucket } from "./rollup.ts";
import { indexInsights, matchInsight } from "./reconcile.ts";

export interface ScoreResult {
  from: string;
  to: string;
  pulled: number;
  updated: number;
  note: string;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Metricool returns the whole brand's rows in one call, so there is no paging and no
 * per-account fan-out to do — but this used to be called once PER ACCOUNT ID, each time
 * re-pulling every network and then filtering to one. With three networks live that is
 * nine analytics requests to obtain three responses, all of them retry-wrapped. Pull
 * once, keep the rows whose account we recognise.
 */
async function pullAllAccounts(from: string, to: string): Promise<FlatPostInsight[]> {
  const known = new Set(CONFIG.ACCOUNT_IDS);
  const all = await pullInsights(from, to);
  return all.filter((r) => known.has(r.account_id));
}

/**
 * Build the persisted metrics object for one matured post.
 *
 * Extracted so the suite can drive the REAL mapping end-to-end into the REAL rollup
 * and the REAL promotion detector. Asserting on a hand-built metrics object would have
 * proved nothing here: the whole failure was that this mapping silently dropped
 * skip_rate while every test around it stayed green.
 */
export function metricsFromInsight(f: FlatPostInsight, prev: any, asOf: string): Record<string, unknown> {
  return {
    ...(prev ?? {}),
    reach: f.reach ?? prev?.reach ?? null,
    video_views: f.views ?? null,
    reactions: f.likes ?? null,
    comments: f.comments ?? null,
    shares: f.shares ?? null,
    saves: f.saves ?? null,
    eng_rate: f.engagement_rate ?? prev?.eng_rate ?? null,
    // 3-SECOND SKIP RATE — the metric promotion actually judges on, and the reason
    // the gate could not fire at any sample size: insights.ts read it correctly and
    // this mapping then dropped it, so no row in ab-database.json ever carried one.
    // LOWER IS BETTER. Instagram-only, so a TikTok row keeps a null rather than a
    // fabricated zero.
    skip_rate: f.skip_rate ?? prev?.skip_rate ?? null,
    // FETCHED EVERY CYCLE SINCE THE METRICOOL MIGRATION AND NEVER PERSISTED. Both come
    // back on every Instagram row and both are load-bearing: average watch time is the
    // second-strongest predictor of reach on this account after skip rate (14s+ medians
    // 1,269 views against 137 below 5s), and duration is how you tell a retention
    // difference from a length difference. Neither reached a single ab-database row.
    average_watch_time: f.average_watch_time ?? prev?.average_watch_time ?? null,
    duration_seconds: f.duration_seconds ?? prev?.duration_seconds ?? null,
    as_of: asOf,
    source: "api",
  };
}

/**
 * The LIVE per-network analytics totals, written every cycle to DATA_DIR.
 *
 * WHY A SNAPSHOT AND NOT JUST THE JOIN. The goal rollup used to sum
 * ab-database.metrics.video_views, which only counts posts the reconcile join has
 * managed to attach a native post id to. On 2026-08-02 that was 45 of 89 Instagram
 * rows and 0 of 43 YouTube rows, so the dashboard reported 9,500 views over 28 posts
 * while the live analytics said 39,382 over 101 — under by a factor of four, in the
 * direction that flatters. The join is worth fixing on its own merits (it is what
 * attributes a view to a FORMAT), but the TOTAL should never have depended on it: the
 * analytics API knows the number directly.
 *
 * Rows are kept, not just sums, so the goal window can still be applied by publish
 * date. ~200 rows of four fields — small enough to write whole each cycle.
 */
export interface AnalyticsSnapshotRow {
  network: string;
  post_id: string;
  published_at: string | null;
  views: number;
}
export interface AnalyticsSnapshot {
  updated_at: string;
  from: string;
  to: string;
  by_network: Record<string, { posts: number; views: number }>;
  totals: { posts: number; views: number };
  rows: AnalyticsSnapshotRow[];
}

/** Pure: fold flat insights into the snapshot shape. */
export function buildAnalyticsSnapshot(flat: FlatPostInsight[], from: string, to: string, now = new Date()): AnalyticsSnapshot {
  const byNetwork: Record<string, { posts: number; views: number }> = {};
  const rows: AnalyticsSnapshotRow[] = [];
  for (const f of flat) {
    const network = String(f.network ?? "unknown");
    const views = Number(f.views) || 0;
    byNetwork[network] = byNetwork[network] ?? { posts: 0, views: 0 };
    byNetwork[network].posts++;
    byNetwork[network].views += views;
    rows.push({ network, post_id: String(f.post_id ?? ""), published_at: f.scheduled_at ?? null, views });
  }
  return {
    updated_at: now.toISOString(),
    from,
    to,
    by_network: byNetwork,
    totals: {
      posts: rows.length,
      views: Object.values(byNetwork).reduce((s, n) => s + n.views, 0),
    },
    rows,
  };
}

export async function pullAndScore(): Promise<ScoreResult> {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 30 * 86400_000));

  let flat: FlatPostInsight[] = [];
  try {
    flat = await pullAllAccounts(from, to);
  } catch (e) {
    warn("analytics pull failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }
  // Write the LIVE totals FIRST, before the join has a chance to lose anything. This
  // is what the goal rollup reads, so the headline number no longer depends on how
  // many posts reconcile has managed to attribute this cycle.
  try {
    writeJSONAtomic(CONFIG.ANALYTICS_SNAPSHOT, buildAnalyticsSnapshot(flat, from, to));
  } catch (e) {
    warn("analytics snapshot write failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }

  // Index by the network-native post_id. reconcile() runs BEFORE this in cycle.ts, so a
  // post a human has since published already has its platform_post_id filled in and
  // joins on the first pass. See reconcile.ts.
  const idx = indexInsights(flat);

  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) {
    return { from, to, pulled: flat.length, updated: 0, note: "ab-database.json missing/invalid; skipped join" };
  }

  let updated = 0;
  for (const p of db.posts) {
    const f = matchInsight(p, idx);
    if (!f) continue;
    p.metrics = metricsFromInsight(f, p.metrics, to);
    updated++;
  }

  // recompute variant_families + by_platform rollups from posts that have metrics.
  // Rollup math is the pure, dependency-free rollup.ts (also used by the offline
  // introspection probe + shared shape with the Python promotion engine).
  // Same definition of "matured" the rollup uses, rather than a second inline copy
  // that had drifted onto eng_rate only.
  const withMetrics = db.posts.filter((p: any) => hasMatureMetrics(p));

  const famRollup = groupMedian(db.posts, (p) => p.variant?.family);
  // ARM-level rollup (variant.label, falling back to variant.arm): the granularity
  // the default-promotion engine compares against the incumbent "control".
  const armRollup = groupMedian(db.posts, (p) => p.variant?.label ?? p.variant?.arm);
  const platRollup = groupMedian(db.posts, (p) => p.platform);
  const tagRollup = groupMedian(db.posts, (p) => p.hashtag_set);
  // by time-of-day the post went live (from posted_at, back-filled by reconcile) —
  // the "best time to post" signal. Posts without a posted_at are excluded.
  const timeRollup = groupMedian(db.posts, (p) => timeBucket(p.posted_at));

  db.updated_at = new Date().toISOString();
  // merge counts into existing variant_families without destroying notes
  db.variant_families = db.variant_families ?? {};
  for (const [k, v] of Object.entries(famRollup)) db.variant_families[k] = { ...(db.variant_families[k] ?? {}), ...(v as object) };
  db.aggregate_cuts = db.aggregate_cuts ?? {};
  db.aggregate_cuts.by_platform = platRollup;
  db.aggregate_cuts.by_variant_arm = armRollup;
  db.aggregate_cuts.by_time_bucket = timeRollup;
  writeJSONAtomic(CONFIG.AB_DB, db);

  // learnings
  const learnings = readJSON<any>(CONFIG.LEARNINGS, {});
  learnings.rollups = learnings.rollups ?? {};
  learnings.rollups.by_variant_family = famRollup;
  // by_variant_arm is what hermes-nous/sffs/promote.py reads to detect a test arm
  // that clearly beats the current default ("control"). See promote.py.
  learnings.rollups.by_variant_arm = armRollup;
  learnings.rollups.by_platform = platRollup;
  learnings.rollups.by_hashtag_set = tagRollup;
  learnings.rollups.by_time_bucket = timeRollup;

  // ── front_runners is RETIRED (2026-08-02) ──────────────────────────────────
  //
  // It selected a "winner" on median_eng_rate and wrote it into learnings.json
  // nightly as a conclusion, and memory.ts then copied that conclusion into
  // MEMORY.md as the agent's own recollection. The problem is that
  // content-defaults.json ABANDONED median_eng_rate as unreliable for this account
  // — "reach here is bimodal and views are unreliable at this sample size" — and
  // moved promotion onto skip rate. So the loop was retiring a metric in one file
  // and still crowning a champion with it in another, on samples as small as three.
  //
  // Nothing is deleted. The last computed block is MOVED under `retired` with the
  // reason attached, so the history is auditable and nothing downstream that reads
  // it finds a surprise null. The raw rollups above are untouched: they are
  // measurements, and measurements were never the problem — the conclusion was.
  if (learnings.front_runners && !learnings.retired?.front_runners) {
    learnings.retired = learnings.retired ?? {};
    learnings.retired.front_runners = {
      ...learnings.front_runners,
      retired_at: to,
      reason:
        "Selected on median_eng_rate, which content-defaults.json already abandoned as unreliable for this " +
        "account, and often on n<5. Superseded by the pinned production format; see dimensions.ts PINNED.",
    };
  }
  delete learnings.front_runners;

  // What production is actually doing, stated as a FACT rather than inferred as a
  // winner. This is what memory.ts and the dashboard read now.
  learnings.pinned_format = {
    as_of: to,
    arm: "pinned-format",
    description: "3 mixed questions, cold-plate open, full narration, cliffhanger ending, 5s, short counter, branded cover",
    chosen_on: "3-second skip rate vs views across all published Instagram reels (monotonic over 8 buckets, ~10x spread)",
    note: "Exploitation phase: no A/B rotation. Questions inside the format are fresh every video and still pass every gate.",
  };
  learnings.scoring_log = learnings.scoring_log ?? [];
  learnings.scoring_log.push({ date: to, from, to, pulled: flat.length, updated, n_with_metrics: withMetrics.length });
  if (learnings.scoring_log.length > 60) learnings.scoring_log = learnings.scoring_log.slice(-60);
  learnings.updated_at = new Date().toISOString();
  writeJSONAtomic(CONFIG.LEARNINGS, learnings);

  const note = updated === 0 ? "no matured metrics yet (analytics lag ~24h) — rollups recomputed from existing" : "metrics refreshed";
  info("scoring done", { from, to, pulled: flat.length, updated, note });
  return { from, to, pulled: flat.length, updated, note };
}
