/**
 * goal.ts — pure GOAL-PROGRESS math for the READ-ONLY dashboard.
 *
 * Encodes Hermes's mandate and turns ab-database posts (+ an optional follower
 * snapshot) into the honest live trajectory toward it. NO HTML, NO disk, NO
 * network, NO secrets — just data in → numbers out, so it is trivially unit-
 * testable (see test/dashboard.test.ts) and can never leak anything.
 *
 * THE MANDATE (fixed constants below):
 *   200,000 views in 14 DAYS (combined across IG + TikTok + YouTube), and 500
 *   followers on EACH of Instagram and TikTok. (Likes are NOT a goal metric — no
 *   like target or trajectory anywhere in the goal.)
 *
 * The clock only runs once KICKOFF is armed. Until armed, `sinceISO` is null: the
 * window is "not started", the clock reads the full window, and the running totals are
 * computed over ALL posts (informational). Once armed, only posts with posted_at >= t0
 * count toward the window, where t0 is WINDOW_START when set and the kickoff mtime
 * otherwise — see hermes/src/goal.ts for why those became two separate instants.
 * Per platform: views = Σ metrics.video_views.
 * Followers come ONLY from the snapshot; when it is absent they are `null`
 * ("pending"), never 0/fake.
 */

/**
 * Hermes's mandate, as fixed targets — SINGLE SOURCE OF TRUTH (edit to change).
 * Combined = IG + TikTok.
 */
export const GOAL = Object.freeze({
  /**
   * Combined (IG + TikTok + YouTube) view target over the window.
   *
   * 500,000 -> 200,000 on 2026-08-03 by owner decision, and MUST match
   * hermes/src/goal.ts GOAL.views — see there for why 200,000 rather than a rounder
   * number: it is the largest target that any skip-rate band this account has
   * actually measured still reaches. The panel renders which band that is.
   */
  views: 200_000,
  /**
   * follower target on EACH platform (IG and TikTok independently) — i.e. 500 on
   * IG AND 500 on TikTok. This is "per platform", NOT a combined total; flip this
   * one constant (and the ×2 in the combined row) for a combined-followers target.
   */
  followersPerPlatform: 500,
  /** the mandate's window length, in days. 7 -> 14 by owner decision 2026-08-03. */
  windowDays: 14,
  // NOTE: likes are deliberately NOT a goal metric (no like target / trajectory).
});

/**
 * Explicit start of the mandate's clock; null = "use the kickoff instant".
 * MUST match hermes/src/goal.ts WINDOW_START — the loop and this panel are required to
 * render the same trajectory, and two different anchors is the one way to break that.
 */
export const WINDOW_START: string | null = "2026-08-03T22:00:00.000Z";

/**
 * t0 for the goal window, given the kickoff instant the caller read off the arming
 * file. Null in, null out: an un-armed box has no window regardless of WINDOW_START.
 */
export function goalWindowStart(kickoffSince: string | null): string | null {
  if (kickoffSince == null) return null;
  return WINDOW_START ?? kickoffSince;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type PlatformKey = "instagram" | "tiktok" | "youtube";
export type Scope = PlatformKey | "combined";

/**
 * A row of the LIVE analytics snapshot the loop writes each cycle
 * (hermes/src/score.ts buildAnalyticsSnapshot -> hermes-data/analytics-totals.json).
 *
 * When it is supplied it is the source of the view totals, REPLACING the sum over
 * ab-database.metrics.video_views. That sum only ever counted posts the reconcile join
 * had attributed, which on 2026-08-02 was 45 of 89 Instagram rows and none of the 43
 * YouTube ones — so this panel showed 9,500 views over 28 posts while the analytics API
 * reported 39,382 over 101. The panel's job is to state the total honestly; attributing
 * a view to a format is a separate, harder job that is allowed to lag.
 */
export interface LiveAnalyticsRow {
  network: string;
  published_at?: string | null;
  views?: number | null;
}

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
  followers: FollowerMetric;
  /** posts counted in this scope within the window (or all, pre-kickoff). */
  posts: number;
  /** observed rate within the window; null before kickoff (clock not started) or with no elapsed time. */
  paceViewsPerDay: number | null;
  /** rate still required to hit target in the time left; 0 if already met; null once the window has closed unmet (impossible). */
  neededViewsPerDay: number | null;
}
export interface ArmAgg {
  arm: string;
  family: string;
  views: number;
  posts: number;
}
export interface FollowerSnapshot {
  instagram?: { followers?: number };
  tiktok?: { followers?: number };
}
export interface GoalProgress {
  /** true once the KICKOFF file is armed (the window clock is running). */
  armed: boolean;
  /** t0 (ISO) — the WINDOW's start — or null when pending. */
  since: string | null;
  /** When a human armed autonomy. Differs from `since` once the window is re-anchored;
   *  carried so the panel can show both instants instead of quietly replacing one. */
  kickoffSince: string | null;
  now: string;
  windowDays: number;
  elapsedMs: number;
  remainingMs: number;
  daysLeft: number;
  hoursLeft: number;
  /** armed AND the window has elapsed. */
  windowClosed: boolean;
  instagram: ScopeProgress;
  tiktok: ScopeProgress;
  /** YouTube Shorts. Half of everything published, and absent from this panel until
   *  2026-08-02 — its posts were not counted as zero, they were not counted at all. */
  youtube: ScopeProgress;
  combined: ScopeProgress;
  /** "what's moving the needle": top 3 arms by views within the window. */
  topArmsByViews: ArmAgg[];
  /** true when no follower snapshot was supplied (followers render as "pending"). */
  followersPending: boolean;
  /** "live" when the totals came from the analytics snapshot, "ab-database" on fallback. */
  viewsSource: "live" | "ab-database";
}

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

