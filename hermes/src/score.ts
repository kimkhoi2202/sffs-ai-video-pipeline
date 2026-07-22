/**
 * score.ts — cadence step (a): pull matured analytics (Publer, ~24h lag), join to
 * ab-database.json by platform_post_id, refresh metrics, and recompute the
 * decision rollups in learnings.json (medians + front-runners). Append-only logs.
 *
 * Robust to the common case where posts haven't matured yet: it simply updates
 * whatever has metrics and recomputes from those.
 */
import { getPostInsights, flattenPostInsights, type FlatPostInsight } from "./publer.ts";
import { readJSON, writeJSONAtomic } from "./state.ts";
import { CONFIG } from "./config.ts";
import { info, warn } from "./log.ts";
import { groupMedian, timeBucket } from "./rollup.ts";
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

async function pullAccount(accountId: string, from: string, to: string): Promise<FlatPostInsight[]> {
  const all: FlatPostInsight[] = [];
  for (let page = 0; page < 20; page++) {
    const { posts, total } = await getPostInsights(accountId, { from, to, sort_by: "reach", sort_type: "DESC", page });
    all.push(...flattenPostInsights(posts));
    if (all.length >= total || posts.length === 0) break;
  }
  return all;
}

export async function pullAndScore(): Promise<ScoreResult> {
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 30 * 86400_000));

  let flat: FlatPostInsight[] = [];
  try {
    for (const acc of CONFIG.ACCOUNT_IDS) flat.push(...(await pullAccount(acc, from, to)));
  } catch (e) {
    warn("analytics pull failed (continuing)", { err: e instanceof Error ? e.message : String(e) });
  }
  // Index by BOTH native post_id and Publer id so the join can fall back to
  // publer_post_id when platform_post_id is null (the agent's own posts whose
  // native id has not been reconciled yet). See reconcile.ts.
  const idx = indexInsights(flat);

  const db = readJSON<any>(CONFIG.AB_DB, null);
  if (!db || !Array.isArray(db.posts)) {
    return { from, to, pulled: flat.length, updated: 0, note: "ab-database.json missing/invalid; skipped join" };
  }

  let updated = 0;
  for (const p of db.posts) {
    const f = matchInsight(p, idx);
    if (!f) continue;
    p.metrics = {
      ...(p.metrics ?? {}),
      reach: f.reach ?? p.metrics?.reach ?? null,
      video_views: f.views ?? null,
      reactions: f.likes ?? null,
      comments: f.comments ?? null,
      shares: f.shares ?? null,
      saves: f.saves ?? null,
      eng_rate: f.engagement_rate ?? p.metrics?.eng_rate ?? null,
      as_of: to,
      source: "api",
    };
    updated++;
  }

  // recompute variant_families + by_platform rollups from posts that have metrics.
  // Rollup math is the pure, dependency-free rollup.ts (also used by the offline
  // introspection probe + shared shape with the Python promotion engine).
  const withMetrics = db.posts.filter((p: any) => p.metrics && p.metrics.source !== "pending" && p.metrics.eng_rate != null);

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

  const minN = learnings.conventions?.min_n ?? 3;
  const pickFront = (roll: Record<string, any>) => {
    let best: string | null = null;
    let bestVal = -Infinity;
    for (const [k, v] of Object.entries(roll)) {
      if ((v.n_with_metrics ?? 0) >= minN && v.median_eng_rate != null && v.median_eng_rate > bestVal) {
        best = k;
        bestVal = v.median_eng_rate;
      }
    }
    return best;
  };
  const prevFront = learnings.front_runners?.variant_family ?? null;
  const newFrontFam = pickFront(famRollup);
  learnings.front_runners = {
    ...(learnings.front_runners ?? {}),
    as_of: to,
    variant_family: newFrontFam ?? learnings.front_runners?.variant_family ?? null,
    platform: pickFront(platRollup) ?? learnings.front_runners?.platform ?? "tiktok",
    hashtag_set: pickFront(tagRollup) ?? learnings.front_runners?.hashtag_set ?? null,
    // best-performing time-of-day bucket (from posted_at) — the dashboard surfaces it.
    time_bucket: pickFront(timeRollup) ?? learnings.front_runners?.time_bucket ?? null,
    confidence: withMetrics.length >= minN ? "medium" : "low",
  };
  learnings.scoring_log = learnings.scoring_log ?? [];
  learnings.scoring_log.push({ date: to, from, to, pulled: flat.length, updated, n_with_metrics: withMetrics.length });
  if (learnings.scoring_log.length > 60) learnings.scoring_log = learnings.scoring_log.slice(-60);
  if (newFrontFam && newFrontFam !== prevFront) {
    learnings.decisions_log = learnings.decisions_log ?? [];
    learnings.decisions_log.push({
      date: to,
      decision: `Front-runner variant_family -> ${newFrontFam} (median eng_rate ${famRollup[newFrontFam].median_eng_rate}%, n=${famRollup[newFrontFam].n_with_metrics}).`,
      rationale: "Recomputed by the Hermes loop from matured Publer analytics.",
      status: "auto",
    });
  }
  learnings.updated_at = new Date().toISOString();
  writeJSONAtomic(CONFIG.LEARNINGS, learnings);

  const note = updated === 0 ? "no matured metrics yet (Publer ~24h lag) — rollups recomputed from existing" : "metrics refreshed";
  info("scoring done", { from, to, pulled: flat.length, updated, note });
  return { from, to, pulled: flat.length, updated, note };
}
