/**
 * youtube.test.ts — the YouTube Shorts network, and specifically the five ways adding
 * it could have failed SILENTLY. Each test here corresponds to one of them; if a test
 * looks oddly specific, that is why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlots, LANES, LANE_WIDTH, LANE_GUTTER, laneFor, MIN_GAP_MIN } from "./scheduler.ts";
import { decide, monthlyRecords, budgetForecast, NETWORKS } from "./postingPolicy.ts";
import { buildCreateBody, youtubeTitleFrom, YT_TITLE_MAX } from "./metricool.ts";
import { publishGate } from "./publishGate.ts";
import { RENDER_PLATFORMS } from "./render.ts";
import { CONFIG } from "./config.ts";
import { timesByNetwork } from "./loopPublish.ts";

const dayFrom = Date.UTC(2026, 6, 20, 12, 0, 0); // 7:00am CDT, a full window ahead
const mins = (iso: string): number => Math.round(Date.parse(iso) / 60_000);

// ── TRAP 1: the jitter lane ──────────────────────────────────────────────────

test("LANE: YouTube has a lane of its OWN — it does not inherit Instagram's", () => {
  assert.notEqual(LANES.youtube, LANES.instagram, "youtube must not share instagram's band");
  assert.notEqual(LANES.youtube, LANES.tiktok);
  // The three bands must be DISJOINT with a real gutter, in a stable order.
  const bands = NETWORKS.map((n) => ({ n, lo: LANES[n], hi: LANES[n] + LANE_WIDTH }))
    .sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < bands.length; i++) {
    const gap = bands[i].lo - bands[i - 1].hi;
    assert.ok(
      gap >= LANE_GUTTER - 1e-9,
      `bands ${bands[i - 1].n} and ${bands[i].n} overlap or crowd: gutter ${gap} < ${LANE_GUTTER}`,
    );
  }
  assert.ok(bands.at(-1)!.hi <= 1, "the top band must stay inside the segment");
  assert.ok(bands[0].lo >= 0, "the bottom band must stay inside the segment");
});

test("LANE: an unknown platform THROWS rather than silently sharing a band", () => {
  // The whole trap: a fallback default is how a new network inherits another's slots
  // and publishes seconds away from it all day with everything still green.
  assert.throws(() => laneFor("facebook"), /no jitter lane for platform "facebook"/);
  assert.throws(() => nextSlots(3, { platform: "threads", fromMs: dayFrom }), /no jitter lane/);
  // but the documented no-platform default still works
  assert.equal(laneFor(), LANES.instagram);
  assert.equal(laneFor(""), LANES.instagram);
});

test("LANE: at 12/7 the two networks DRIFT — they never track each other", () => {
  /**
   * MEASURED, not assumed. A jitter lane is a fraction of ONE POST'S SEGMENT, so it
   * only separates two networks whose segment grids ALIGN. At 12/day and 7/day the
   * segments are different sizes (~98min vs ~168min), the grids drift against each
   * other, and an occasional exact-minute coincidence is arithmetic, not a bug: over
   * 84,000 sampled pairs, 0.16% land on the same minute and 0.5% within two.
   *
   * That is a cosmetic coincidence, not a rule violation — the 56-minute floor is
   * per-network and both keep it. What WOULD be a bug is the two networks tracking
   * each other, so this pins the shape of the distribution instead of a single gap:
   * near-misses must stay RARE and the typical separation must stay large.
   */
  let pairs = 0, same = 0, within2 = 0;
  const nearest: number[] = [];
  for (let d = 0; d < 20; d++) {
    for (let k = 0; k < 10; k++) {
      const seed = `drift-${d}-${k}`;
      const from = dayFrom + d * 86_400_000;
      const ig = nextSlots(12, { seed, platform: "instagram", fromMs: from }).map(mins);
      const yt = nextSlots(7, { seed, platform: "youtube", fromMs: from }).map(mins);
      for (const b of yt) {
        let best = Infinity;
        for (const a of ig) {
          const g = Math.abs(a - b);
          pairs++;
          if (g === 0) same++;
          if (g <= 2) within2++;
          best = Math.min(best, g);
        }
        nearest.push(best);
      }
    }
  }
  assert.ok(same / pairs < 0.01, `same-minute pairs ${(same / pairs * 100).toFixed(2)}% should stay under 1%`);
  assert.ok(within2 / pairs < 0.02, `within-2min pairs ${(within2 / pairs * 100).toFixed(2)}% should stay under 2%`);
  // The real anti-tracking check: the MEDIAN YouTube post is far from its nearest
  // Instagram neighbour. If the lanes ever collapsed, this would crash toward zero.
  nearest.sort((a, b) => a - b);
  const median = nearest[Math.floor(nearest.length / 2)];
  assert.ok(median >= 15, `median nearest-neighbour gap ${median}min should stay well clear of zero`);
});

