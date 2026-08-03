/**
 * goal.ts — HERMES'S MANDATE, encoded as the loop's optimization target.
 *
 *   GOAL: 500,000 views in 14 DAYS, and 500 followers on EACH of Instagram and
 *   TikTok. (Likes were dropped from the mandate — views + per-platform
 *   followers only; no like/engagement target anywhere in the goal.)
 *
 * This module is the single source of truth for that target + an HONEST live
 * trajectory computed from REAL metrics (ab-database.json, back-filled each cycle
 * by reconcile.ts) — no vanity numbers. The clock only counts down once a human
 * has armed KICKOFF; before that the panel reads "not started (kickoff pending)".
 *
 * TWO INSTANTS, NOT ONE (2026-08-03). Until today the goal window and the kickoff
 * switch shared a single t0 — the arming file's mtime — which meant the only way to
 * re-anchor the mandate's clock was to touch a human-only autonomy switch. Those are
 * different facts and they now have different homes: kickoff.ts still owns "when did
 * a human arm autonomy", and WINDOW_START below owns "when does the mandate's clock
 * start". Arming semantics are untouched; an un-armed box still has no window at all.
 *
 * The pure `computeGoalProgress(...)` takes plain data so both the loop and the
 * read-only dashboard can render the SAME trajectory without shared I/O.
 */
import { readFileSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { kickoffStatus } from "./kickoff.ts";

// ── THE MANDATE — SINGLE SOURCE OF TRUTH (edit these to change the target) ─────
export const GOAL = Object.freeze({
  /** combined view target over the window, across every publishing network. */
  views: 500_000,
  /**
   * follower target on EACH platform (IG and TikTok independently), i.e. 500 IG
   * AND 500 TikTok. This is "per platform", NOT a combined total — flip this one
   * constant (and drop the *2 in the combined display) if you ever want a single
   * combined-followers target instead. YouTube has no follower target.
   */
  followers_each: 500,
  /**
   * WINDOW LENGTH IN DAYS. 7 -> 14 on 2026-08-03, by owner decision after the first
   * window closed at 44,204 of 500,000 views: "keep going, extend the goal to 2 weeks".
   */
  days: 14,
  /**
   * YOUTUBE IS IN THE ROLLUP (2026-08-02). It was omitted here while it was half of
   * everything the loop published, so its posts contributed nothing to the totals —
   * not zero, absent. The followers target stays IG + TikTok only; this list is the
   * VIEWS universe.
   */
  platforms: ["instagram", "tiktok", "youtube"] as const,
  /** The platforms the 500-followers-each target applies to. */
  follower_platforms: ["instagram", "tiktok"] as const,
  // NOTE: likes are deliberately NOT part of the goal (no like target / trajectory).
});

/**
 * WHEN THE MANDATE'S CLOCK STARTS — null means "the kickoff instant", which is the
 * behaviour every window before this one had.
 *
 * Set to an explicit instant on 2026-08-03 when the target was extended to 14 days.
 * Leaving it null would have anchored the new window on the original kickoff
 * (2026-07-23T17:12:15Z), which is 11.2 days spent: a "14-day" window that expires in
 * 2.8 days and demands ~163,000 views/day. That is not the extension the owner asked
 * for, and it is not a target anyone can act on.
 *
 * Re-anchoring here rather than by touching KICKOFF_ARMED is deliberate. The arming
 * file is a human-only autonomy switch and its mtime is the audit record of when a
 * person armed the loop; rewriting it to move a reporting clock would destroy that
 * record and silently re-arm-stamp the box. So kickoff keeps its instant, the window
 * gets its own, and the dashboard shows both.
 *
 * COST, STATED PLAINLY: only posts published at/after this instant count toward the
 * 500,000. The 44,204 views earned in the first window are NOT carried forward — they
 * belong to a window that closed. The panel labels the prior tally rather than hiding it.
 */
export const WINDOW_START: string | null = "2026-08-03T22:00:00.000Z";

/**
 * t0 for the goal window: the explicit anchor when one is set, else the kickoff instant.
 * Null until a human arms kickoff — an un-armed box has no window, exactly as before.
 */
export function goalWindowStart(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = kickoffStatus(env);
  if (!k.armed) return null;
  return WINDOW_START ?? k.since;
}

const DAY_MS = 86_400_000;

export interface PlatformProgress {
  platform: string;
  views: number;
  followers: number | null; // null = not yet measured (honest "pending")
  posts: number;
}

export interface GoalProgress {
  started: boolean; // false until kickoff is armed
  since: string | null; // t0 (kickoff instant)
  now: string;
  window_days: number;
  elapsed_days: number;
  days_left: number;
  hours_left: number;
  target: { views: number; followers_each: number };
  totals: { views: number };
  per_platform: PlatformProgress[];
  pct: { views: number }; // 0..1 of target
  pace: {
    views_per_day: number; // observed
    views_needed_per_day: number; // to still hit target in the time left
    on_track_views: boolean;
  };
  note: string;
}

interface AbPost {
  platform?: string;
  posted_at?: string | null;
  post_state?: string;
  metrics?: { video_views?: number | null; reactions?: number | null } | null;
}

/**
 * A row of the LIVE analytics snapshot (score.ts writes it, CONFIG.ANALYTICS_SNAPSHOT).
 * When one is supplied it REPLACES the ab-database sum as the source of the totals.
 */
export interface LiveAnalyticsRow {
  network: string;
  published_at?: string | null;
  views?: number | null;
}

/**
 * Pure trajectory math. `sinceISO` = kickoff instant (null => not started);
 * `followers` = latest per-platform follower counts (or {} when unmeasured).
 *
 * VIEWS COME FROM `live` WHEN IT IS SUPPLIED, and from the ab-database join only as a
 * fallback. That ordering is the fix for the dashboard reporting 9,500 views over 28
 * Instagram posts on a day the analytics API said 39,382 over 101 with YouTube missing
 * entirely. The join answers "which FORMAT earned this view", which is a harder
 * question and is allowed to be incomplete; the TOTAL is not, and the API states it
 * directly. No I/O here; fully unit-testable.
 */
export function computeGoalProgress(
  posts: AbPost[],
  sinceISO: string | null,
  followers: Record<string, number> = {},
  now: Date = new Date(),
  live?: LiveAnalyticsRow[] | null,
): GoalProgress {
  const nowISO = now.toISOString();
  const base = {
    now: nowISO,
    window_days: GOAL.days,
    target: { views: GOAL.views, followers_each: GOAL.followers_each },
  };
  const sinceMs = sinceISO ? Date.parse(sinceISO) : Number.NaN;
  const useLive = Array.isArray(live) && live.length > 0;
  const perPlatform: PlatformProgress[] = GOAL.platforms.map((platform) => {
    let views: number;
    let count: number;
    if (useLive) {
      const mine = live!.filter((r) => String(r.network ?? "").toLowerCase() === platform);
      const inWindow = Number.isFinite(sinceMs)
        ? mine.filter((r) => r.published_at && Date.parse(r.published_at) >= sinceMs)
        : mine;
      views = inWindow.reduce((s, r) => s + (Number(r.views) || 0), 0);
      count = inWindow.length;
    } else {
      const mine = posts.filter((p) => (p.platform || "").toLowerCase() === platform);
      const inWindow = Number.isFinite(sinceMs)
        ? mine.filter((p) => p.posted_at && Date.parse(p.posted_at) >= sinceMs)
        : mine;
      views = inWindow.reduce((s, p) => s + (Number(p.metrics?.video_views) || 0), 0);
      count = inWindow.length;
    }
    const f = followers[platform];
    return { platform, views, followers: Number.isFinite(f) ? f : null, posts: count };
  });
  const totals = {
    views: perPlatform.reduce((s, p) => s + p.views, 0),
  };

  if (!sinceISO) {
    return {
      ...base,
      started: false,
      since: null,
      elapsed_days: 0,
      days_left: GOAL.days,
      hours_left: GOAL.days * 24,
      totals,
      per_platform: perPlatform,
      pct: { views: totals.views / GOAL.views },
      pace: {
        views_per_day: 0,
        views_needed_per_day: GOAL.views / GOAL.days,
        on_track_views: false,
      },
      note: `not started — kickoff pending. Flip the KICKOFF switch to start the ${GOAL.days}-day clock.`,
    };
  }

  const t0 = Date.parse(sinceISO);
  const elapsedMs = Math.max(0, now.getTime() - t0);
  const elapsedDays = elapsedMs / DAY_MS;
  const leftMs = Math.max(0, t0 + GOAL.days * DAY_MS - now.getTime());
  const daysLeft = leftMs / DAY_MS;
  const safeElapsed = Math.max(elapsedDays, 1 / 24); // avoid /0 in the first hour
  const safeLeft = Math.max(daysLeft, 1 / 24);
  const viewsPerDay = totals.views / safeElapsed;
  const viewsNeededPerDay = Math.max(0, GOAL.views - totals.views) / safeLeft;
  const expectedFrac = Math.min(1, elapsedDays / GOAL.days);
  return {
    ...base,
    started: true,
    since: sinceISO,
    elapsed_days: round2(elapsedDays),
    days_left: round2(daysLeft),
    hours_left: Math.round(leftMs / 3_600_000),
    totals,
    per_platform: perPlatform,
    pct: { views: totals.views / GOAL.views },
    pace: {
      views_per_day: Math.round(viewsPerDay),
      views_needed_per_day: Math.round(viewsNeededPerDay),
      on_track_views: totals.views >= GOAL.views * expectedFrac,
    },
    note:
      daysLeft <= 0
        ? `${GOAL.days}-day window CLOSED — final tally above.`
        : `pace vs target: need ~${Math.round(viewsNeededPerDay).toLocaleString()} views/day for the remaining ${round2(daysLeft)} days.`,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read the optional per-platform follower snapshot (honest "pending" when absent). */
export function readFollowers(env: NodeJS.ProcessEnv = process.env): Record<string, number> {
  const dir = (env.HERMES_DATA_DIR || "").trim() || "/home/ec2-user/hermes-data";
  try {
    const j = JSON.parse(readFileSync(`${dir}/account-metrics.json`, "utf8"));
    const out: Record<string, number> = {};
    for (const p of GOAL.platforms) {
      const v = j?.[p]?.followers ?? j?.[p]?.follower_count ?? j?.followers?.[p];
      if (Number.isFinite(Number(v))) out[p] = Number(v);
    }
    return out;
  } catch {
    return {}; // absent -> pending
  }
}

/**
 * The LIVE analytics snapshot score.ts writes each cycle, or null when it is absent
 * (a box that has not scored yet), in which case the caller falls back to the join.
 */
export function readLiveAnalytics(path: string = CONFIG.ANALYTICS_SNAPSHOT): LiveAnalyticsRow[] | null {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(j?.rows) && j.rows.length ? (j.rows as LiveAnalyticsRow[]) : null;
  } catch {
    return null;
  }
}

/** Loop-side convenience: live analytics (+ ab-database fallback) -> progress. */
export function goalProgress(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): GoalProgress {
  let posts: AbPost[] = [];
  try {
    const db = JSON.parse(readFileSync(CONFIG.AB_DB, "utf8"));
    posts = Array.isArray(db?.posts) ? db.posts : [];
  } catch {
    posts = [];
  }
  return computeGoalProgress(posts, goalWindowStart(env), readFollowers(env), now, readLiveAnalytics());
}
