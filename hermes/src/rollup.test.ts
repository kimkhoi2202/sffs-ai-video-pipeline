/**
 * rollup.test.ts — the pure rollup math, focused on the P3 addition: timeBucket
 * (best-time-of-day signal off posted_at) and by_time_bucket in computeRollups.
 *
 * rollup.ts is dependency-free (no config/network), so this imports it directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { timeBucket, computeRollups, median } from "./rollup.ts";

test("median: basic", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("timeBucket: uses the hour AS WRITTEN (respects the ts's own tz offset)", () => {
  assert.equal(timeBucket("2026-07-19T18:12:18-05:00"), "evening (18-24)"); // written hour 18
  assert.equal(timeBucket("2026-07-19T03:00:00-05:00"), "night (0-6)");
  assert.equal(timeBucket("2026-07-19T09:30:00Z"), "morning (6-12)");
  assert.equal(timeBucket("2026-07-19T13:00:00+02:00"), "afternoon (12-18)");
});

test("timeBucket: date-only + missing + junk", () => {
  assert.equal(timeBucket("2026-07-19"), "night (0-6)"); // midnight UTC fallback
  assert.equal(timeBucket(null), undefined);
  assert.equal(timeBucket(""), undefined);
  assert.equal(timeBucket("not-a-date"), undefined);
});

test("computeRollups: includes by_time_bucket, grouping on posted_at", () => {
  const posts = [
    { variant: { family: "narration", arm: "full" }, platform: "tiktok", hashtag_set: "A", posted_at: "2026-07-01T19:00:00-05:00", metrics: { source: "api", eng_rate: 6, reach: 100 } },
    { variant: { family: "narration", arm: "full" }, platform: "tiktok", hashtag_set: "A", posted_at: "2026-07-02T20:00:00-05:00", metrics: { source: "api", eng_rate: 8, reach: 120 } },
    { variant: { family: "tempo", arm: "fast" }, platform: "instagram", hashtag_set: "B", posted_at: "2026-07-03T09:00:00-05:00", metrics: { source: "api", eng_rate: 2, reach: 50 } },
    { variant: { family: "tempo", arm: "fast" }, platform: "instagram", hashtag_set: "B", metrics: { source: "pending", eng_rate: null } }, // no posted_at -> excluded from time bucket
  ];
  const r = computeRollups(posts);
  assert.ok(r.by_time_bucket);
  // two evening posts + one morning post; the pending/no-posted_at one is excluded
  assert.equal(r.by_time_bucket["evening (18-24)"].n_posts, 2);
  assert.equal(r.by_time_bucket["evening (18-24)"].n_with_metrics, 2);
  assert.equal(r.by_time_bucket["evening (18-24)"].median_eng_rate, 7); // median(6,8)
  assert.equal(r.by_time_bucket["morning (6-12)"].n_posts, 1);
  assert.ok(!("night (0-6)" in r.by_time_bucket)); // nobody posted at night
  // the other cuts still work
  assert.equal(r.by_variant_family["narration"].n_posts, 2);
});