test("LANE: same-count networks stay lane-separated all day (the seconds-apart trap)", () => {
  // With EQUAL counts the two grids align segment-for-segment, which is the case
  // where a shared band would put every pair within seconds. Disjoint lanes make the
  // per-segment separation structural.
  for (const seed of ["a", "b", "c", "d"]) {
    const ig = nextSlots(9, { seed, platform: "instagram", fromMs: dayFrom }).map(mins);
    const yt = nextSlots(9, { seed, platform: "youtube", fromMs: dayFrom }).map(mins);
    for (let i = 0; i < ig.length; i++) {
      assert.ok(
        Math.abs(ig[i] - yt[i]) >= 10,
        `seed ${seed} segment ${i}: IG ${ig[i]} and YouTube ${yt[i]} are ${Math.abs(ig[i] - yt[i])}min apart`,
      );
    }
  }
});

test("LANE: YouTube keeps the 56-minute SAME-platform floor at its own cadence", () => {
  for (const count of [5, 6, 7]) {
    const ms = nextSlots(count, { seed: `yt-${count}`, platform: "youtube", fromMs: dayFrom }).map(mins);
    for (let i = 1; i < ms.length; i++) {
      assert.ok(ms[i] - ms[i - 1] >= MIN_GAP_MIN, `count=${count}: gap ${ms[i] - ms[i - 1]}min < ${MIN_GAP_MIN}`);
    }
  }
});

test("LANE: YouTube slots keep the window + ODD-minute invariants", () => {
  const slots = nextSlots(7, { seed: "yt-inv", platform: "youtube", fromMs: dayFrom });
  assert.equal(slots.length, 7);
  for (let i = 0; i < slots.length; i++) {
    const d = new Date(slots[i]);
    assert.equal(d.getUTCMinutes() % 2, 1, `minute of ${slots[i]} must be ODD`);
    if (i > 0) assert.ok(Date.parse(slots[i]) > Date.parse(slots[i - 1]), "strictly increasing");
  }
});

// ── the budget guard ─────────────────────────────────────────────────────────

test("BUDGET: 12 + 7 is understood as 589/month and fits under the 600 guard", () => {
  const m = monthlyRecords(31);
  assert.equal(m.byNetwork.instagram, 12);
  assert.equal(m.byNetwork.youtube, 7);
  assert.equal(m.byNetwork.tiktok, undefined, "a paused network costs nothing");
  assert.equal(m.perDay, 19);
  assert.equal(m.perMonth, 589);

  const f = budgetForecast(31);
  assert.equal(f.perMonth, 589);
  assert.equal(f.budget, 600);
  assert.ok(f.withinBudget, f.reason);
  // 30-day months too — the point of picking 7 was that it needs no seasonal tweak.
  assert.equal(budgetForecast(30).perMonth, 570);
  assert.ok(budgetForecast(30).withinBudget);
});

test("BUDGET: the 80% alert is still meaningful — 589 is above it, and 8/day is NOT", () => {
  const f = budgetForecast(31);
  // At 98% the alert is the steady state, so it must actually be ON — a guard that
  // never fires at the planned volume is not a guard.
  assert.ok(f.pctOfBudget > CONFIG.MC_MONTHLY_ALERT_AT, `pct ${f.pctOfBudget} should exceed the alert line`);
  assert.ok(f.alerts, "the 80% alert must be lit at the planned steady state");
  // And the line that actually stops us is withinBudget, which 8/day would break.
  assert.equal((12 + 8) * 31, 620);
  assert.ok(620 > CONFIG.MC_MONTHLY_POST_BUDGET, "YouTube at 8/day would breach the guard");
});

test("BUDGET: Instagram is served FIRST when headroom is short", () => {
  // NETWORKS order is load-bearing: the measurable arm must not be the one that starves.
  const d = decide(15);
  assert.equal(d.find((x) => x.network === "instagram")!.slots, 12);
  assert.equal(d.find((x) => x.network === "youtube")!.slots, 3, "YouTube absorbs the shortfall");
  const none = decide(0);
  assert.equal(none.find((x) => x.network === "youtube")!.slots, 0);
});

