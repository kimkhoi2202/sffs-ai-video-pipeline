/**
 * skipRatePipeline.test.ts — the 3-second SKIP RATE has to survive the whole way from
 * a Metricool insight to a rollup cell, because that is the metric the promotion gate
 * judges on and the leg that was missing.
 *
 * These drive the REAL functions the loop runs (metricsFromInsight from score.ts, and
 * computeRollups/groupMedian from rollup.ts) rather than asserting on hand-built
 * objects. The bug being locked out was invisible precisely because every helper
 * around it behaved correctly in isolation: insights.ts read skipRate, the rollup
 * computed medians, and the metric still never arrived.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { metricsFromInsight } from "./score.ts";
import { computeRollups, groupMedian, hasMatureMetrics } from "./rollup.ts";
import type { FlatInsight } from "./insights.ts";

function insight(over: Partial<FlatInsight> = {}): FlatInsight {
  return {
    post_id: "p1", account_id: "acc", network: "instagram",
    scheduled_at: "2026-07-20T12:00:00Z", post_link: null as unknown as string,
    views: 1000, reach: 900, likes: 20, comments: 3, shares: 1, saves: null,
    engagement: 24, engagement_rate: 2.67,
    skip_rate: 71.4, average_watch_time: 4.1,
    ...over,
  } as FlatInsight;
}

/** An ab-database row carrying exactly what score.ts persists. */
function post(arm: string, skip: number | null, eng: number | null = 3.0) {
  const f = insight({ skip_rate: skip, engagement_rate: eng });
  return { variant: { label: arm }, platform: "instagram", metrics: metricsFromInsight(f, null, "2026-07-28") };
}

test("SKIP RATE: score.ts actually persists it — the leg that was missing", () => {
  const m = metricsFromInsight(insight({ skip_rate: 66.5 }), null, "2026-07-28");
  assert.equal(m.skip_rate, 66.5, "skip_rate must reach the persisted metrics object");
  assert.equal(m.source, "api");
  // and the fields that were already there are untouched
  assert.equal(m.reach, 900);
  assert.equal(m.eng_rate, 2.67);
});

test("SKIP RATE: a null (TikTok) skip rate stays null and is never fabricated as 0", () => {
  const m = metricsFromInsight(insight({ network: "tiktok", skip_rate: null }), null, "2026-07-28");
  assert.equal(m.skip_rate, null, "a missing skip rate is unknown, not a perfect hook");
  assert.notEqual(m.skip_rate, 0);
});

test("SKIP RATE: a previously stored value survives a refresh that has no new one", () => {
  const prev = { skip_rate: 70.0, eng_rate: 1.0, source: "api" };
  const m = metricsFromInsight(insight({ skip_rate: null }), prev, "2026-07-29");
  assert.equal(m.skip_rate, 70.0);
});

test("SKIP RATE: it reaches the rollup cell as median_skip_rate", () => {
  const posts = [post("control", 80), post("control", 78), post("no-narration", 60), post("no-narration", 64)];
  const cells = groupMedian(posts, (p) => p.variant?.label);
  assert.equal(cells["control"].median_skip_rate, 79);
  assert.equal(cells["no-narration"].median_skip_rate, 62);
  assert.equal(cells["control"].n_by_metric.median_skip_rate, 2);
});

test("SKIP RATE: n_by_metric counts the posts backing EACH median, not just any metric", () => {
  // 3 matured posts, but only 2 carry a skip rate. Promoting on "3 samples" when only
  // 2 back the judged metric is exactly the noise the min-sample gate exists to stop.
  const posts = [post("arm", 70), post("arm", 74), post("arm", null, 5.0)];
  const cells = groupMedian(posts, (p) => p.variant?.label);
  assert.equal(cells["arm"].n_with_metrics, 3, "all three matured");
  assert.equal(cells["arm"].n_by_metric.median_skip_rate, 2, "only two carry a skip rate");
  assert.equal(cells["arm"].n_by_metric.median_eng_rate, 3);
  assert.equal(cells["arm"].median_skip_rate, 72);
});

test("SKIP RATE: a post with a skip rate but NO eng_rate still counts as matured", () => {
  // hasMatureMetrics used to require eng_rate, so a post carrying only the metric the
  // policy judges on was treated as having no data at all and could never be scored.
  const p = post("arm", 68, null);
  assert.equal(hasMatureMetrics(p), true);
  const cells = groupMedian([p], (x) => x.variant?.label);
  assert.equal(cells["arm"].n_with_metrics, 1);
  assert.equal(cells["arm"].median_skip_rate, 68);
  assert.equal(cells["arm"].median_eng_rate, null, "no eng_rate to average, and none invented");
  assert.equal(cells["arm"].n_by_metric.median_eng_rate, 0);
});

test("SKIP RATE: pending metrics are still excluded", () => {
  const p = { variant: { label: "arm" }, metrics: { skip_rate: 50, source: "pending" } };
  assert.equal(hasMatureMetrics(p), false);
  const cells = groupMedian([p], (x) => x.variant?.label);
  assert.equal(cells["arm"].n_with_metrics, 0);
  assert.equal(cells["arm"].median_skip_rate, null);
});

test("SKIP RATE: computeRollups exposes it on the by_variant_arm cut promote.py reads", () => {
  const posts = [post("control", 80), post("no-answer", 62)];
  const r = computeRollups(posts);
  assert.equal(r.by_variant_arm["control"].median_skip_rate, 80);
  assert.equal(r.by_variant_arm["no-answer"].median_skip_rate, 62);
  assert.ok("n_by_metric" in r.by_variant_arm["control"]);
});
