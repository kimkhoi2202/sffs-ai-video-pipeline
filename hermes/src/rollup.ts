/**
 * rollup.ts — the pure A/B rollup math, split out of score.ts so it is
 * DEPENDENCY-FREE (no Publer/openai) and can be unit-introspected offline.
 *
 * A "cell" is the per-group summary the loop decides on: how many posts, how many
 * have matured metrics, the MEDIAN engagement rate (percent), and the average
 * reach. Median (not mean) is used deliberately — small samples with reach<10
 * noise posts (see learnings.json conventions).
 *
 * NEW: `by_variant_arm` groups by the canonical arm LABEL (variant.label, falling
 * back to variant.arm) — the granularity the default-promotion engine needs to ask
 * "did a test ARM beat the control?". The pre-existing `by_variant_family` (grouped
 * by the coarser variant.family / dimension) is kept unchanged.
 */

export interface RollupCell {
  n_posts: number;
  /** posts with ANY matured metric. NOT a per-metric count — see n_by_metric. */
  n_with_metrics: number;
  median_eng_rate: number | null;
  avg_reach: number | null;
  /** median VIEWS (video_views). */
  median_views: number | null;
  /** median REACH — the secondary views/reach hypothesis metric. */
  median_reach: number | null;
  /**
   * Median 3-SECOND SKIP RATE, percent. LOWER IS BETTER, and it is the metric the
   * promotion gate judges on (ab-testing/content-defaults.json promotion.metric).
   * INSTAGRAM ONLY: Metricool returns null watch-time on every TikTok row, so a
   * TikTok-only cell has a null here rather than a fabricated zero.
   */
  median_skip_rate: number | null;
  /**
   * How many posts backed EACH median. The promotion engine's min-sample gate must
   * count the posts that carry THE METRIC BEING JUDGED — a cell with 12 matured posts
   * but 3 skip rates must not be allowed to promote on 3 samples, which is exactly
   * what a single shared n_with_metrics would have permitted.
   */
  n_by_metric: Record<string, number>;
}

export function median(nums: number[]): number | null {
  const a = nums.filter((n) => typeof n === "number" && !Number.isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function round2(n: number | null): number | null {
  return n == null ? null : Math.round(n * 100) / 100;
}

/**
 * A post counts as MATURED once its metrics are non-pending and it carries at least
 * one real number.
 *
 * This used to require a non-null `eng_rate`, which quietly defined maturity against
 * the one metric the promotion policy has since abandoned: a post with a real skip
 * rate but no engagement rate was treated as having no data at all, so it could never
 * reach the gate. Each median below filters independently, so widening this does not
 * let a null into any average.
 */
export function hasMatureMetrics(p: any): boolean {
  if (!p || !p.metrics || p.metrics.source === "pending") return false;
  const m = p.metrics;
  return m.eng_rate != null || m.skip_rate != null || m.video_views != null || m.reach != null;
}

/**
 * Time-of-day bucket for a post's `posted_at` (back-filled by reconcile.ts). Uses
 * the hour AS WRITTEN in the timestamp (respecting its own tz offset), so it
 * reflects the account's local posting time — the signal for "best time to post".
 * Returns undefined for missing/unparseable timestamps (excluded from the rollup).
 */
export function timeBucket(postedAt: unknown): string | undefined {
  if (postedAt == null || postedAt === "") return undefined;
  const s = String(postedAt);
  let hour: number;
  const m = s.match(/T(\d{2}):/); // ISO time portion — local hour as written
  if (m) {
    hour = Number(m[1]);
  } else {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return undefined;
    hour = d.getUTCHours();
  }
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return undefined;
  if (hour < 6) return "night (0-6)";
  if (hour < 12) return "morning (6-12)";
  if (hour < 18) return "afternoon (12-18)";
  return "evening (18-24)";
}

/** Group posts by a key function and summarize each group into a RollupCell. */
export function groupMedian(posts: any[], key: (p: any) => string | undefined): Record<string, RollupCell> {
  const map: Record<string, { eng: number[]; reach: number[]; views: number[]; skip: number[]; n: number; mature: number }> = {};
  for (const p of posts) {
    const k = key(p);
    if (!k) continue;
    map[k] = map[k] ?? { eng: [], reach: [], views: [], skip: [], n: 0, mature: 0 };
    map[k].n++;
    if (hasMatureMetrics(p)) {
      map[k].mature++;
      // Each metric is collected independently: a post contributes to the medians it
      // actually has data for, and to no others.
      if (p.metrics.eng_rate != null) map[k].eng.push(Number(p.metrics.eng_rate));
      if (p.metrics.reach != null) map[k].reach.push(Number(p.metrics.reach));
      if (p.metrics.video_views != null) map[k].views.push(Number(p.metrics.video_views));
      if (p.metrics.skip_rate != null) map[k].skip.push(Number(p.metrics.skip_rate));
    }
  }
  const out: Record<string, RollupCell> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = {
      n_posts: v.n,
      n_with_metrics: v.mature,
      median_eng_rate: round2(median(v.eng)),
      avg_reach: round2(median(v.reach)),
      median_views: round2(median(v.views)),
      median_reach: round2(median(v.reach)),
      median_skip_rate: round2(median(v.skip)),
      n_by_metric: {
        median_eng_rate: v.eng.length,
        median_skip_rate: v.skip.length,
        median_views: v.views.length,
        median_reach: v.reach.length,
      },
    };
  }
  return out;
}

export interface Rollups {
  by_variant_family: Record<string, RollupCell>;
  by_variant_arm: Record<string, RollupCell>;
  by_platform: Record<string, RollupCell>;
  by_hashtag_set: Record<string, RollupCell>;
  by_time_bucket: Record<string, RollupCell>;
}

/** Compute all decision rollups from ab-database posts[]. Pure. */
export function computeRollups(posts: any[]): Rollups {
  const arr = Array.isArray(posts) ? posts : [];
  return {
    by_variant_family: groupMedian(arr, (p) => p.variant?.family),
    by_variant_arm: groupMedian(arr, (p) => p.variant?.label ?? p.variant?.arm),
    by_platform: groupMedian(arr, (p) => p.platform),
    by_hashtag_set: groupMedian(arr, (p) => p.hashtag_set),
    // by time-of-day the post went live (from posted_at, back-filled by reconcile).
    by_time_bucket: groupMedian(arr, (p) => timeBucket(p.posted_at)),
  };
}
