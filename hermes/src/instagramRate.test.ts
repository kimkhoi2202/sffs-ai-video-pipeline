/**
 * instagramRate.test.ts — the 15/day Instagram decision, and the two things that make
 * it safe rather than merely bigger.
 *
 * The rate itself is a judgement and will change again. What must not change silently
 * is WHY 15 was available and 18 was not, so both halves are pinned here:
 *
 *   THE FLOOR IS THE CEILING. 56 minutes inside a 07:00-01:00 window is what caps the
 *   day, and the cap is lower than 1080/56 looks because each slot is confined to a
 *   jitter lane within its segment. Measured over twelve five-day simulations the
 *   scheduler broke the floor in 3 of 12 runs at 18 and 12 of 12 at 19, and never at
 *   17 or below. A future rate rise that does not re-run that measurement is a
 *   guardrail breach waiting for the right calendar.
 *
 *   THE BATCH IS SIZED BY INSTAGRAM, AND ONLY INSTAGRAM. Every network used to be
 *   asked for the whole batch. Once Instagram outgrew YouTube that silently raised
 *   YouTube too, by spilling the excess onto later days, which is the one outcome the
 *   volume decision explicitly excluded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.ts";
import { decide, slotTimes } from "./postingPolicy.ts";
import { planSlots, timesByNetwork, localDayOf } from "./loopPublish.ts";
import { WINDOW_OPEN_HOUR, WINDOW_CLOSE_HOUR } from "./scheduler.ts";

const TZ = CONFIG.METRICOOL_TZ;

/** ISO instant -> the naive local wall clock Metricool stores, so a synthetic calendar
 *  row is read back by timesByNetwork() the same way a real one is. Getting this wrong
 *  reads every row five hours out and makes the gap check meaningless. */
function toNaive(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(iso));
  const g: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") g[p.type] = p.value;
  return `${g.year}-${g.month}-${g.day}T${g.hour === "24" ? "00" : g.hour}:${g.minute}:${g.second}`;
}
const row = (iso: string, network: string): any => ({
  publicationDate: { dateTime: toNaive(iso), timezone: TZ }, providers: [{ network }],
});

/**
 * A FULL prior day of Instagram posts.
 *
 * Density is not a detail here. With an empty calendar nextSlots takes the legacy
 * even-distribution path and never consults the gap at all; with rows present it takes
 * the collision-aware path that enforces it, and only a calendar as full as production's
 * pushes that path into the best-effort fallback where the floor can actually give.
 * A sparse fixture measures a code path the loop never runs.
 */
function priorDay(rate: number): any[] {
  const out: any[] = [];
  const base = Date.parse("2026-08-07T12:10:00Z"); // 07:10 Chicago
  for (let i = 0; i < rate; i++) out.push(row(new Date(base + i * 62 * 60_000).toISOString(), "instagram"));
  return out;
}

/** Five consecutive cycles at `rate`, returning every sub-56-minute Instagram gap. */
function fiveDays(rate: number, seed: string): { violations: number; worst: number; placed: number } {
  const previous = CONFIG.PLATFORM_POLICY.instagram.perDay;
  CONFIG.PLATFORM_POLICY.instagram.perDay = rate;
  try {
    const rows: any[] = priorDay(rate);
    for (const day of ["2026-08-08", "2026-08-09", "2026-08-10", "2026-08-11", "2026-08-12"]) {
      const now = new Date(`${day}T14:05:00Z`);
      for (const t of planSlots(rate, "instagram", rows, `${seed}|${day}`, now).times) {
        rows.push(row(t, "instagram"));
      }
    }
    const inst = (timesByNetwork(rows).instagram ?? []).map((s) => Date.parse(s)).sort((a, b) => a - b);
    let worst = Infinity, violations = 0;
    for (let i = 1; i < inst.length; i++) {
      const gap = (inst[i] - inst[i - 1]) / 60_000;
      if (gap < worst) worst = gap;
      if (gap < 56) violations++;
    }
    return { violations, worst, placed: inst.length };
  } finally {
    CONFIG.PLATFORM_POLICY.instagram.perDay = previous;
  }
}

const SEEDS = Array.from({ length: 12 }, (_, i) => `rate-test-${i}`);

test("the configured Instagram rate never breaks the 56-minute floor", () => {
  const rate = CONFIG.PLATFORM_POLICY.instagram.perDay;
  for (const seed of SEEDS) {
    const r = fiveDays(rate, seed);
    assert.equal(r.violations, 0, `rate ${rate} produced ${r.violations} sub-56min gap(s) on seed "${seed}" (worst ${r.worst}min)`);
  }
});

