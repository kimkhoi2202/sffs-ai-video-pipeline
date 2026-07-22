/**
 * goal.ts — HERMES'S MANDATE, encoded as the loop's optimization target.
 *
 *   GOAL: 1,000,000 views + 200,000 likes in 7 DAYS, and 1,000 followers on EACH
 *   of Instagram and TikTok.
 *
 * This module is the single source of truth for that target + an HONEST live
 * trajectory computed from REAL metrics (ab-database.json, back-filled each cycle
 * by reconcile.ts) — no vanity numbers. The 7-day clock starts at KICKOFF (t0 =
 * the kickoff arming instant), so "days left" only counts down once a human flips
 * the switch; before kickoff the panel reads "not started (kickoff pending)".
 *
 * The pure `computeGoalProgress(...)` takes plain data so both the loop and the
 * read-only dashboard can render the SAME trajectory without shared I/O.
 */
import { readFileSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { kickoffStatus } from "./kickoff.ts";

export const GOAL = Object.freeze({
  views: 1_000_000,
  likes: 200_000,
  followers_each: 1_000,
  days: 7,
  platforms: ["instagram", "tiktok"] as const,
});

const DAY_MS = 86_400_000;

export interface PlatformProgress {
  platform: string;
  views: number;
  likes: number;
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
  target: { views: number; likes: number; followers_each: number };
  totals: { views: number; likes: number };
  per_platform: PlatformProgress[];
  pct: { views: number; likes: number }; // 0..1 of target
  pace: {
    views_per_day: number; // observed
    likes_per_day: number;
    views_needed_per_day: number; // to still hit target in the time left
    likes_needed_per_day: number;
    on_track_views: boolean;
    on_track_likes: boolean;
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
 * Pure trajectory math. `posts` = ab-database.json posts (with per-platform metrics);
 * `sinceISO` = kickoff instant (null => not started); `followers` = latest per-
 * platform follower counts (or {} when unmeasured). No I/O; fully unit-testable.
 */
export function computeGoalProgress(
  posts: AbPost[],
  sinceISO: string | null,
  followers: Record<string, number> = {},
  now: Date = new Date(),
): GoalProgress {
  const nowISO = now.toISOString();
  const base = {
    now: nowISO,
    window_days: GOAL.days,
    target: { views: GOAL.views, likes: GOAL.likes, followers_each: GOAL.followers_each },
  };
  const perPlatform: PlatformProgress[] = GOAL.platforms.map((platform) => {
    const mine = posts.filter((p) => (p.platform || "").toLowerCase() === platform);
    const inWindow = sinceISO
      ? mine.filter((p) => p.posted_at && Date.parse(p.posted_at) >= Date.parse(sinceISO))
      : mine;
    const views = inWindow.reduce((s, p) => s + (Number(p.metrics?.video_views) || 0), 0);
    const likes = inWindow.reduce((s, p) => s + (Number(p.metrics?.reactions) || 0), 0);
    const f = followers[platform];
    return { platform, views, likes, followers: Number.isFinite(f) ? f : null, posts: inWindow.length };
  });
  const totals = {
    views: perPlatform.reduce((s, p) => s + p.views, 0),
    likes: perPlatform.reduce((s, p) => s + p.likes, 0),
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
      pct: { views: totals.views / GOAL.views, likes: totals.likes / GOAL.likes },
      pace: {
        views_per_day: 0,
        likes_per_day: 0,
        views_needed_per_day: GOAL.views / GOAL.days,
        likes_needed_per_day: GOAL.likes / GOAL.days,
        on_track_views: false,
        on_track_likes: false,
      },
      note: "not started — kickoff pending. Flip the KICKOFF switch to start the 7-day clock.",
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
  const likesPerDay = totals.likes / safeElapsed;
  const viewsNeededPerDay = Math.max(0, GOAL.views - totals.views) / safeLeft;
  const likesNeededPerDay = Math.max(0, GOAL.likes - totals.likes) / safeLeft;
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
    pct: { views: totals.views / GOAL.views, likes: totals.likes / GOAL.likes },
    pace: {
      views_per_day: Math.round(viewsPerDay),
      likes_per_day: Math.round(likesPerDay),
      views_needed_per_day: Math.round(viewsNeededPerDay),
      likes_needed_per_day: Math.round(likesNeededPerDay),
      on_track_views: totals.views >= GOAL.views * expectedFrac,
      on_track_likes: totals.likes >= GOAL.likes * expectedFrac,
    },
    note:
      daysLeft <= 0
        ? "7-day window CLOSED — final tally above."
        : `pace vs target: need ~${Math.round(viewsNeededPerDay).toLocaleString()} views/day and ~${Math.round(
            likesNeededPerDay,
          ).toLocaleString()} likes/day for the remaining ${round2(daysLeft)} days.`,
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

/** Loop-side convenience: read ab-database.json + kickoff + followers -> progress. */
export function goalProgress(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): GoalProgress {
  let posts: AbPost[] = [];
  try {
    const db = JSON.parse(readFileSync(CONFIG.AB_DB, "utf8"));
    posts = Array.isArray(db?.posts) ? db.posts : [];
  } catch {
    posts = [];
  }
  return computeGoalProgress(posts, kickoffStatus(env).since, readFollowers(env), now);
}
