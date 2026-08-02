/**
 * leadPolicy.ts — WHICH QUESTION OPENS THE VIDEO, decided by what retains.
 *
 * THE ONE THING THAT MOVES VIEWS ON THIS ACCOUNT is the 3-second skip rate: across all
 * 114 published Instagram reels, median views run from 1,556 under 50% skip down to 141
 * above 80%, monotonic over eight buckets. Nothing else separated — not duration, not
 * hashtags, not caption (one identical caption line did 1,028 views on one post and 98
 * on another). So skip rate is the target, and the only question worth asking is what we
 * CONTROL that moves it.
 *
 * WHAT WE CONTROL. The format is pinned (dimensions.ts PINNED), so the one thing still
 * varying between videos is the questions — and question one is literally what occupies
 * the screen during the three seconds where ~70% of viewers leave.
 *
 * WHAT THE DATA SAID, measured over 44 matured Instagram posts we can attribute to their
 * opening question (2026-08-02):
 *
 *   opening prompt   n    median skip    what leads in this band
 *   <= 5 words      17           62.3    odd-one-out, figure analogy/series, number series
 *   6-9 words       13           72.5    verbal analogy, position, number puzzle
 *   >= 10 words     14           71.0    number analogy, sentence completion, word problem
 *
 * The short-vs-long contrast is +9.5 points of skip rate (95% CI [+2.4, +16.5],
 * permutation p = 0.0008) and it SURVIVES DROPPING ANY SINGLE QUESTION TYPE — the gap
 * ranges +7.5 to +15.1 across all twelve leave-one-type-out refits. It also survives the
 * calendar: skip rate improved over the campaign, so every characteristic that drifts
 * with the date looks like a lever, and the within-day rank test (each post ranked only
 * against posts published the SAME day) still gives rho = +0.37, p = 0.028.
 *
 * WHAT THE DATA DID NOT SAY, which matters just as much. The stated hypothesis was that
 * the TYPE of the opening question predicts skip rate. It does not, at any sample size we
 * have: the three types with n >= 7 (odd-one-out 66.4, verbal analogy 68.0, number
 * analogy 71.6) span 5.2 points with a permutation p of 0.06 on the run-attributed frame
 * and 0.90 on the full frame. The types that look dramatic — letter series 51.4, compare
 * 52.1, figure analogy 54.7 — are all n = 1. Reading a lever off those would be inventing
 * a signal from a handful of posts.
 *
 * The bank happens to make these two questions the SAME question: it uses one fixed
 * prompt per type ("WHICH ONE DOES NOT BELONG?" is always 5 words, "X IS TO Y AS A IS TO
 * ?" always 9, number analogy always 15). So prompt length is not an independent lever we
 * discovered on top of type — it is the ORDERING of the types, and the ordering is what
 * replicates while any individual type does not. Grouping by length is therefore the
 * honest way to use the evidence: it pools ~500 fresh bank questions per band instead of
 * betting the batch on one type's median.
 *
 * WHY THIS CANNOT COLLAPSE THE BANK. Weighting on length is not weighting on one type.
 * The short band alone holds 521 fresh questions across six types; a band's share is
 * capped at MAX_SHARE and floored at MIN_SHARE, and only the FIRST question of a video is
 * steered at all — the other two are still chosen by the existing type/tier spread. A
 * batch that is 55% short-opening still runs every type in the bank.
 *
 * This module is PURE (no I/O, no clock, no randomness beyond a seeded bootstrap), so the
 * evidence rule and the weighting can be tested exactly. leadPromotion.ts supplies the
 * evidence and writes the ledger.
 */

/** The three opening-plate reading-load bands. Ordered short -> long. */
export const LEAD_BANDS = ["short", "medium", "long"] as const;
export type LeadBand = (typeof LEAD_BANDS)[number];

/** Human labels for the dashboard and the ledger. */
export const BAND_LABEL: Record<LeadBand, string> = {
  short: "<=5 words",
  medium: "6-9 words",
  long: ">=10 words",
};