function platformOf(p: any): string {
  const s = String(p?.platform || "").toLowerCase();
  if (s === "instagram" || s === "ig" || s === "ig_business") return "instagram";
  if (s === "tiktok" || s === "tt") return "tiktok";
  if (s === "youtube" || s === "yt" || s === "youtube_shorts") return "youtube";
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
  live?: LiveAnalyticsRow[] | null,
  kickoffSinceISO?: string | null,
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

  const agg: Record<PlatformKey, { views: number; posts: number }> = {
    instagram: { views: 0, posts: 0 },
    tiktok: { views: 0, posts: 0 },
    youtube: { views: 0, posts: 0 },
  };
  const arms = new Map<string, ArmAgg>();

  // TOTALS come from the live snapshot when we have one; the ab-database is only the
  // fallback for a box that has not scored yet.
  const liveRows = Array.isArray(live) ? live : [];
  const useLive = liveRows.length > 0;
  if (useLive) {
    for (const r of liveRows) {
      const plat = platformOf({ platform: r?.network });
      if (plat !== "instagram" && plat !== "tiktok" && plat !== "youtube") continue;
      if (armed) {
        const t = Date.parse(String(r?.published_at ?? ""));
        if (!Number.isFinite(t) || t < t0ms) continue;
      }
      agg[plat].views += num(r?.views);
      agg[plat].posts += 1;
    }
  }

  // The ARM breakdown always comes from the ab-database — it is the only side that
  // knows which format a post was. It is attribution, not a total, so an incomplete
  // join understates a bar rather than the headline number.
  for (const p of list) {
    if (!p || typeof p !== "object") continue;
    if (!inWindow(p)) continue;
    const m = p.metrics && typeof p.metrics === "object" ? p.metrics : {};
    const views = num(m.video_views);
    const plat = platformOf(p);
    if (!useLive && (plat === "instagram" || plat === "tiktok" || plat === "youtube")) {
      agg[plat].views += views;
      agg[plat].posts += 1;
    }
    const arm = armOf(p);
    const family = familyOf(p);
    const cur = arms.get(arm) || { arm, family, views: 0, posts: 0 };
    cur.views += views;
    cur.posts += 1;
    if ((cur.family === "—" || !cur.family) && family !== "—") cur.family = family;
    arms.set(arm, cur);
  }

  const combinedTotals = {
    views: agg.instagram.views + agg.tiktok.views + agg.youtube.views,
    posts: agg.instagram.posts + agg.tiktok.posts + agg.youtube.posts,
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
    v: { views: number; posts: number },
    followerValue: number | null,
    followerTarget: number,
    viewsTarget: number,
  ): ScopeProgress => ({
    scope: s,
    views: metric(v.views, viewsTarget),
    followers: followerMetric(followerValue, followerTarget),
    posts: v.posts,
    paceViewsPerDay: observed(v.views),
    neededViewsPerDay: needed(viewsTarget, v.views),
  });

  // The combined mandate is split evenly across the three publishing networks for the
  // per-platform bars; the combined bars use the full mandate. Followers are
  // per-platform (500 each) and apply to IG and TikTok only — there is no YouTube
  // follower target, so its bar reads "pending" rather than a fabricated 0/500.
  const perViews = GOAL.views / 3;
  const igF = followerVal("instagram");
  const ttF = followerVal("tiktok");
  const combinedF = !fSnap || (igF == null && ttF == null) ? null : (igF || 0) + (ttF || 0);

  const topArmsByViews = [...arms.values()]
    .filter((a) => a.views > 0)
    .sort((a, b) => b.views - a.views || b.posts - a.posts)
    .slice(0, 3);

  return {
    armed,
    since: armed ? new Date(t0ms).toISOString() : null,
    kickoffSince: kickoffSinceISO ?? null,
    now: new Date(nowMs).toISOString(),
    windowDays: GOAL.windowDays,
    elapsedMs,
    remainingMs,
    daysLeft,
    hoursLeft,
    windowClosed,
    instagram: scope("instagram", agg.instagram, igF, GOAL.followersPerPlatform, perViews),
    tiktok: scope("tiktok", agg.tiktok, ttF, GOAL.followersPerPlatform, perViews),
    youtube: scope("youtube", agg.youtube, null, 0, perViews),
    combined: scope("combined", combinedTotals, combinedF, GOAL.followersPerPlatform * 2, GOAL.views),
    topArmsByViews,
    followersPending,
    viewsSource: useLive ? "live" : "ab-database",
  };
}
