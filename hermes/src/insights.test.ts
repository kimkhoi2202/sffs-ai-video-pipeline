/**
 * insights.test.ts — the analytics READ BOUNDARY.
 *
 * Everything here guards one bug class: a timestamp that arrives on somebody else's
 * clock and is then read as if it were on ours. Metricool answers the analytics
 * endpoints in the BRAND's zone (Europe/Madrid on this account) no matter which
 * timezone the request asked for, and the two consumers of the value disagree unless
 * the offset survives — timeBucket() reads the written hour, everything else parses
 * the instant.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { publishedAtString } from "./insights.ts";
import { timeBucket } from "./rollup.ts";

// 07:21 Madrid (CEST, UTC+2) is 05:21 UTC, which is 00:21 Chicago (CDT, UTC-5).
const MADRID = { dateTime: "2026-08-03T07:21:00", timezone: "Europe/Madrid" };

test("publishedAtString: a Madrid reel is restated on the account's clock, with its offset", () => {
  assert.equal(publishedAtString(MADRID), "2026-08-03T00:21:00-05:00");
});

test("publishedAtString: the PARSED INSTANT is the true one (not the box's zone)", () => {
  assert.equal(Date.parse(publishedAtString(MADRID)!), Date.parse("2026-08-03T05:21:00Z"));
});

test("REGRESSION: a late-night reel no longer reports as a morning one", () => {
  // The old code returned the bare "2026-08-03T07:21:00", whose written hour is 07.
  assert.equal(timeBucket("2026-08-03T07:21:00"), "morning (6-12)"); // what we used to file
  assert.equal(timeBucket(publishedAtString(MADRID)), "night (0-6)"); // what actually happened
});

test("publishedAtString: an evening post is not relabelled as morning either", () => {
  // 2026-07-29 19:16 Chicago went out as 2026-07-30 02:16 Madrid.
  const round = publishedAtString({ dateTime: "2026-07-30T02:16:00", timezone: "Europe/Madrid" });
  assert.equal(round, "2026-07-29T19:16:00-05:00");
  assert.equal(timeBucket(round), "evening (18-24)");
});

test("publishedAtString: a string that already carries an offset lands on the same clock", () => {
  assert.equal(publishedAtString("2026-08-03T05:21:00Z"), "2026-08-03T00:21:00-05:00");
  assert.equal(publishedAtString("2026-08-03T07:21:00+02:00"), "2026-08-03T00:21:00-05:00");
});

test("publishedAtString: an object without a usable dateTime is undefined, never [object Object]", () => {
  assert.equal(publishedAtString({ timezone: "Europe/Madrid" } as any), undefined);
  assert.equal(publishedAtString(null), undefined);
  assert.equal(publishedAtString(undefined), undefined);
  assert.equal(publishedAtString(""), undefined);
  assert.equal(publishedAtString(42 as any), undefined);
});

test("publishedAtString: unparseable input degrades to the raw string, not a crash", () => {
  assert.equal(publishedAtString("not-a-date"), "not-a-date");
});

test("publishedAtString: every network's rows end up on ONE clock", () => {
  // TikTok sends a bare ISO instant, Instagram sends the naive+zone pair. Same moment.
  const ig = publishedAtString({ dateTime: "2026-08-03T07:21:00", timezone: "Europe/Madrid" });
  const tt = publishedAtString("2026-08-03T05:21:00.000Z");
  assert.equal(ig, tt);
});
