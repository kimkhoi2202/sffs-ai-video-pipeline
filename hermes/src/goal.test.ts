/**
 * goal.test.ts — proves the goal target + HONEST trajectory math (pure
 * computeGoalProgress). Before kickoff => "not started"; after => real per-platform
 * views/likes from ab-database.json, days-left, and pace-vs-pace-needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGoalProgress, GOAL } from "./goal.ts";

const post = (platform: string, views: number, likes: number, posted_at: string) => ({
  platform,
  posted_at,
  post_state: "published",
  metrics: { video_views: views, reactions: likes },
});

test("the encoded target is the mandate: 1M views + 200k likes / 7 days + 1k followers each", () => {
  assert.equal(GOAL.views, 1_000_000);
  assert.equal(GOAL.likes, 200_000);
  assert.equal(GOAL.followers_each, 1_000);
  assert.equal(GOAL.days, 7);
  assert.deepEqual([...GOAL.platforms], ["instagram", "tiktok"]);
});

test("before kickoff (since=null) => not started, full 7 days left, pending note", () => {
  const g = computeGoalProgress([], null, {}, new Date("2026-07-22T18:00:00Z"));
  assert.equal(g.started, false);
  assert.equal(g.days_left, 7);
  assert.match(g.note, /kickoff pending/i);
  assert.equal(g.totals.views, 0);
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
  assert.equal(ig.likes, 150);
  assert.equal(tt.views, 3000); // pre-t0 post excluded
  assert.equal(tt.followers, 300);
  assert.equal(g.totals.views, 5000);
  assert.equal(g.totals.likes, 400);
  assert.equal(g.days_left, 6);
  // pace: ~5000 views in 1 day; need the rest over 6 days
  assert.equal(g.pace.views_per_day, 5000);
  assert.ok(g.pace.views_needed_per_day > 100000, "needs a huge daily pace (honest stretch)");
  assert.equal(g.pace.on_track_views, false); // 5k << 1M*(1/7)
});

test("followers are honest-pending (null) when unmeasured", () => {
  const g = computeGoalProgress([], "2026-07-20T12:00:00Z", {}, new Date("2026-07-20T18:00:00Z"));
  for (const p of g.per_platform) assert.equal(p.followers, null);
});