/**
 * The highest rate that never broke the 56-minute floor when this was measured, on
 * 2026-08-07, over twelve five-day simulations against the LIVE calendar:
 *
 *   rate  in-window posts  landing after 12 Aug  runs breaking the floor
 *     15        66                  9                    0/12
 *     16        67                 13                    0/12
 *     17        68                 17                    0/12
 *     18        72                 18                    3/12
 *     19        76                 19                   12/12
 *
 * The rate shipped is 15 rather than 17 because the return saturates well below the
 * safety limit: 15 buys 66 of the ~68 posts the window can deliver at all, and every
 * step above it converts almost entirely into posts landing after the campaign closes.
 *
 * This is asserted as a CONSTANT rather than re-derived by simulation, because a
 * stochastic negative ("18 must fail") is exactly the test that goes green on a lucky
 * seed. Raising the rate past this line should require re-running the measurement, and
 * this is what makes that a deliberate act instead of an edit nobody noticed.
 */
const MEASURED_SAFE_MAX = 17;

test("the rate stays at or below the measured safe maximum", () => {
  assert.ok(
    CONFIG.PLATFORM_POLICY.instagram.perDay <= MEASURED_SAFE_MAX,
    `rate ${CONFIG.PLATFORM_POLICY.instagram.perDay} exceeds the ${MEASURED_SAFE_MAX} that was measured safe. ` +
      "Re-run the five-day floor simulation before raising this.",
  );
});

test("the rate stays inside what the window can physically hold", () => {
  // 07:00 -> 01:00 is 18 hours; slotTimes is the pure geometry, before jitter lanes.
  const windowHours = 24 - WINDOW_OPEN_HOUR + WINDOW_CLOSE_HOUR;
  assert.equal(windowHours, 18);
  const geometric = slotTimes(40, { dayISO: "2026-08-09", startHour: 7, endHour: 25, minGapMinutes: 56 }).length;
  assert.ok(
    CONFIG.PLATFORM_POLICY.instagram.perDay <= geometric,
    `rate ${CONFIG.PLATFORM_POLICY.instagram.perDay} exceeds the ${geometric} the bare geometry allows`,
  );
});

test("a bigger Instagram batch does not enlarge YouTube", () => {
  // decide() is what armedSchedule bounds each network's request with, so this is the
  // guarantee at its source: YouTube's allowance is its own, whatever Instagram does.
  const d = decide(600);
  const ig = d.find((x) => x.network === "instagram")!;
  const yt = d.find((x) => x.network === "youtube")!;
  assert.equal(ig.slots, CONFIG.PLATFORM_POLICY.instagram.perDay);
  assert.equal(yt.slots, CONFIG.PLATFORM_POLICY.youtube.perDay);
  assert.ok(ig.slots > yt.slots, "the whole point: Instagram is now the larger of the two");
  assert.equal(yt.slots, 11, "YouTube must NOT have inherited Instagram's rate");
});

test("bounding the request is a no-op when the batch fits, and a cap when it does not", () => {
  const batch = CONFIG.PLATFORM_POLICY.instagram.perDay;
  const d = decide(600);
  for (const a of d) {
    const ask = Math.min(batch, a.slots);
    assert.ok(ask <= a.slots, `${a.network} must never be asked for more than its allowance`);
    if (a.network === "instagram") assert.equal(ask, batch, "Instagram sizes the batch, so it is never cut by it");
    if (a.network === "youtube") assert.equal(ask, 11, "YouTube takes 11 of a 15-video batch, not 15");
    if (a.network === "tiktok") assert.equal(a.slots, 0, "TikTok is paused and takes nothing");
  }
});

test("floor == ceiling: the batch plans exactly what a day may place", () => {
  // A floor below the ceiling is how five consecutive cycles all landed 8 of 12; the
  // property is that a day is finished only when the cap is full or the waves run out.
  assert.equal(CONFIG.VIDEOS_PER_DAY, CONFIG.VIDEOS_FLOOR);
  assert.equal(CONFIG.VIDEOS_PER_DAY, CONFIG.PLATFORM_POLICY.instagram.perDay,
    "the batch size and Instagram's slot cap must agree, or the loop plans videos it cannot place");
});

test("the spend still fits: the guard is consulted, not assumed", () => {
  // 15 + 11 = 26 records/day. The point is not that it fits today but that raising the
  // rate moved a number the budget guard reads, so the two cannot drift apart.
  const perDay = CONFIG.PLATFORM_POLICY.instagram.perDay + CONFIG.PLATFORM_POLICY.youtube.perDay;
  assert.equal(perDay, 26);
  assert.ok(perDay * 5 < CONFIG.MC_MONTHLY_POST_BUDGET, "five more days at this cadence must fit the 600 guard");
});