/**
 * Words in a question's on-screen prompt.
 *
 * The PROMPT only — deliberately not the options. Options were measured and are flat
 * (rho = -0.02, p = 0.91 against skip rate): what the viewer must parse in the first
 * moment to decide whether to stay is the question line, not the answer list.
 */
export function promptWords(prompt: unknown): number {
  return String(prompt ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Which band a prompt of `words` words falls in. */
export function bandOf(words: number): LeadBand {
  if (!Number.isFinite(words) || words <= 0) return "medium";
  if (words <= 5) return "short";
  if (words <= 9) return "medium";
  return "long";
}

// ── the evidence rule ────────────────────────────────────────────────────────

/**
 * MINIMUM MATURED POSTS before a band may move the mix at all.
 *
 * TWELVE, which is exactly one day's production (CONFIG.VIDEOS_PER_DAY). Two failure
 * modes bound this from either side and both are real here:
 *
 *   Too eager. Skip rate on this account has an interquartile range around 10 points, so
 *   below roughly ten posts the bootstrap interval on a band's median spans most of the
 *   distribution and the band's median is mostly telling you which posts it happened to
 *   get. The types that looked most dramatic in the raw cut were all n = 1.
 *
 *   Too strict. There are two weeks left. A band holding ~25% of twelve daily openings
 *   accumulates twelve matured posts in about four days, so twelve is reachable early
 *   enough to act on and be corrected. A threshold of thirty would mean the gate never
 *   fires before the campaign ends, which is the failure the previous promotion engine
 *   actually had — it never fired once.
 *
 * It is also the honest floor for the test below: a percentile bootstrap needs enough
 * samples that the interval can exclude anything at all.
 */
export const MIN_POSTS_PER_BAND = 12;

/** Bootstrap resamples for the band-median interval. Fixed, with a fixed seed. */
export const BOOTSTRAP_N = 4000;

/** Interval width. 90% (5th-95th percentile) two-sided. */
export const CI_ALPHA = 0.05;

/**
 * A skip-rate advantage of this many points earns the maximum shift. The measured
 * short-vs-long gap is ~9.5 points, so the strongest signal in the data buys roughly a
 * full-strength move and nothing buys more.
 */
export const ADVANTAGE_SCALE = 10;

/** Floor and cap on any single band's share of the day's opening slots. */
export const MIN_SHARE = 0.15;
export const MAX_SHARE = 0.55;

export interface LeadEvidenceRow {
  band: LeadBand;
  /** 3-second skip rate, percent. LOWER IS BETTER. */
  skip: number;
}

export interface BandVerdict {
  band: LeadBand;
  label: string;
  n: number;
  median: number | null;
  /** median skip rate of every OTHER band pooled — what this band is judged against. */
  others_median: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  /** others_median - median. POSITIVE means this band retains BETTER than the rest. */
  advantage: number | null;
  /** did it clear both the sample-size floor and the interval test? */
  passes: boolean;
  reason: string;
  weight: number;
  share: number;
}

export interface LeadPolicy {
  /** false when the switch is off or no band has cleared the bar — shares are uniform. */
  applied: boolean;
  bands: BandVerdict[];
  shares: Record<LeadBand, number>;
  n_posts: number;
  min_posts: number;
  note: string;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Deterministic LCG — the same generator questions.ts uses for its seeded shuffle. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/**
 * Percentile bootstrap interval for a MEDIAN.
 *
 * A median rather than a mean because every rollup in this codebase already judges on
 * medians (rollup.ts groupMedian) and reach on this account is bimodal — a single 1,825
 * view outlier would drag a mean and say nothing about the typical post. Seeded, so the
 * same evidence always produces the same verdict and a ledger entry can be reproduced.
 */
export function bootstrapMedianCI(xs: number[], seed = 1234, iters = BOOTSTRAP_N): [number, number] | null {
  if (xs.length < 3) return null;
  const rand = lcg(seed);
  const meds: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: number[] = [];
    for (let j = 0; j < xs.length; j++) sample.push(xs[Math.floor(rand() * xs.length)]);
    meds.push(median(sample) as number);
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(CI_ALPHA * meds.length)], meds[Math.floor((1 - CI_ALPHA) * meds.length)]];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Normalise raw weights into shares that sum to 1 AND sit inside [MIN_SHARE, MAX_SHARE].
 *
 * Done by clamp-and-redistribute, iterated: clamp everything to the bounds, then hand the
 * leftover (or shortfall) only to the bands that still have room to take it. The obvious
 * implementation — clamp once, then renormalise so the shares sum to 1 — does NOT work,
 * because the renormalisation scales the clamped values straight back out of bounds. That
 * is not a rounding detail: it is exactly how an "exploration floor" quietly stops being
 * one, and it is what the floor tests pin down.
 *
 * A solution always exists here because 3*MIN_SHARE <= 1 <= 3*MAX_SHARE.
 */
export function clampShares(weights: Record<LeadBand, number>): Record<LeadBand, number> {
  const keys = [...LEAD_BANDS];
  const total = keys.reduce((s, k) => s + Math.max(0, weights[k]), 0);
  const share: Record<string, number> = {};
  for (const k of keys) share[k] = total > 0 ? Math.max(0, weights[k]) / total : 1 / keys.length;

  for (let iter = 0; iter < 64; iter++) {
    for (const k of keys) share[k] = clamp(share[k], MIN_SHARE, MAX_SHARE);
    const diff = 1 - keys.reduce((s, k) => s + share[k], 0);
    if (Math.abs(diff) < 1e-12) break;
    // only bands with headroom in the needed direction can absorb the difference
    const room = keys.filter((k) => (diff > 0 ? share[k] < MAX_SHARE - 1e-12 : share[k] > MIN_SHARE + 1e-12));
    if (!room.length) break;
    for (const k of room) share[k] += diff / room.length;
  }
  return { short: share.short, medium: share.medium, long: share.long };
}

/**
 * The whole decision: evidence in, per-band shares of the day's OPENING slots out.
 *
 * A band moves the mix only if it clears BOTH gates — at least MIN_POSTS_PER_BAND matured
 * Instagram posts, and a bootstrap interval on its median that EXCLUDES the pooled median
 * of the other bands. Everything that fails either gate keeps weight 1, so the default
 * behaviour of this function on thin evidence is the uniform mix the loop already had.
 */
export function computeLeadPolicy(
  evidence: LeadEvidenceRow[],
  opts: { enabled?: boolean; minPosts?: number; seed?: number } = {},
): LeadPolicy {
  const enabled = opts.enabled !== false;
  const minPosts = opts.minPosts ?? MIN_POSTS_PER_BAND;
  const seed = opts.seed ?? 1234;

  const byBand: Record<string, number[]> = { short: [], medium: [], long: [] };
  for (const r of evidence) {
    if (byBand[r.band] && Number.isFinite(r.skip)) byBand[r.band].push(r.skip);
  }

  const weights: Record<LeadBand, number> = { short: 1, medium: 1, long: 1 };
  const bands: BandVerdict[] = [];

  for (const b of LEAD_BANDS) {
    const xs = byBand[b];
    const others = LEAD_BANDS.filter((o) => o !== b).flatMap((o) => byBand[o]);
    const med = median(xs);
    const omed = median(others);
    const ci = bootstrapMedianCI(xs, seed);
    const advantage = med !== null && omed !== null ? omed - med : null;

    let passes = false;
    let reason: string;
    if (!enabled) {
      reason = "weighting switched off";
    } else if (xs.length < minPosts) {
      reason = `only ${xs.length} matured post(s); needs ${minPosts}`;
    } else if (!ci || omed === null) {
      reason = "not enough data for an interval";
    } else if (ci[1] < omed) {
      passes = true;
      reason = `retains better: 90% CI [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}] is entirely below the ${omed.toFixed(1)} median of the other bands`;
    } else if (ci[0] > omed) {
      passes = true;
      reason = `retains worse: 90% CI [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}] is entirely above the ${omed.toFixed(1)} median of the other bands`;
    } else {
      reason = `indistinguishable: 90% CI [${ci[0].toFixed(1)}, ${ci[1].toFixed(1)}] straddles the ${omed.toFixed(1)} median of the other bands`;
    }

    if (passes && advantage !== null) {
      weights[b] = 1 + clamp(advantage / ADVANTAGE_SCALE, -1, 1);
    }

    bands.push({
      band: b,
      label: BAND_LABEL[b],
      n: xs.length,
      median: med,
      others_median: omed,
      ci_lo: ci ? ci[0] : null,
      ci_hi: ci ? ci[1] : null,
      advantage,
      passes,
      reason,
      weight: weights[b],
      share: 0,
    });
  }

  const shares = clampShares(weights);
  for (const v of bands) v.share = shares[v.band];

  const movers = bands.filter((b) => b.passes);
  const applied = enabled && movers.length > 0;
  const note = !enabled
    ? "OFF (HERMES_LEAD_WEIGHTING=off) — openings are drawn evenly across the three bands."
    : movers.length === 0
      ? `No band has cleared the bar yet (needs ${minPosts} matured Instagram posts and an interval that excludes the rest). Openings are drawn evenly.`
      : movers.map((m) => `${m.label} ${(m.advantage as number) > 0 ? "retains better" : "retains worse"} by ${Math.abs(m.advantage as number).toFixed(1)} pts of skip rate on n=${m.n}`).join("; ");

  return { applied, bands, shares, n_posts: evidence.length, min_posts: minPosts, note };
}

/**
 * Turn shares into an actual list of `target` opening bands, one per video.
 *
 * Largest-remainder allocation, then the EXPLORATION FLOOR: while the batch is big enough
 * to hold one of each, every band gets at least one opening even if rounding wiped it
 * out. Losing the bank's variety is not a rounding error we are willing to accept —
 * near-duplicate content is what got TikTok flagged.
 *
 * The returned order INTERLEAVES the bands rather than blocking them, so a run that is
 * cut short (gates, render failures, the daily ceiling) still ships a mix rather than six
 * short openings and nothing else.
 */
export function allocateLeadBands(target: number, shares: Record<LeadBand, number>): LeadBand[] {
  if (target <= 0) return [];
  const raw = LEAD_BANDS.map((b) => ({ band: b, exact: shares[b] * target }));
  const counts: Record<string, number> = {};
  let used = 0;
  for (const r of raw) {
    counts[r.band] = Math.floor(r.exact);
    used += counts[r.band];
  }
  const remainders = raw
    .map((r) => ({ band: r.band, rem: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.rem - a.rem || LEAD_BANDS.indexOf(a.band) - LEAD_BANDS.indexOf(b.band));
  let i = 0;
  while (used < target) {
    counts[remainders[i % remainders.length].band]++;
    used++;
    i++;
  }
  // exploration floor: nobody is allowed to reach zero while there is room for everyone
  if (target >= LEAD_BANDS.length) {
    for (const b of LEAD_BANDS) {
      if (counts[b] > 0) continue;
      const donor = [...LEAD_BANDS].sort((x, y) => counts[y] - counts[x])[0];
      if (counts[donor] > 1) {
        counts[donor]--;
        counts[b]++;
      }
    }
  }
  // interleave: round-robin over the bands, biggest allocation first
  const order = [...LEAD_BANDS].sort((a, b) => counts[b] - counts[a] || LEAD_BANDS.indexOf(a) - LEAD_BANDS.indexOf(b));
  const out: LeadBand[] = [];
  const left = { ...counts };
  while (out.length < target) {
    let placed = false;
    for (const b of order) {
      if (left[b] > 0) {
        out.push(b);
        left[b]--;
        placed = true;
        if (out.length === target) break;
      }
    }
    if (!placed) break;
  }
  return out;
}