// ── TRAP 2: madeForKids ──────────────────────────────────────────────────────

test("PAYLOAD: madeForKids is sent EXPLICITLY as false on every YouTube post", () => {
  const body = buildCreateBody({
    text: "bet you get this one wrong\n\n#quiz #fyp",
    mediaUrl: "https://example.com/v.mp4",
    publicationDate: { dateTime: "2026-08-01T12:01:00", timezone: "America/Chicago" },
    networks: ["youtube"],
  }) as any;
  const yt = body.youtubeData;
  assert.ok(yt, "youtubeData must be present for a youtube post");
  // Present AND false — `undefined` would also be falsy, which is exactly the bug.
  assert.ok("madeForKids" in yt, "madeForKids must be present, never omitted to a default");
  assert.equal(yt.madeForKids, false);
  assert.equal(typeof yt.madeForKids, "boolean");
});

test("PAYLOAD: type=short, plus an explicit privacy and category", () => {
  const body = buildCreateBody({
    text: "hello",
    mediaUrl: "https://example.com/v.mp4",
    publicationDate: { dateTime: "2026-08-01T12:01:00", timezone: "America/Chicago" },
    networks: ["youtube"],
  }) as any;
  assert.equal(body.youtubeData.type, "short", "'short' is what puts it in the Shorts shelf");
  assert.ok(body.youtubeData.privacy, "privacy must be explicit (swagger declares no default)");
  assert.ok(body.youtubeData.category, "category must be explicit");
  // the live catalog vocabulary, /v2/scheduler/catalogs/youtube/categories
  assert.match(body.youtubeData.category, /^[A-Z][A-Z_]+$/);
});

test("PAYLOAD: youtubeData appears ONLY on YouTube posts", () => {
  const base = {
    text: "hello",
    mediaUrl: "https://example.com/v.mp4",
    publicationDate: { dateTime: "2026-08-01T12:01:00", timezone: "America/Chicago" },
  };
  const ig = buildCreateBody({ ...base, networks: ["instagram"] }) as any;
  assert.ok(!("youtubeData" in ig), "an Instagram post must not carry youtubeData");
  assert.ok(ig.instagramData);
  const tt = buildCreateBody({ ...base, networks: ["tiktok"] }) as any;
  assert.ok(!("youtubeData" in tt));
});

test("TITLE: within 100 chars, separate from the description, never empty", () => {
  const long = "A".repeat(400);
  assert.ok(youtubeTitleFrom(long).length <= YT_TITLE_MAX);
  assert.equal(YT_TITLE_MAX, 100);

  // the caption's first line, with hashtags and links stripped
  const cap = "only 1 in 10 get this\n\nfull answer below\n#quiz #fyp https://x.co/go/v1";
  assert.equal(youtubeTitleFrom(cap), "only 1 in 10 get this");

  // never empty — YouTube rejects a blank title
  assert.ok(youtubeTitleFrom("").length > 0);
  assert.ok(youtubeTitleFrom("#fyp #quiz").length > 0);

  // cuts on a word boundary rather than mid-word
  const wordy = ("word ".repeat(60)).trim();
  const t = youtubeTitleFrom(wordy);
  assert.ok(t.length <= YT_TITLE_MAX);
  assert.ok(!t.endsWith("wor"), "should cut on a space, not mid-word");

  // and the post text is NOT the title
  const body = buildCreateBody({
    text: cap, mediaUrl: "https://example.com/v.mp4",
    publicationDate: { dateTime: "2026-08-01T12:01:00", timezone: "America/Chicago" },
    networks: ["youtube"],
  }) as any;
  assert.equal(body.text, cap, "text stays the full description");
  assert.notEqual(body.youtubeData.title, cap);
  assert.ok(body.youtubeData.title.length <= YT_TITLE_MAX);
});

// ── TRAP 4: RENDER_PLATFORMS ─────────────────────────────────────────────────

test("RENDER: YouTube is in RENDER_PLATFORMS, and TikTok is still there (paused != removed)", () => {
  assert.ok(RENDER_PLATFORMS.includes("youtube"), "the one array that gated the whole YouTube path");
  assert.ok(RENDER_PLATFORMS.includes("instagram"));
  assert.ok(RENDER_PLATFORMS.includes("tiktok"), "TikTok is paused, not removed — it must still render");
  assert.equal(new Set(RENDER_PLATFORMS).size, RENDER_PLATFORMS.length, "no duplicate renders");
});

