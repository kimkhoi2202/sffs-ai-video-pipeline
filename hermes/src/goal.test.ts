/**
 * goal.test.ts — proves the goal target + HONEST trajectory math (pure
 * computeGoalProgress). Before kickoff => "not started"; after => real per-platform
 * views/likes from ab-database.json, days-left, and pace-vs-pace-needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGoalProgress, GOAL, WINDOW_START, goalWindowStart } from "./goal.ts";
import { KICKOFF_ENV, KICKOFF_TOKEN } from "./kickoff.ts";

const post = (platform: string, views: number, likes: number, posted_at: string) => ({
  platform,
  posted_at,
  post_state: "published",
  metrics: { video_views: views, reactions: likes },
});

test("the encoded target is the mandate: 500k views / 14 days + 500 followers each (no likes goal)", () => {
  assert.equal(GOAL.views, 500_000);
  assert.equal(GOAL.followers_each, 500);
  assert.equal(GOAL.days, 14, "extended 7 -> 14 by owner decision 2026-08-03");
  // YouTube joined the VIEWS universe on 2026-08-02. It had been half of everything
  // published and contributed nothing to the rollup — not zero, absent.
  assert.deepEqual([...GOAL.platforms], ["instagram", "tiktok", "youtube"]);
  // The FOLLOWERS target is still IG + TikTok only; there is no YouTube follower goal.
  assert.deepEqual([...GOAL.follower_platforms], ["instagram", "tiktok"]);
  // likes were dropped from the mandate entirely
  assert.equal((GOAL as Record<string, unknown>).likes, undefined);
});

test("before kickoff (since=null) => not started, the full window left, pending note", () => {
  const g = computeGoalProgress([], null, {}, new Date("2026-07-22T18:00:00Z"));
  assert.equal(g.started, false);
  assert.equal(g.days_left, GOAL.days);
  assert.match(g.note, /kickoff pending/i);
  assert.equal(g.totals.views, 0);
});

// ── The window anchor: separate from the kickoff switch ──────────────────────

test("WINDOW: the clock is anchored on WINDOW_START, not on the kickoff mtime", () => {
  // The kickoff file's mtime is the audit record of when a HUMAN armed autonomy. Before
  // 2026-08-03 it doubled as the mandate's t0, which meant re-anchoring the goal window
  // required touching a human-only safety switch. Anchoring the window here keeps the
  // arming record intact and makes the re-anchor reviewable in git.
  assert.equal(WINDOW_START, "2026-08-03T22:00:00.000Z");
  const prev = process.env[KICKOFF_ENV];
  process.env[KICKOFF_ENV] = KICKOFF_TOKEN;
  try {
    assert.equal(goalWindowStart(process.env), WINDOW_START, "armed => the explicit anchor wins");
  } finally {
    if (prev === undefined) delete process.env[KICKOFF_ENV];
    else process.env[KICKOFF_ENV] = prev;
  }
});

test("WINDOW: an UN-ARMED box still has no window, whatever the anchor says", () => {
  // Fail-closed is the property that matters: setting a window start must never be a
  // second way to arm the loop. Point the data dir at somewhere with no arming file.
  const prevEnv = process.env[KICKOFF_ENV];
  const prevDir = process.env.HERMES_DATA_DIR;
  delete process.env[KICKOFF_ENV];
  process.env.HERMES_DATA_DIR = "/nonexistent-kickoff-dir-for-tests";
  try {
    assert.equal(goalWindowStart(process.env), null);
  } finally {
    if (prevEnv === undefined) delete process.env[KICKOFF_ENV];
    else process.env[KICKOFF_ENV] = prevEnv;
    if (prevDir === undefined) delete process.env.HERMES_DATA_DIR;
    else process.env.HERMES_DATA_DIR = prevDir;
  }
});

test("WINDOW: 14 days from the anchor is what the trajectory is measured against", () => {
  // Anchored at WINDOW_START the window closes 2026-08-17; nothing published before the
  // anchor counts, which is the cost of re-anchoring and is stated rather than hidden.
  const now = new Date("2026-08-10T22:00:00.000Z"); // 7 days in
  const g = computeGoalProgress(
    [
      post("instagram", 40_000, 0, "2026-07-25T12:00:00Z"), // prior window => excluded
      post("instagram", 10_000, 0, "2026-08-05T12:00:00Z"),
    ],
    WINDOW_START,
    {},
    now,
  );
  assert.equal(g.totals.views, 10_000, "the first window's views do not carry forward");
  assert.equal(g.days_left, 7);
  assert.equal(g.window_days, 14);
  assert.equal(g.pace.views_needed_per_day, 70_000);
});

test("after kickoff: per-platform views/likes aggregate from real post metrics", () => {
  const since = "2026-07-20T12:00:00Z";
  const now = new Date("2026-07-21T12:00:00Z"); // 1 day in
  const posts = [
    post("instagram", 500, 40, "2026-07-20T15:00:00Z"),
    post("instagram", 1500, 110, "2026-07-21T09:00:00Z"),
    post("tiktok", 3000, 250, "2026-07-20T20:00:00Z"),
    post("tiktok", 20, 1, "2026-07-19T00:00:00Z"), // BEFORE t0 => excluded
  ];
  const g = computeGoalProgress(posts, since, { instagram: 120, tiktok: 300 }, now);
  assert.equal(g.started, true);
  const ig = g.per_platform.find((p) => p.platform === "instagram")!;
  const tt = g.per_platform.find((p) => p.platform === "tiktok")!;
  assert.equal(ig.views, 2000);
  assert.equal(tt.views, 3000); // pre-t0 post excluded
  assert.equal(tt.followers, 300);
  assert.equal(g.totals.views, 5000);
  assert.equal(g.days_left, 13);
  // pace: ~5000 views in 1 day; need the rest over 13 days
  assert.equal(g.pace.views_per_day, 5000);
  assert.ok(g.pace.views_needed_per_day > 35000, "needs a big daily pace (honest stretch toward 500k)");
  assert.equal(g.pace.on_track_views, false); // 5k << 500k*(1/14)
  // likes are no longer part of the goal shape
  assert.equal((g.totals as Record<string, unknown>).likes, undefined);
});

test("followers are honest-pending (null) when unmeasured", () => {
  const g = computeGoalProgress([], "2026-07-20T12:00:00Z", {}, new Date("2026-07-20T18:00:00Z"));
  for (const p of g.per_platform) assert.equal(p.followers, null);
});
