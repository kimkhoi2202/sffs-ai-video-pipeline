/**
 * analyticsArchive.test.ts — the guarantees the archive is worth nothing without.
 *
 * Three bug classes are guarded here, all of which have already cost this campaign
 * real data:
 *   FIDELITY  a row that arrives with twenty keys must be stored with twenty keys.
 *             The loop's own readers keep thirteen, and the seven they drop include
 *             the caption — the last join key a post has once the scheduler forgets it.
 *   TIME      a Metricool timestamp is naive local on the BRAND's clock, not ours.
 *             Storing the bare string is how a 00:21 Chicago reel got filed as morning.
 *   APPEND    a snapshot must never be able to address, and therefore never overwrite,
 *             an earlier snapshot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSnapshot,
  DestinationExists,
  resolveInstant,
  snapshotId,
  snapshotKey,
  timeIndexFor,
  writeOnce,
} from "./analyticsArchive.ts";
import { ANALYTICS_SOURCES } from "./metricool.ts";
import { timeBucket } from "./rollup.ts";

// A real Instagram reel row, keys and all, as returned on 2026-08-04.
const REEL = {
  reelId: "17973599667083692",
  userId: "Smart Fella or Fart Smella?",
  type: "REELS_VIDEO",
  publishedAt: { dateTime: "2026-08-03T07:21:00", timezone: "Europe/Madrid" },
  url: "https://www.instagram.com/reel/DbkOPP0mGpx/",
  content: "only 3% of people get this one right...",
  imageUrl: "https://scontent.cdninstagram.com/x.jpg",
  likes: 0,
  comments: 0,
  interactions: 2,
  engagement: 1.8181818181818181,
  views: 124,
  reach: 110,
  saved: 1,
  shares: 1,
  impressionsTotal: 124,
  averageWatchTime: 6.332,
  videoViewTotalTime: 690.261,
  durationSeconds: 97,
  reelsSkipRate: 70.8,
};

// ── the read surface cannot become a write surface ──

test("SOURCES: every enumerated analytics path is a /v2/analytics/ read", () => {
  const paths = Object.values(ANALYTICS_SOURCES);
  assert.ok(paths.length >= 4, "expected the four live analytics sources");
  for (const p of paths) assert.match(p, /^\/v2\/analytics\//, `${p} is not an analytics read path`);
});

// ── FIDELITY ──

test("FIDELITY: a captured row keeps every key it arrived with", () => {
  const snap = buildSnapshot({
    capturedAtMs: Date.parse("2026-08-04T00:11:08Z"),
    requestTimezone: "America/Chicago",
    window: { from: "2026-01-01T00:00:00", to: "2027-12-31T23:59:59" },
    sources: { instagramReels: { path: "/v2/analytics/reels/instagram", request: {}, ok: true, row_count: 1, rows: [REEL] } },
  });
  assert.deepEqual(snap.sources.instagramReels.rows[0], REEL);
  assert.deepEqual(Object.keys(snap.sources.instagramReels.rows[0] as object).sort(), Object.keys(REEL).sort());
});

test("FIDELITY: the fields the loop's own reader drops are present", () => {
  const snap = buildSnapshot({
    capturedAtMs: 0,
    requestTimezone: "America/Chicago",
    window: { from: "a", to: "b" },
    sources: { instagramReels: { path: "/v2/analytics/reels/instagram", request: {}, ok: true, row_count: 1, rows: [REEL] } },
  });
  const row = snap.sources.instagramReels.rows[0] as Record<string, unknown>;
  // instagramReels() keeps 13 of these 20; these seven only exist in the archive.
  for (const k of ["content", "imageUrl", "engagement", "impressionsTotal", "videoViewTotalTime", "type", "userId"]) {
    assert.ok(k in row, `archive dropped ${k}`);
  }
  // ...and the two the read bridge was dropping until 2026-08-03.
  assert.equal(row.durationSeconds, 97);
  assert.equal(row.saved, 1);
});

test("FIDELITY: the time index is ADDITIVE — it never replaces the row", () => {
  const snap = buildSnapshot({
    capturedAtMs: 0,
    requestTimezone: "America/Chicago",
    window: { from: "a", to: "b" },
    sources: { instagramReels: { path: "/v2/analytics/reels/instagram", request: {}, ok: true, row_count: 1, rows: [REEL] } },
  });
  const idx = snap.sources.instagramReels.time_index[0];
  assert.equal(idx.id, REEL.reelId);
  // the raw value is retained so a later reader can redo the resolution itself
  assert.deepEqual(idx.raw, REEL.publishedAt);
});

// ── TIME ──

test("TIME: an Instagram pair resolves to the true instant AND the account's clock", () => {
  const r = resolveInstant(REEL.publishedAt);
  assert.equal(r.utc, "2026-08-03T05:21:00.000Z"); // 07:21 Madrid (CEST) is 05:21 UTC
  assert.equal(r.account, "2026-08-03T00:21:00-05:00"); // which is 00:21 Chicago
  assert.equal(r.declared_zone, "Europe/Madrid");
  assert.equal(r.zone_assumed, false);
});

test("TIME: REGRESSION — the archived stamp does not read as morning", () => {
  assert.equal(timeBucket(REEL.publishedAt.dateTime), "morning (6-12)"); // what the bare string said
  assert.equal(timeBucket(resolveInstant(REEL.publishedAt).account), "night (0-6)"); // what happened
});

test("TIME: TikTok's +0200 string is an absolute instant, not a guess", () => {
  const r = resolveInstant("2026-07-31T19:03:26+0200");
  assert.equal(r.utc, "2026-07-31T17:03:26.000Z");
  assert.equal(r.zone_assumed, false);
  assert.equal(r.account, "2026-07-31T12:03:26-05:00");
});

test("TIME: a naive string with nothing declaring its zone is FLAGGED as assumed", () => {
  const r = resolveInstant("2026-08-03T07:21:00", "America/Chicago");
  assert.equal(r.zone_assumed, true);
  assert.equal(r.declared_zone, null);
  assert.equal(r.utc, "2026-08-03T12:21:00.000Z");
});

test("TIME: an unusable timestamp resolves to nulls rather than a plausible lie", () => {
  for (const bad of [null, undefined, "", {}, { dateTime: "" }, 42]) {
    assert.equal(resolveInstant(bad).utc, null);
  }
});

test("TIME: every network lands on one clock", () => {
  const ig = resolveInstant({ dateTime: "2026-08-03T07:21:00", timezone: "Europe/Madrid" });
  const tt = resolveInstant("2026-08-03T05:21:00.000Z");
  assert.equal(ig.utc, tt.utc);
  assert.equal(ig.account, tt.account);
});

test("TIME: each source's id and timestamp are read from ITS OWN field names", () => {
  assert.equal(timeIndexFor("tiktokPosts", [{ videoId: "7668", createTime: "2026-07-31T19:03:26+0200" }])[0].id, "7668");
  assert.equal(timeIndexFor("youtubePosts", [{ videoId: "Y7g", publishedAt: { dateTime: "2026-07-29T03:35:56", timezone: "Europe/Madrid" } }])[0].utc, "2026-07-29T01:35:56.000Z");
  assert.equal(timeIndexFor("schedulerPosts", [{ uuid: "-4436", publicationDate: { dateTime: "2026-08-04T02:39:00", timezone: "America/Chicago" } }])[0].id, "-4436");
});

// ── APPEND-ONLY ──

test("APPEND: the key is dated and carries the capture instant", () => {
  const k = snapshotKey(Date.parse("2026-08-04T00:11:08Z"));
  assert.equal(k, "dt=2026-08-04/snapshot-20260804T001108Z.json");
});

test("APPEND: two captures a second apart cannot address the same object", () => {
  const a = snapshotKey(Date.parse("2026-08-04T00:11:08Z"));
  const b = snapshotKey(Date.parse("2026-08-04T00:11:09Z"));
  assert.notEqual(a, b);
  assert.notEqual(snapshotId(0), snapshotId(1000));
});

test("APPEND: the disk writer refuses an existing path instead of clobbering it", () => {
  const dir = mkdtempSync(join(tmpdir(), "arch-"));
  const p = join(dir, "dt=2026-08-04", "snapshot-x.json");
  writeOnce(p, '{"first":true}');
  assert.throws(() => writeOnce(p, '{"second":true}'), DestinationExists);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).first, true, "the original survived");
});

// ── coverage reporting ──

test("COVERAGE: reports how far back the snapshot actually reaches", () => {
  const rows = [
    { reelId: "a", publishedAt: { dateTime: "2026-07-20T01:12:18", timezone: "Europe/Madrid" } },
    { reelId: "b", publishedAt: { dateTime: "2026-08-03T07:21:00", timezone: "Europe/Madrid" } },
  ];
  const snap = buildSnapshot({
    capturedAtMs: Date.parse("2026-08-04T00:11:08Z"),
    requestTimezone: "America/Chicago",
    window: { from: "a", to: "b" },
    sources: { instagramReels: { path: "/v2/analytics/reels/instagram", request: {}, ok: true, row_count: 2, rows } },
  });
  const c = snap.coverage.instagramReels;
  assert.equal(c.rows, 2);
  assert.equal(c.earliest_utc, "2026-07-19T23:12:18.000Z");
  assert.equal(c.latest_utc, "2026-08-03T05:21:00.000Z");
  assert.equal(c.days, 14.3);
});

test("COVERAGE: a failed source is recorded in the file, not just in a log", () => {
  const snap = buildSnapshot({
    capturedAtMs: 0,
    requestTimezone: "America/Chicago",
    window: { from: "a", to: "b" },
    sources: { youtubePosts: { path: "/v2/analytics/posts/youtube", request: {}, ok: false, error: "HTTP 403", row_count: 0, rows: [] } },
  });
  assert.equal(snap.sources.youtubePosts.ok, false);
  assert.equal(snap.sources.youtubePosts.error, "HTTP 403");
  assert.equal(snap.coverage.youtubePosts.earliest_utc, null);
});
