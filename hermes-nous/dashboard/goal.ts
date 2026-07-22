/**
 * goal.ts — pure GOAL-PROGRESS math for the READ-ONLY dashboard.
 *
 * Encodes Hermes's mandate and turns ab-database posts (+ an optional follower
 * snapshot) into the honest live trajectory toward it. NO HTML, NO disk, NO
 * network, NO secrets — just data in → numbers out, so it is trivially unit-
 * testable (see test/dashboard.test.ts) and can never leak anything.
 *
 * THE MANDATE (fixed constants below):
 *   1,000,000 views + 200,000 likes in 7 DAYS (combined across IG + TikTok),
 *   and 1,000 followers on EACH of Instagram and TikTok.
 *
 * The 7-day clock starts at KICKOFF (t0 = mtime of the armed KICKOFF file). Until
 * armed, `sinceISO` is null: the window is "not started", the clock reads the full
 * 7 days, and the running totals are computed over ALL posts (informational). Once
 * armed, only posts with posted_at >= t0 count toward the window. Per platform:
 *   views = Σ metrics.video_views · likes = Σ metrics.reactions.
 * Followers come ONLY from the snapshot; when it is absent they are `null`
 * ("pending"), never 0/fake.
 */

/** Hermes's mandate, as fixed targets. Combined = IG + TikTok. */
export const GOAL = Object.freeze({
  /** combined (IG + TikTok) 7-day view target. */
  views: 1_000_000,
  /** combined (IG + TikTok) 7-day like (reactions) target. */
  likes: 200_000,
  /** follower target on EACH platform (IG and TikTok independently). */
  followersPerPlatform: 1_000,
  /** the mandate's window length, in days. */
  windowDays: 7,
});

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type PlatformKey = "instagram" | "tiktok";
export type Scope = PlatformKey | "combined";

/** value-vs-target with the raw percentage (may exceed 100). */
export interface GoalMetric {
  value: number;
  target: number;
  pct: number;
}
/** followers can be `null` (snapshot absent ⇒ "pending", NOT 0/fake). */
export interface FollowerMetric {
  value: number | null;
  target: number;
  pct: number | null;
}
export interface ScopeProgress {
  scope: Scope;
  views: GoalMetric;
  likes: GoalMetric;
  followers: FollowerMetric;
  /** posts counted in this scope within the window (or all, pre-kickoff). */
  posts: number;
  /** observed rate within the window; null before kickoff (clock not started) or with no elapsed time. */
  paceViewsPerDay: number | null;
  paceLikesPerDay: number | null;
  /** rate still required to hit target in the time left; 0 if already met; null once the window has closed unmet (impossible). */
  neededViewsPerDay: number | null;
  neededLikesPerDay: number | null;
}
export interface ArmAgg {
  arm: string;
  family: string;
  views: number;
  likes: number;
  posts: number;
}
export interface FollowerSnapshot {
  instagram?: { followers?: number };
  tiktok?: { followers?: number };
}
export interface GoalProgress {
  /** true once the KICKOFF file is armed (7-day clock running). */
  armed: boolean;
  /** t0 (ISO) — kickoff mtime — or null when pending. */
  since: string | null;
  now: string;
  windowDays: number;
  elapsedMs: number;
  remainingMs: number;
  daysLeft: number;
  hoursLeft: number;
  /** armed AND the 7-day window has elapsed. */
  windowClosed: boolean;
  instagram: ScopeProgress;
  tiktok: ScopeProgress;
  combined: ScopeProgress;
  /** "what's moving the needle": top 3 arms by views / by likes within the window. */
  topArmsByViews: ArmAgg[];
  topArmsByLikes: ArmAgg[];
  /** true when no follower snapshot was supplied (followers render as "pending"). */
  followersPending: boolean;
}

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

function platformOf(p: any): string {
  const s = String(p?.platform || "").toLowerCase();
  if (s === "instagram" || s === "ig" || s === "ig_business") return "instagram";
  if (s === "tiktok" || s === "tt") return "tiktok";
  return s || "other";
}
function armOf(p: any): string {
  const v = p?.variant || {};
  return String(v.arm || v.label || v.family || "—");
}
function familyOf(p: any): string {
  const v = p?.variant || {};
  return String(v.family || "—");
}

/**
 * Pure projection of the mandate over a post list. `sinceISO` = t0 (armed) or
 * null (pending); `followers` = the optional snapshot (or null ⇒ pending);
 * `now` anchors the clock (injected so tests are deterministic).
 */