// ── TRAP 5: the publish gate's thumbnail requirement ─────────────────────────

const goodQ = [{ kind: "text", prompt: "WHICH IS GREATEST?", options: ["2/3", "5/8"], answer: "2/3" }] as any;
const candidate = (over: Record<string, unknown>) => ({
  id: "v1",
  caption: "bet you get this one wrong",
  questions: goodQ,
  explanations: ["two thirds is the largest, so 2/3 wins"],
  answerLabels: ["2/3"],
  cover_ms: 4200,
  ...over,
});

test("GATE: a missing thumbnail still BLOCKS Instagram", () => {
  const g = publishGate(candidate({ network: "instagram", thumbnail_url: null, cover_url: null }) as any, []);
  assert.equal(g.pass, false);
  assert.match(g.reason, /no explicit videoThumbnailUrl/);
});

test("GATE: an omitted network is treated as Instagram — strictest reading", () => {
  const g = publishGate(candidate({ thumbnail_url: null, cover_url: null }) as any, []);
  assert.equal(g.pass, false, "an un-updated caller must not silently lose the check");
});

test("GATE: a missing thumbnail does NOT block YouTube", () => {
  // Custom Shorts thumbnails need YouTube Partner Programme membership and this
  // channel has zero videos, so videoThumbnailUrl cannot apply. Blocking on it would
  // hold back an entire network for an Instagram-shaped reason.
  const g = publishGate(candidate({ network: "youtube", thumbnail_url: null, cover_url: null, cover_ms: null }) as any, []);
  assert.equal(g.pass, true, g.reason);
});

test("GATE: YouTube is exempt from REQUIRING a thumbnail, not from VALIDATING one", () => {
  // A malformed or expiring url is a bug on every network, honoured or not.
  const bad = publishGate(candidate({ network: "youtube", thumbnail_url: "http://insecure.example/c.jpg" }) as any, []);
  assert.equal(bad.pass, false);
  assert.match(bad.reason, /thumbnail must be https/);

  const presigned = publishGate(
    candidate({ network: "youtube", thumbnail_url: "https://s3.example/c.jpg?X-Amz-Signature=abc" }) as any, [],
  );
  assert.equal(presigned.pass, false);
  assert.match(presigned.reason, /presigned/);
});

test("GATE: every NON-cover check still applies to YouTube", () => {
  // Only the cover rule is network-aware. Text integrity is a property of the video.
  const dup = publishGate(
    candidate({ network: "youtube", thumbnail_url: null, cover_ms: null, caption: "" }) as any, [],
  );
  assert.equal(dup.pass, false);
  assert.match(dup.reason, /empty caption/);

  const mangled = publishGate(
    candidate({
      network: "youtube", thumbnail_url: null, cover_ms: null,
      questions: [{ kind: "text", prompt: "which is the greatest", options: ["2 3", "5 8"], answer: "2 3" }] as any,
      explanations: ["two three is bigger"], answerLabels: ["2 3"],
    }) as any, [],
  );
  assert.equal(mangled.pass, false, "a mangled prompt must fail on YouTube too");
});

// ── plumbing that would fail silently ────────────────────────────────────────

test("PLUMBING: timesByNetwork gives YouTube a bucket (an empty one drops its gap floor)", () => {
  const out = timesByNetwork([]);
  for (const n of NETWORKS) assert.ok(Array.isArray(out[n]), `${n} must have an avoid bucket`);
  const rows = [{
    id: 1, uuid: "u1",
    publicationDate: { dateTime: "2026-08-01T12:01:00", timezone: "America/Chicago" },
    providers: [{ network: "youtube" }],
  }] as any;
  assert.equal(timesByNetwork(rows).youtube.length, 1, "a YouTube row must land in the YouTube bucket");
});

test("PLUMBING: config carries a YouTube account id and policy entry", () => {
  assert.ok(CONFIG.ACCOUNTS.youtube, "annotateDb reads CONFIG.ACCOUNTS[platform]");
  assert.ok(CONFIG.ACCOUNT_IDS.includes(CONFIG.ACCOUNTS.youtube));
  assert.equal(CONFIG.PLATFORM_POLICY.youtube.perDay, 7);
  assert.equal(CONFIG.PLATFORM_POLICY.youtube.paused, false);
  assert.equal(CONFIG.PLATFORM_POLICY.instagram.perDay, 12, "Instagram's volume is protected");
  assert.equal(CONFIG.PLATFORM_POLICY.tiktok.paused, true, "TikTok stays paused");
});
