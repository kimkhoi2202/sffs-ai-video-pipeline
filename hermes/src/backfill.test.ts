/**
 * backfill.test.ts — the ramped catalogue backfill, and the one way it could quietly
 * double-post.
 *
 * THE COLLISION. The loop is configured for 7 YouTube posts/day of its OWN fresh
 * output. A catalogue backfill running at the same time is not a second budget — both
 * are just YouTube posts on the same calendar day — so if the backfill ADDED to the
 * loop's 7 instead of drawing from it, a ramp day sized for 3 would land 10 and the
 * per-day cap would be breached with nothing in the logs. These tests pin the
 * consume-not-add behaviour, the ramp table, and the re-render retarget that makes a
 * catalogue video legal on YouTube in the first place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { perDayFor, NETWORKS, budgetForecast, monthlyRecords, exhaustionForecast } from "./postingPolicy.ts";
import { planSlots, countOnDay, localDay, timesByNetwork } from "./loopPublish.ts";
import { retargetPropsToYouTube, endKeyForCard, RENDER_PLATFORMS } from "./render.ts";
import { CONFIG } from "./config.ts";
import { isWithinWindow, MIN_GAP_MIN } from "./scheduler.ts";

// July in America/Chicago is CDT. Hardcoded ON PURPOSE: an independent ground truth to
// measure the code under test against, never a value the code under test computed.
const TZ_OFFSET = "-05:00";
const ytRow = (dateTime: string, network = "youtube") =>
  ({ id: 1, uuid: `u-${dateTime}-${network}`, publicationDate: { dateTime, timezone: CONFIG.METRICOOL_TZ }, providers: [{ network }] }) as any;

// ── The ramp table ───────────────────────────────────────────────────────────

test("RAMP: YouTube opened at 3/day and has now climbed out to the full policy cap", () => {
  // The ramp COMPLETED. Its terminal step TRACKS the policy (7 -> 12 on 2026-08-02,
  // 12 -> 11 on 2026-08-03) because perDayFor takes the MINIMUM of the ramp and the
  // policy — a stale terminal silently holds YouTube below its own cap.
  const cap = CONFIG.PLATFORM_POLICY.youtube.perDay;
  const start = CONFIG.YT_RAMP_START;
  assert.equal(perDayFor("youtube", "2026-07-28"), 3, "day 0 = 3/day");
  assert.equal(perDayFor("youtube", "2026-07-29"), 3, "day 1 still 3/day");
  assert.equal(perDayFor("youtube", "2026-07-30"), 5, "+2 days = 5/day");
  assert.equal(perDayFor("youtube", "2026-07-31"), 5, "day 3 still 5/day");
  assert.equal(perDayFor("youtube", "2026-08-01"), cap, "+4 days = the full cap");
  assert.equal(perDayFor("youtube", "2026-08-02"), cap, "and every day after");
  assert.equal(start, "2026-07-28");
});

test("RAMP: it TOPS OUT at the policy cap and never climbs past it", () => {
  for (const d of ["2026-08-01", "2026-08-15", "2026-12-31", "2027-06-01"]) {
    assert.equal(perDayFor("youtube", d), CONFIG.PLATFORM_POLICY.youtube.perDay, `${d} must sit at the real cap`);
  }
  // A ramp table cannot RAISE the cap — the monthly budget is derived from the policy.
  const maxStep = Math.max(...CONFIG.YT_RAMP_STEPS.map((s) => s.perDay));
  assert.ok(maxStep <= CONFIG.PLATFORM_POLICY.youtube.perDay, "no ramp step may exceed the policy perDay");
});

test("RAMP: it applies to YouTube ONLY — Instagram keeps its full cap every single day", () => {
  for (const d of ["2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]) {
    assert.equal(perDayFor("instagram", d), CONFIG.PLATFORM_POLICY.instagram.perDay, `instagram must be untouched on ${d}`);
  }
  assert.equal(perDayFor("tiktok", "2026-07-28"), CONFIG.PLATFORM_POLICY.tiktok.perDay, "tiktok cadence preserved for resume");
});

test("RAMP: it FAILS OPEN to the real cap — a day before the start, or a junk date", () => {
  const cap = CONFIG.PLATFORM_POLICY.youtube.perDay;
  assert.equal(perDayFor("youtube", "2026-07-27"), cap, "before the ramp starts => the real cap, not 0 and not 3");
  assert.equal(perDayFor("youtube", "not-a-date"), cap, "an unparseable day must not strand the network at 3");
  assert.equal(perDayFor("youtube", ""), cap);
});

// ── Consume, do not add ──────────────────────────────────────────────────────

test("COLLISION: backfill posts CONSUME the day's YouTube allowance instead of adding to it", () => {
  const now = new Date("2026-07-28T18:00:00Z");
  const day = localDay(0, now);
  assert.equal(perDayFor("youtube", day), 3, "precondition: today is a 3/day ramp day");
  // Three catalogue posts already placed on today by the backfill.
  const rows = [ytRow(`${day}T09:01:00`), ytRow(`${day}T13:03:00`), ytRow(`${day}T17:05:00`)];
  assert.equal(countOnDay(rows, "youtube", day), 3);
  // The loop now asks for its usual batch. It must get NOTHING on this day.
  const plan = planSlots(12, "youtube", rows, "collision-seed", now);
  const placedToday = plan.spread.find((s) => s.day === day);
  assert.equal(placedToday, undefined, "a ramp day already at its cap must take no loop posts at all");
  for (const t of plan.times) {
    assert.ok(!t.startsWith(day), `nothing may land on the saturated day ${day}, got ${t}`);
  }
});

test("COLLISION: a PARTLY filled ramp day yields exactly the remainder, never the full cap", () => {
  const now = new Date("2026-07-28T13:00:00Z"); // 08:00 CDT, most of the window ahead
  const day = localDay(0, now);
  const rows = [ytRow(`${day}T09:01:00`)]; // 1 of today's 3 used
  const plan = planSlots(12, "youtube", rows, "remainder-seed", now);
  const today = plan.spread.find((s) => s.day === day);
  assert.ok(today, "there should still be room today");
  assert.equal(today.room, 2, "3/day cap minus the 1 already placed");
  assert.equal(today.placed, 2, "and only the remainder may be placed");
});

test("COLLISION: one batch spanning the ramp sees DIFFERENT caps per day (3,3,5,5,7...)", () => {
  const now = new Date("2026-07-28T12:30:00Z"); // 07:30 CDT day 0
  const plan = planSlots(40, "youtube", [], "spread-seed", now);
  const byDay = new Map(plan.spread.map((s) => [s.day, s]));
  // The first two ramp days are clean (nothing spills INTO day 0), so their room is
  // exactly the ramp step.
  assert.equal(byDay.get("2026-07-28").room, 3);
  assert.equal(byDay.get("2026-07-29").room, 3);
  assert.equal(byDay.get("2026-07-30").room, 5);
  // Later days are the ramp step MINUS whatever the previous window spilled past
  // midnight onto them — never more than the step.
  for (const s of plan.spread) {
    const cap = perDayFor("youtube", s.day);
    assert.ok(s.room <= cap, `${s.day}: room ${s.room} must not exceed its ramp cap ${cap}`);
    assert.ok(s.placed <= s.room, `${s.day}: placed ${s.placed} must not exceed room ${s.room}`);
  }
  // Reading one fixed perDay for the whole horizon is the bug this guards.
  assert.ok(new Set(plan.spread.map((s) => perDayFor("youtube", s.day))).size > 1, "the horizon must not use a single cap");
});

test("COLLISION: an INSTAGRAM batch is completely unaffected by the YouTube ramp", () => {
  const now = new Date("2026-07-28T12:30:00Z");
  const cap = CONFIG.PLATFORM_POLICY.instagram.perDay;
  const plan = planSlots(cap, "instagram", [], "ig-seed", now);
  const first = plan.spread[0];
  assert.equal(first.room, cap, "instagram keeps its own cap on a YouTube ramp day");
});

// ── The scheduled posts themselves ───────────────────────────────────────────

test("SLOTS: every ramp-day YouTube slot is in-window, odd-minute and 56 min apart", () => {
  const now = new Date("2026-07-28T12:30:00Z");
  const plan = planSlots(20, "youtube", [], "invariants-seed", now);
  assert.ok(plan.times.length >= 15, `expected the ramp to place a real batch, got ${plan.times.length}`);
  const perDay = new Map<string, number[]>();
  for (const iso of plan.times) {
    const d = new Date(iso);
    assert.ok(isWithinWindow(d), `${iso} must be inside 7:00am-3:00am America/Chicago`);
    const mm = Number(new Intl.DateTimeFormat("en-US", { timeZone: CONFIG.METRICOOL_TZ, minute: "2-digit", hourCycle: "h23" }).format(d));
    assert.equal(mm % 2, 1, `${iso} must land on an ODD minute`);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.METRICOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    perDay.set(key, [...(perDay.get(key) ?? []), Math.round(d.getTime() / 60_000)]);
  }
  for (const [day, mins] of perDay) {
    const sorted = [...mins].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] - sorted[i - 1] >= MIN_GAP_MIN, `same-platform gap on ${day} must be >= ${MIN_GAP_MIN} min`);
    }
  }
});

test("SLOTS: a new batch keeps its distance from catalogue posts ALREADY on the calendar", () => {
  const now = new Date("2026-07-28T12:30:00Z");
  const existing = ["2026-07-30T09:01:00", "2026-07-30T14:03:00"];
  const rows = existing.map((t) => ytRow(t));
  const plan = planSlots(12, "youtube", rows, "avoid-seed", now);
  const existingMins = existing.map((t) => Math.round(Date.parse(`${t}${TZ_OFFSET}`) / 60_000));
  for (const iso of plan.times) {
    const m = Math.round(Date.parse(iso) / 60_000);
    for (const e of existingMins) {
      assert.ok(Math.abs(m - e) >= MIN_GAP_MIN, `${iso} lands inside the 56-min floor of an existing post`);
    }
  }
});

// ── Budget ───────────────────────────────────────────────────────────────────

test("BUDGET: the ramp never RAISES the monthly bill — it is costed at the terminal rate", () => {
  const cap = CONFIG.PLATFORM_POLICY.youtube.perDay;
  assert.equal(monthlyRecords(31).byNetwork.youtube, cap, "the forecast must assume the steady state, not the ramp");
  // Every ramp day spends at most the terminal rate, so the forecast is an upper bound.
  for (const s of CONFIG.YT_RAMP_STEPS) assert.ok(s.perDay <= cap, `ramp step ${s.perDay} must not exceed the cap ${cap}`);
  assert.equal(CONFIG.YT_RAMP_STEPS.at(-1)!.perDay, cap, "the terminal step must converge on the real cap");
});

test("BUDGET: 26/day is a SPRINT — it does not fit a full month, and does fit the WINDOW", () => {
  // A fan-out costs one record PER NETWORK, so the bill is the sum over LIVE networks.
  // TikTok paused on 2026-08-07 and therefore contributes nothing: 11 + 11 = 22/day,
  // down from 33. Stated as arithmetic rather than left as a comment, so a future
  // volume change — in either direction — has to confront it.
  const m = monthlyRecords(31);
  assert.equal(m.perDay, 26, "instagram 15 + youtube 11; tiktok is paused and costs nothing");
  assert.equal(m.perMonth, 806);
  assert.equal(m.byNetwork.tiktok, undefined, "a paused network is ABSENT, not present with a zero");

  const full = budgetForecast(31);
  assert.equal(full.withinBudget, false, "a full month at this cadence STILL does not fit the 600 guard");
  assert.match(full.reason, /OVER BUDGET/);

  // The horizon that actually matters: what is left of the campaign.
  const sprint = budgetForecast(14);
  assert.equal(sprint.perMonth, 364);
  assert.ok(sprint.withinBudget, sprint.reason);
});

test("BUDGET: 11/network is the number that buys the WHOLE window; 12 runs out inside it", () => {
  // This is the reason the cadence came down on 2026-08-03. Twelve fits the MONTH and
  // misses the WINDOW, and the days it misses are the last ones — the ones the target is
  // judged on. The window closes 2026-08-17, fourteen days of posting from 2026-08-03.
  //
  // Two live readings taken ninety minutes apart, because the counter moves while you
  // read it: published/committed shift as scheduled rows publish, but their SUM barely
  // does, so the verdict holds across both rather than resting on one lucky snapshot.
  const today = "2026-08-03";
  for (const [used, committed] of [[55, 82], [57, 58]] as const) {
    const at12 = exhaustionForecast(used, committed, 36, today);
    const at11 = exhaustionForecast(used, committed, 33, today);
    assert.ok(at12.daysLeft < 14, `12/network strands the end of the window (${at12.exhaustsOn})`);
    assert.ok(at11.daysLeft >= 14, `11/network must reach 2026-08-17, got ${at11.exhaustsOn}`);
  }

  // And it is the LIVE policy that produces the number, not one typed into this test.
  // 26: the TikTok pause removed 11/day and the Instagram rise added 4 back. The pause
  // is what made the rise affordable rather than the other way round.
  assert.equal(monthlyRecords().perDay, 26);

  // WHAT EATS THE MARGIN. 33 x 14 = 462 records, against 485 of headroom on the later
  // reading — 23 spare. The committed side already includes 18 records of a rebus
  // campaign this loop did not create and does not control; if that campaign is extended
  // past 2026-08-09 at its current ~4/day, the slack is gone and this number has to come
  // down again. The guard fails closed at 600, well under the 700 hard cap, so the
  // failure mode is "the loop stops scheduling", never a Fair Use breach and a manual
  // account review — which is what makes a margin this thin acceptable at all.
  assert.ok(485 - 33 * 14 > 0);
  // AND WHAT PAUSING TIKTOK BOUGHT. Even after spending part of it on Instagram, 26/day
  // leaves 485 - 364 = 121 records of slack against the 23 that 33/day left. The record
  // budget is no longer what limits volume; the 56-minute floor is.
  assert.ok(485 - 26 * 14 > 100);
  assert.ok(CONFIG.MC_MONTHLY_POST_BUDGET < CONFIG.MC_MONTHLY_HARD_CAP);
});

// ── The re-render retarget ───────────────────────────────────────────────────

const sidecar = (over: Record<string, unknown> = {}) => ({
  slug: "", platform: "instagram", questionIds: [0, 1, 2], questions: [], qrBase: "audio/hermes-vo/x/",
  metaBase: "audio/narration/", music: "gameshow-fanfare.mp3", readVO: "full",
  dropReveal: false, dropScore: false, endCard: "default", totalFrames: 2372,
  durs: { q0: 1, q1: 1, q2: 1, r0: 1, r1: 1, r2: 1, timesup: 1.2, score: 20.8, "outro-follow": 4.049 },
  ...over,
});

test("RETARGET: the end BEAT switches to outro-youtube and the length grows to match", () => {
  const { props, endKey, frameDelta } = retargetPropsToYouTube(sidecar());
  assert.equal(props.platform, "youtube", "the safe-box transform is driven off this");
  assert.equal(endKey, "outro-youtube");
  assert.ok(frameDelta > 0, "outro-youtube is longer than outro-follow");
  assert.equal(props.totalFrames, 2372 + frameDelta);
  // The delta is the point: it is POSITIVE (so carrying the old length over truncates
  // the CTA) and SMALLER than gateRenderSanity's 1.5s / 45-frame tolerance (so that
  // truncation would ship silently). Asserted as a band rather than an exact frame
  // count, because the exact count is a function of the two clips' measured lengths and
  // regenerating the outro VO legitimately moves it.
  assert.ok(frameDelta < 45, `a delta the sanity gate would catch is a different bug (${frameDelta} frames)`);
  assert.ok(props.durs["outro-youtube"] > 0, "the new beat must be measured, not assumed");
});

test("RETARGET: the no-answer end card gets YouTube's OWN clip; only verdict is shared", () => {
  // The no-answer line sends people to the site, and the pointer to it does not travel:
  // "link in our bio" on IG/TikTok, "link in the description" on YouTube. So it is two
  // clips now and the length has to be re-measured, exactly like the default end card.
  const na = retargetPropsToYouTube(
    sidecar({ endCard: "noanswer", dropReveal: "last", dropScore: true, totalFrames: 1798, durs: { "outro-noanswer": 5.0 } }),
  );
  assert.equal(na.endKey, "outro-noanswer-youtube");
  assert.ok(na.props.durs["outro-noanswer-youtube"] > 0, "the new beat must be measured, not assumed");
  assert.equal(na.props.totalFrames, 1798 + na.frameDelta);
  assert.equal(na.props.platform, "youtube", "and it is still laid out for the Shorts safe box");

  // The verdict card carries no platform pointer, so it is still one clip everywhere.
  const v = retargetPropsToYouTube(
    sidecar({ endCard: "verdict", dropReveal: "last", dropScore: true, totalFrames: 1798, durs: { verdict: 4.0 } }),
  );
  assert.equal(v.frameDelta, 0, "verdict resolves to the same beat on every platform");
  assert.equal(v.props.totalFrames, 1798, "so the stored length carries through untouched");
  assert.equal(v.props.platform, "youtube", "but it is still laid out for the Shorts safe box");
});

test("RETARGET: it never mutates the stored sidecar", () => {
  const sp = sidecar();
  const before = JSON.stringify(sp);
  retargetPropsToYouTube(sp);
  assert.equal(JSON.stringify(sp), before, "the on-disk props must survive a retarget unchanged");
});

test("RETARGET: it REFUSES rather than guessing when the old end beat has no duration", () => {
  assert.throws(
    () => retargetPropsToYouTube(sidecar({ durs: { q0: 1 } })),
    /no duration for its own end beat/,
    "a missing beat must fail loudly, not silently produce a truncated composition",
  );
  assert.throws(() => retargetPropsToYouTube(null as any), /no props/);
});

test("RETARGET: endKeyForCard mirrors the Remotion timeline's endCardKey", () => {
  assert.equal(endKeyForCard("default", "youtube"), "outro-youtube");
  assert.equal(endKeyForCard("default", "instagram"), "outro-follow");
  assert.equal(endKeyForCard("default", "tiktok"), "outro-follow");
  assert.equal(endKeyForCard("noanswer", "youtube"), "outro-noanswer-youtube");
  assert.equal(endKeyForCard("noanswer", "instagram"), "outro-noanswer");
  assert.equal(endKeyForCard("noanswer", "tiktok"), "outro-noanswer");
  assert.equal(endKeyForCard("verdict", "youtube"), "verdict");
  assert.equal(endKeyForCard(undefined, "youtube"), "outro-youtube", "undefined defaults to the platform outro");
});

test("RETARGET: youtube is a real render platform, so the SUBSCRIBE CTA path is reachable", () => {
  assert.ok(RENDER_PLATFORMS.includes("youtube"));
  assert.ok(NETWORKS.includes("youtube"));
});

// ── The Shorts-shape verifier ────────────────────────────────────────────────
//
// Real files, made on the fly: YouTube classifies from the FILE, so a verifier that
// only ever saw a mocked probe would not be evidence of anything.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyShortForYouTube } from "./render.ts";

const mk = (dir: string, name: string, size: string, secs: number, audio: boolean): string => {
  const out = join(dir, name);
  const args = ["-v", "error", "-f", "lavfi", "-i", `color=c=green:s=${size}:d=${secs}:r=30`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push("-y", out);
  execFileSync("ffmpeg", args, { stdio: "ignore" });
  return out;
};

test("SHORTS-CHECK: a portrait clip with audio, under the ceiling, passes", () => {
  const dir = mkdtempSync(join(tmpdir(), "sffs-short-"));
  try {
    const r = verifyShortForYouTube(mk(dir, "ok.mp4", "1080x1920", 2, true));
    assert.equal(r.ok, true, r.problems.join("; "));
    assert.equal(r.width, 1080);
    assert.equal(r.height, 1920);
    assert.equal(r.hasAudio, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SHORTS-CHECK: LANDSCAPE is rejected — YouTube would file it as a normal video", () => {
  const dir = mkdtempSync(join(tmpdir(), "sffs-short-"));
  try {
    const r = verifyShortForYouTube(mk(dir, "wide.mp4", "1920x1080", 2, true));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(" "), /landscape/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SHORTS-CHECK: a SILENT render is rejected — that is what a broken VO path produces", () => {
  const dir = mkdtempSync(join(tmpdir(), "sffs-short-"));
  try {
    const r = verifyShortForYouTube(mk(dir, "mute.mp4", "1080x1920", 2, false));
    assert.equal(r.ok, false);
    assert.equal(r.hasAudio, false);
    assert.match(r.problems.join(" "), /no audio/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SHORTS-CHECK: the ceiling is the CONFIG one (170s), not the nominal 180", () => {
  assert.equal(CONFIG.YOUTUBE.maxDurationSeconds, 170);
  assert.ok(CONFIG.YOUTUBE.maxDurationSeconds < 180, "margin for YouTube lengthening a video in processing");
});

test("SHORTS-CHECK: the YouTube post body states privacy + madeForKids explicitly", async () => {
  const { buildCreateBody } = await import("./metricool.ts");
  const body: any = buildCreateBody({
    text: "hello\n\n#a", mediaUrl: "https://x/y.mp4", networks: ["youtube"],
    publicationDate: { dateTime: "2026-07-28T19:01:00", timezone: "America/Chicago" },
  });
  assert.ok(body.youtubeData, "a youtube post must carry youtubeData");
  assert.equal(body.youtubeData.madeForKids, false, "COPPA self-declaration must be explicit");
  assert.equal(body.youtubeData.privacy, CONFIG.YOUTUBE.privacy);
  assert.equal(body.youtubeData.type, "short");
  assert.ok(Object.prototype.hasOwnProperty.call(body.youtubeData, "privacy"), "privacy must be SENT, not omitted");
  assert.ok(String(body.youtubeData.title).length <= 100);
});

// ── Calendar-date accounting ─────────────────────────────────────────────────
//
// A posting window runs 07:00 -> 03:00 the NEXT DAY, so a slot generated while filling
// Tuesday can carry a Wednesday date — and countOnDay() reads the calendar date off the
// stored string. If planSlots charges those to the day it THINKS it is filling, the next
// iteration cannot see them and fills the same date all over again.

import { localDayOf } from "./loopPublish.ts";

const dateOf = (iso: string) => localDayOf(iso);

test("CALENDAR: no CALENDAR DATE ever exceeds its ramp cap, however the windows fall", () => {
  const now = new Date("2026-07-28T12:30:00Z");
  const plan = planSlots(40, "youtube", [], "calendar-seed", now);
  const perDate = new Map<string, number>();
  for (const iso of plan.times) {
    const d = dateOf(iso);
    perDate.set(d, (perDate.get(d) ?? 0) + 1);
  }
  for (const [d, n] of perDate) {
    assert.ok(n <= perDayFor("youtube", d), `${d} got ${n} posts against a cap of ${perDayFor("youtube", d)}`);
  }
  // And the after-midnight slots that make this non-trivial must actually exist.
  const afterMidnight = plan.times.filter((iso) => {
    const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: CONFIG.METRICOOL_TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso)));
    return h < 3;
  });
  assert.ok(afterMidnight.length > 0, "the 07:00->03:00 window must be producing post-midnight slots for this test to mean anything");
});

test("CALENDAR: a date already at its cap from EXISTING rows takes nothing new", () => {
  const now = new Date("2026-07-28T12:30:00Z");
  // Fill 2026-07-30 (cap 5) completely with pre-existing posts.
  const rows = ["09:01", "11:03", "13:05", "15:07", "17:09"].map((t) => ytRow(`2026-07-30T${t}:00`));
  const plan = planSlots(40, "youtube", rows, "full-date-seed", now);
  const on30 = plan.times.filter((iso) => dateOf(iso) === "2026-07-30");
  assert.equal(on30.length, 0, "a saturated calendar date must take nothing, including window spill-over");
});

test("CALENDAR: localDayOf agrees with the date countOnDay matches on", () => {
  const rows = [ytRow("2026-07-30T00:45:00")];
  assert.equal(countOnDay(rows, "youtube", "2026-07-30"), 1);
  const iso = new Date("2026-07-30T05:45:00Z").toISOString(); // 00:45 CDT on the 30th
  assert.equal(localDayOf(iso), "2026-07-30");
});


// ── The 56-minute floor ACROSS independently-created batches ─────────────────
//
// There was already a cross-batch test and it passed the whole time the floor was
// broken, because of WHAT IT FED IN. scheduler.test.ts hands nextSlots the ISO instants
// a previous nextSlots call returned — the two batches speak the same units, so the
// floor holds trivially. A REAL second batch never gets ISO instants. It gets rows back
// from Metricool carrying NAIVE LOCAL time, and something has to convert those before
// the floor can be measured against them. That conversion was an hour out (it probed the
// HOST's zone for DST, and the box runs UTC), which put every existing post 60 minutes
// late in the avoid list. 60 > 56, so a colliding slot measured as clear — one-sidedly,
// for anything placed EARLIER than an existing post.
//
// It shipped two YouTube posts 10 minutes apart on 2026-07-30 — 17:31 from the loop,
// 17:41 from the catalogue backfill — with every test green.
//
// So these go in through the ROW shape, and measure against TZ_OFFSET, an independent
// constant, never against a value the code under test produced.

test("CROSS-BATCH: naive->instant follows the DATE's DST, not the host's clock", () => {
  // The killer property, and it fails on ANY host: January in Chicago is CST (-06:00)
  // and July is CDT (-05:00). Anything that resolves ONE offset for the whole process —
  // a constant, or a probe of the runner's own zone — must get one of these two wrong,
  // whatever TZ the test happens to run under.
  const jan = timesByNetwork([ytRow("2026-01-15T12:00:00")]).youtube[0];
  const jul = timesByNetwork([ytRow("2026-07-15T12:00:00")]).youtube[0];
  assert.equal(jan, "2026-01-15T18:00:00.000Z", "noon on a January day in Chicago is 18:00Z (CST)");
  assert.equal(jul, "2026-07-15T17:00:00.000Z", "noon on a July day in Chicago is 17:00Z (CDT)");
  assert.notEqual(
    Date.parse(jan) - Date.UTC(2026, 0, 15, 12),
    Date.parse(jul) - Date.UTC(2026, 6, 15, 12),
    "a single fixed offset for both dates is exactly the bug",
  );
});

test("CROSS-BATCH: a board row converts to its TRUE instant, to the minute", () => {
  // The specific row the loop planned on top of.
  const [iso] = timesByNetwork([ytRow("2026-07-30T17:41:00")]).youtube;
  assert.equal(iso, new Date(Date.parse(`2026-07-30T17:41:00${TZ_OFFSET}`)).toISOString());
});

test("CROSS-BATCH: the live 2026-07-30 YouTube collision does not reproduce", () => {
  // The board exactly as Metricool returned it that morning: four catalogue-backfill
  // posts on the 30th (ramp cap 5, so room for one more) and the loop asking for it.
  // Swept over seeds because the offending slot is seed-chosen — one seed proves
  // nothing, and the failure it is guarding is a SILENT one.
  const now = new Date("2026-07-30T13:00:00Z"); // 08:00 CDT on the day itself
  const backfill = ["2026-07-30T10:03:00", "2026-07-30T14:07:00", "2026-07-30T17:41:00", "2026-07-30T21:37:00"];
  const rows = backfill.map((t) => ytRow(t));
  const truth = backfill.map((t) => Date.parse(`${t}${TZ_OFFSET}`));
  for (let i = 0; i < 60; i++) {
    const plan = planSlots(1, "youtube", rows, `live-collision-${i}`, now);
    for (const iso of plan.times) {
      const m = Date.parse(iso);
      for (let k = 0; k < truth.length; k++) {
        const gap = Math.abs(m - truth[k]) / 60_000;
        assert.ok(
          gap >= MIN_GAP_MIN,
          `seed ${i}: new slot ${iso} is ${gap.toFixed(0)}min from the backfill post at ${backfill[k]} (floor ${MIN_GAP_MIN})`,
        );
      }
    }
  }
});

test("CROSS-BATCH: an independently-created batch never lands inside the floor of the board", () => {
  // Generic form of the same thing, with room to spare so a saturated window cannot be
  // mistaken for a floor breach: Instagram's cap is 12 and the board holds 5.
  const now = new Date("2026-07-30T13:00:00Z");
  const onBoard = ["2026-07-30T08:49:00", "2026-07-30T11:29:00", "2026-07-30T14:31:00", "2026-07-30T17:57:00", "2026-07-30T21:09:00"];
  const rows = onBoard.map((t) => ytRow(t, "instagram"));
  const truth = onBoard.map((t) => Date.parse(`${t}${TZ_OFFSET}`));
  for (let i = 0; i < 30; i++) {
    const plan = planSlots(3, "instagram", rows, `cross-batch-${i}`, now);
    assert.ok(plan.times.length > 0, `seed ${i} placed nothing`);
    for (const iso of plan.times) {
      const m = Date.parse(iso);
      for (let k = 0; k < truth.length; k++) {
        const gap = Math.abs(m - truth[k]) / 60_000;
        assert.ok(gap >= MIN_GAP_MIN, `seed ${i}: ${iso} is ${gap.toFixed(0)}min from board post ${onBoard[k]}`);
      }
    }
    // and the COMBINED calendar — board plus the new batch — has no pair inside the floor
    const all = [...truth, ...plan.times.map((t) => Date.parse(t))].sort((a, b) => a - b);
    for (let k = 1; k < all.length; k++) {
      assert.ok(
        (all[k] - all[k - 1]) / 60_000 >= MIN_GAP_MIN,
        `seed ${i}: combined schedule has a ${((all[k] - all[k - 1]) / 60_000).toFixed(0)}min gap`,
      );
    }
  }
});

test("CROSS-BATCH: the floor survives a batch planned from the OTHER side of a DST flip", () => {
  // A November board read in July (or the reverse) is where a process-wide offset does
  // its worst. The floor must hold on a date whose offset differs from today's.
  const now = new Date("2026-10-30T13:00:00Z");
  const onBoard = ["2026-11-05T09:01:00", "2026-11-05T13:03:00", "2026-11-05T17:05:00"];
  const rows = onBoard.map((t) => ytRow(t));
  const truth = onBoard.map((t) => Date.parse(`${t}-06:00`)); // November = CST
  for (let i = 0; i < 30; i++) {
    for (const iso of planSlots(2, "youtube", rows, `dst-flip-${i}`, now).times) {
      const m = Date.parse(iso);
      for (let k = 0; k < truth.length; k++) {
        const gap = Math.abs(m - truth[k]) / 60_000;
        assert.ok(gap >= MIN_GAP_MIN, `seed ${i}: ${iso} is ${gap.toFixed(0)}min from ${onBoard[k]} (CST)`);
      }
    }
  }
});