export function computeGoalProgress(
  posts: any[],
  sinceISO: string | null,
  followers: FollowerSnapshot | null | undefined,
  now: Date,
): GoalProgress {
  const list = Array.isArray(posts) ? posts : [];
  const nowMs = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const t0ms = sinceISO != null ? Date.parse(sinceISO) : NaN;
  const armed = sinceISO != null && Number.isFinite(t0ms);
  const windowMs = GOAL.windowDays * DAY_MS;

  const elapsedMs = armed ? Math.max(0, nowMs - t0ms) : 0;
  const remainingMs = armed ? Math.max(0, windowMs - elapsedMs) : windowMs;
  const windowClosed = armed && remainingMs <= 0;
  const daysLeft = Math.floor(remainingMs / DAY_MS);
  const hoursLeft = Math.floor((remainingMs % DAY_MS) / HOUR_MS);
  const elapsedDays = elapsedMs / DAY_MS;
  const remainingDays = remainingMs / DAY_MS;

  // Armed ⇒ only posts posted at/after t0 count. Pending ⇒ all posts (running totals).
  const inWindow = (p: any): boolean => {
    if (!armed) return true;
    const t = Date.parse(p?.posted_at || "");
    return Number.isFinite(t) && t >= t0ms;
  };

  const agg: Record<PlatformKey, { views: number; likes: number; posts: number }> = {
    instagram: { views: 0, likes: 0, posts: 0 },
    tiktok: { views: 0, likes: 0, posts: 0 },
  };
  const arms = new Map<string, ArmAgg>();

  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    if (!inWindow(p)) continue;
    const m = p.metrics && typeof p.metrics === "object" ? p.metrics : {};
    const views = num(m.video_views);
    const likes = num(m.reactions);
    const plat = platformOf(p);
    if (plat === "instagram" || plat === "tiktok") {
      agg[plat].views += views;
      agg[plat].likes += likes;
      agg[plat].posts += 1;
    }
    const arm = armOf(p);
    const family = familyOf(p);
    const cur = arms.get(arm) || { arm, family, views: 0, likes: 0, posts: 0 };
    cur.views += views;
    cur.likes += likes;
    cur.posts += 1;
    if ((cur.family === "—" || !cur.family) && family !== "—") cur.family = family;
    arms.set(arm, cur);
  }

  const combinedTotals = {
    views: agg.instagram.views + agg.tiktok.views,
    likes: agg.instagram.likes + agg.tiktok.likes,
    posts: agg.instagram.posts + agg.tiktok.posts,
  };

  const metric = (value: number, target: number): GoalMetric => ({
    value,
    target,
    pct: target > 0 ? (value / target) * 100 : 0,
  });
  // Observed in-window rate. null before kickoff / with no elapsed time (honest "—").
  const observed = (value: number): number | null => (armed && elapsedDays > 0 ? value / elapsedDays : null);
  // Rate still needed. 0 when already met; null when the window has closed unmet (∞/impossible).
  const needed = (target: number, current: number): number | null => {
    const rem = Math.max(0, target - current);
    if (rem <= 0) return 0;
    if (remainingDays <= 0) return null;
    return rem / remainingDays;
  };

  const fSnap = followers && typeof followers === "object" ? followers : null;
  const followersPending = !fSnap;
  const followerVal = (plat: PlatformKey): number | null => {
    if (!fSnap) return null;
    const f = (fSnap as any)[plat];
    const v = f && typeof f === "object" ? Number(f.followers) : NaN;
    return Number.isFinite(v) ? v : null;
  };
  const followerMetric = (value: number | null, target: number): FollowerMetric => ({
    value,
    target,
    pct: value != null && target > 0 ? (value / target) * 100 : null,
  });

  const scope = (
    s: Scope,
    v: { views: number; likes: number; posts: number },
    followerValue: number | null,
    followerTarget: number,
    viewsTarget: number,
    likesTarget: number,
  ): ScopeProgress => ({
    scope: s,
    views: metric(v.views, viewsTarget),
    likes: metric(v.likes, likesTarget),
    followers: followerMetric(followerValue, followerTarget),
    posts: v.posts,
    paceViewsPerDay: observed(v.views),
    paceLikesPerDay: observed(v.likes),
    neededViewsPerDay: needed(viewsTarget, v.views),
    neededLikesPerDay: needed(likesTarget, v.likes),
  });

  // The combined mandate is split evenly per platform for the per-platform bars;
  // the combined bars use the full mandate. Followers are per-platform (1k each).
  const perViews = GOAL.views / 2;
  const perLikes = GOAL.likes / 2;
  const igF = followerVal("instagram");
  const ttF = followerVal("tiktok");
  const combinedF = !fSnap || (igF == null && ttF == null) ? null : (igF || 0) + (ttF || 0);

  const topArmsByViews = [...arms.values()]
    .filter((a) => a.views > 0)
    .sort((a, b) => b.views - a.views || b.likes - a.likes)
    .slice(0, 3);
  const topArmsByLikes = [...arms.values()]
    .filter((a) => a.likes > 0)
    .sort((a, b) => b.likes - a.likes || b.views - a.views)
    .slice(0, 3);

  return {
    armed,
    since: armed ? new Date(t0ms).toISOString() : null,
    now: new Date(nowMs).toISOString(),
    windowDays: GOAL.windowDays,
    elapsedMs,
    remainingMs,
    daysLeft,
    hoursLeft,
    windowClosed,
    instagram: scope("instagram", agg.instagram, igF, GOAL.followersPerPlatform, perViews, perLikes),
    tiktok: scope("tiktok", agg.tiktok, ttF, GOAL.followersPerPlatform, perViews, perLikes),
    combined: scope("combined", combinedTotals, combinedF, GOAL.followersPerPlatform * 2, GOAL.views, GOAL.likes),
    topArmsByViews,
    topArmsByLikes,
    followersPending,
  };
}
