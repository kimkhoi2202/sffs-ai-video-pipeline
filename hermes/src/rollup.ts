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
  n_with_metrics: number;
  median_eng_rate: number | null;
  avg_reach: number | null;
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

/** A post counts toward metrics once it has a non-pending, non-null eng_rate. */
export function hasMatureMetrics(p: any): boolean {
  return !!p && p.metrics && p.metrics.source !== "pending" && p.metrics.eng_rate != null;
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
  const map: Record<string, { eng: number[]; reach: number[]; n: number }> = {};
  for (const p of posts) {
    const k = key(p);
    if (!k) continue;
    map[k] = map[k] ?? { eng: [], reach: [], n: 0 };
    map[k].n++;
    if (hasMatureMetrics(p)) {
      map[k].eng.push(Number(p.metrics.eng_rate));
      if (p.metrics.reach != null) map[k].reach.push(Number(p.metrics.reach));
    }
  }
  const out: Record<string, RollupCell> = {};
  for (const [k, v] of Object.entries(map)) {
    out[k] = {
      n_posts: v.n,
      n_with_metrics: v.eng.length,
      median_eng_rate: round2(median(v.eng)),
      avg_reach: round2(median(v.reach)),
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
