/**
 * liveGoal.test.ts — the goal rollup tells the truth.
 *
 * THE NUMBER IT GOT WRONG. On 2026-08-02 the dashboard reported 9,500 views over 28
 * Instagram posts. The analytics API, asked directly the same afternoon, said 39,382
 * over 101 across three networks. The rollup summed ab-database.metrics.video_views,
 * which only counts posts the reconcile join has attributed — 45 of 89 Instagram rows
 * and 0 of 43 YouTube rows — so it was wrong by roughly 4x, always downward, and
 * YouTube was missing rather than zero.
 *
 * The split these pin: TOTALS come from live analytics; the ab-database is the
 * fallback. Attribution can lag. The headline cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-goal-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const { computeGoalProgress, GOAL } = await import("./goal.ts");
const { buildAnalyticsSnapshot } = await import("./score.ts");

const SINCE = "2026-07-28T00:00:00Z";
const flat = (network: string, views: number, at: string, id: string) =>
  ({ post_id: id, account_id: "", network, scheduled_at: at, views, reach: views, likes: 0, comments: 0, shares: 0, saves: null, engagement: null, engagement_rate: null, skip_rate: null, average_watch_time: null, duration_seconds: null }) as any;

// The shape of the real disagreement: a few attributed posts in the ab-database,
// many more actually live.
const abPosts = [
  { platform: "instagram", posted_at: "2026-07-30T10:00:00Z", metrics: { video_views: 5000 } },
  { platform: "instagram", posted_at: "2026-07-31T10:00:00Z", metrics: { video_views: 4500 } },
];
const live = [
  flat("instagram", 20000, "2026-07-30T10:00:00Z", "ig1"),
  flat("instagram", 13000, "2026-07-31T10:00:00Z", "ig2"),
  flat("tiktok", 6200, "2026-07-31T12:00:00Z", "tt1"),
  flat("youtube", 182, "2026-08-01T09:00:00Z", "yt1"),
];

test("with a live snapshot, the total is the LIVE total, not the join", () => {
  const g = computeGoalProgress(abPosts, SINCE, {}, new Date("2026-08-02T18:00:00Z"), live.map((f) => ({ network: f.network, published_at: f.scheduled_at, views: f.views })));
  assert.equal(g.totals.views, 39382, "20000 + 13000 + 6200 + 182");
  const ig = g.per_platform.find((p) => p.platform === "instagram")!;
  assert.equal(ig.views, 33000);
  assert.equal(ig.posts, 2);
});

test("YOUTUBE IS COUNTED — it used to be absent, which is worse than zero", () => {
  const g = computeGoalProgress(abPosts, SINCE, {}, new Date("2026-08-02T18:00:00Z"), live.map((f) => ({ network: f.network, published_at: f.scheduled_at, views: f.views })));
  const yt = g.per_platform.find((p) => p.platform === "youtube");
  assert.ok(yt, "youtube must have a row at all");
  assert.equal(yt!.views, 182);
  assert.ok(GOAL.platforms.includes("youtube" as any));
});

test("without a snapshot it falls back to the join, so a fresh box still reports", () => {
  const g = computeGoalProgress(abPosts, SINCE, {}, new Date("2026-08-02T18:00:00Z"), null);
  assert.equal(g.totals.views, 9500, "the old number, from the only source available");
});

test("an EMPTY snapshot is not mistaken for 'zero views everywhere'", () => {
  // A snapshot that failed to write must not silently zero the dashboard.
  const g = computeGoalProgress(abPosts, SINCE, {}, new Date("2026-08-02T18:00:00Z"), []);
  assert.equal(g.totals.views, 9500);
});

test("the kickoff window still applies to live rows", () => {
  const withOld = [...live, { network: "instagram", published_at: "2026-07-01T10:00:00Z", views: 999999 }];
  const g = computeGoalProgress(abPosts, SINCE, {}, new Date("2026-08-02T18:00:00Z"), withOld.map((f: any) => ({ network: f.network, published_at: f.published_at ?? f.scheduled_at, views: f.views })));
  assert.equal(g.totals.views, 39382, "a pre-kickoff post must not be counted");
});

// ── the snapshot builder ─────────────────────────────────────────────────────

test("buildAnalyticsSnapshot folds flat insights into per-network totals", () => {
  const s = buildAnalyticsSnapshot(live, "2026-07-01", "2026-08-02", new Date("2026-08-02T18:00:00Z"));
  assert.equal(s.totals.views, 39382);
  assert.equal(s.totals.posts, 4);
  assert.equal(s.by_network.instagram.views, 33000);
  assert.equal(s.by_network.instagram.posts, 2);
  assert.equal(s.by_network.youtube.views, 182);
  assert.equal(s.rows.length, 4, "rows are kept so the goal window can still be applied");
  assert.equal(s.rows[0].published_at, "2026-07-30T10:00:00Z");
});

test("buildAnalyticsSnapshot survives an empty pull without inventing zeros", () => {
  const s = buildAnalyticsSnapshot([], "2026-07-01", "2026-08-02");
  assert.equal(s.totals.views, 0);
  assert.equal(s.rows.length, 0);
  assert.deepEqual(s.by_network, {}, "no networks claimed when nothing was returned");
});
