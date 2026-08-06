/**
 * scheduler.test.ts — proves the post-kickoff scheduling policy: every slot lands
 * in the 7:00am–1:00am America/Chicago window (NOTHING 1–7am), minutes are odd +
 * jittered, gaps are irregular, slots are distinct + increasing, and IG != TikTok.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlots, isWithinWindow, chicagoHour, MIN_GAP_MIN, WINDOW_OPEN_HOUR, WINDOW_CLOSE_HOUR, isoInZone } from "./scheduler.ts";

const dayFrom = Date.UTC(2026, 6, 20, 12, 0, 0); // fixed base (July 2026 = CDT)

test("every slot is inside the window — NOTHING between 1:00am and 7:00am CST", () => {
  // Asking for 60 is a window-containment stress, not an operating count. It now comes
  // back SHORT on purpose: 60 posts cannot sit in an 18-hour window at a 56-minute
  // floor, and the scheduler returns fewer rather than cramming them. What must hold is
  // that every slot it DOES return is inside the window and clears the floor.
  const slots = nextSlots(60, { seed: "run-x", platform: "instagram", fromMs: dayFrom });
  assert.ok(slots.length > 0 && slots.length <= 60, `got ${slots.length}`);
  assert.ok(
    slots.length <= Math.floor((24 - WINDOW_OPEN_HOUR + WINDOW_CLOSE_HOUR) * 60 / MIN_GAP_MIN) + 1,
    `${slots.length} slots cannot fit the window at a ${MIN_GAP_MIN}min floor`,
  );
  for (let i = 1; i < slots.length; i++) {
    const gap = (Date.parse(slots[i]) - Date.parse(slots[i - 1])) / 60_000;
    assert.ok(gap >= MIN_GAP_MIN, `gap ${gap}min < ${MIN_GAP_MIN}min`);
  }
  for (const iso of slots) {
    const d = new Date(iso);
    const h = chicagoHour(d);
    assert.ok(h < 1 || h >= 7, `slot ${iso} -> Chicago hour ${h} must be <1 or >=7 (never 1..6)`);
    assert.ok(isWithinWindow(d), `${iso} within window`);
  }
});

// ── the 7am–1am window (pulled back in from 7am–3am) ─────────────────────────

test("window boundaries: 00:59 is postable, 01:00 and 06:59 are not, 07:00 is", () => {
  const at = (h: number, mi: number): Date => {
    // walk from a known CDT noon to the requested Chicago wall-clock hour
    let ms = dayFrom;
    for (let i = 0; i < 24 * 60; i++, ms += 60_000) {
      const d = new Date(ms);
      if (chicagoHour(d) === h && d.getUTCMinutes() === mi) return d;
    }
    throw new Error(`could not construct ${h}:${mi} Chicago`);
  };
  assert.equal(WINDOW_OPEN_HOUR, 7);
  assert.equal(WINDOW_CLOSE_HOUR, 1);
  assert.ok(isWithinWindow(at(0, 59)), "00:59 is the tail of the window");
  assert.ok(!isWithinWindow(at(1, 0)), "01:00 is the close (exclusive)");
  assert.ok(!isWithinWindow(at(2, 0)), "02:00 is a dead hour again");
  assert.ok(!isWithinWindow(at(6, 59)), "06:59 is still a dead hour");
  assert.ok(isWithinWindow(at(7, 0)), "07:00 opens the window");
});

// THE 1am-3am TAIL IS GONE ON PURPOSE. It was added to buy room for a 12/day grid
// and it bought it in the emptiest hours on the clock: real posts landed at 1:00,
// 2:00 and 2:39am Chicago. The cap is 11 and the 18h window holds 11 at the 56-minute
// floor with room to spare, so the tail was spending slots for nothing.
test("nothing lands in the retired 1am-3am tail", () => {
  const slots = nextSlots(11, { seed: "tail", platform: "tiktok", fromMs: dayFrom });
  const hours = slots.map((s) => chicagoHour(new Date(s)));
  assert.ok(
    !hours.some((h) => h === 1 || h === 2),
    `expected NO slot in the retired 1am-3am tail, got hours ${hours.join(",")}`,
  );
});

test("a full daily batch keeps >= MIN_GAP_MIN between same-platform posts", () => {
  // The 56-min invariant must hold for the real operating range (<= the 11/day cap)
  // on the plain even-distribution path, not only when `avoid` is supplied.
  for (const count of [8, 10, 11]) {
    const ms = nextSlots(count, { seed: `cap-${count}`, platform: "instagram", fromMs: dayFrom }).map((s) => Date.parse(s));
    for (let i = 1; i < ms.length; i++) {
      const gap = (ms[i] - ms[i - 1]) / 60_000;
      assert.ok(gap >= MIN_GAP_MIN, `count=${count}: gap ${gap}min < ${MIN_GAP_MIN}min`);
    }
  }
});

test("a SMALL batch lands in the EARLY window, never at the tail", () => {
  // The 2026-07-25 regression: 9 of 10 videos died at a gate and the lone survivor
  // kept its PLANNED index-9 slot, landing at 11:39pm. cycle.ts now sizes the grid
  // to the SURVIVOR count, so a 1-video day is a 1-slot grid — which must sit in the
  // daytime part of the window, not where the 10th of ten would have gone.
  const tenth = nextSlots(10, { seed: "small", platform: "instagram", fromMs: dayFrom }).at(-1)!;
  for (const seed of ["small", "s2", "s3", "s4", "s5", "s6"]) {
    const [only] = nextSlots(1, { seed, platform: "instagram", fromMs: dayFrom });
    assert.ok(Date.parse(only) < Date.parse(tenth), `1-video slot ${only} must precede the 10-of-10 slot ${tenth}`);
    const h = chicagoHour(new Date(only));
    assert.ok(h >= WINDOW_OPEN_HOUR && h <= 18, `1-video slot ${only} -> hour ${h} should be daytime, not the tail`);
  }
});

test("slots are distinct + strictly increasing, minutes are ODD (natural jitter)", () => {
  const slots = nextSlots(40, { seed: "run-y", platform: "tiktok", fromMs: dayFrom });
  const set = new Set(slots);
  assert.equal(set.size, slots.length, "all distinct");
  for (let i = 1; i < slots.length; i++) {
    assert.ok(Date.parse(slots[i]) > Date.parse(slots[i - 1]), "strictly increasing");
  }
  for (const iso of slots) {
    const min = new Date(iso).getUTCMinutes();
    assert.equal(min % 2, 1, `minute ${min} of ${iso} should be odd (no :00/:30 clockwork)`);
  }
});

test("gaps are IRREGULAR (not a fixed cadence)", () => {
  const slots = nextSlots(12, { seed: "run-z", platform: "instagram", fromMs: dayFrom }).map((s) => Date.parse(s));
  const gaps = slots.slice(1).map((t, i) => t - slots[i]);
  const uniqueGaps = new Set(gaps.map((g) => Math.round(g / 60000)));
  assert.ok(uniqueGaps.size >= 4, `expected varied gaps, got ${[...uniqueGaps].join(",")}`);
});

test("IG and TikTok never share an identical timestamp", () => {
  const ig = new Set(nextSlots(30, { seed: "same-run", platform: "instagram", fromMs: dayFrom }));
  const tt = nextSlots(30, { seed: "same-run", platform: "tiktok", fromMs: dayFrom });
  for (const t of tt) assert.ok(!ig.has(t), `TikTok slot ${t} collides with an IG slot`);
});

test("a base time in the dead hours is pushed into the window", () => {
  // find a UTC instant that is ~5am in Chicago (mid dead-hours under 7am-3am)
  let ms = dayFrom;
  for (let i = 0; i < 48; i++) {
    if (chicagoHour(new Date(ms)) === 5) break;
    ms += 30 * 60000;
  }
  assert.equal(chicagoHour(new Date(ms)), 5, "constructed a 5am-Chicago base");
  const [first] = nextSlots(1, { seed: "dead", platform: "instagram", fromMs: ms });
  assert.ok(isWithinWindow(new Date(first)), `${first} pushed into window from dead hours`);
});

// ── collision-awareness vs ALREADY-scheduled posts (the durable fix for the
//    two-TikTok-posts-2-min-apart bug) ────────────────────────────────────────
const gapMs = MIN_GAP_MIN * 60_000;

test("a NEW batch keeps >= MIN_GAP_MIN from ALREADY-scheduled same-platform posts", () => {
  // Reproduce tonight's bug: an earlier ARMED cycle already scheduled TikTok posts;
  // a later REPLICATION batch (different seed) must NOT land within 56 min of them —
  // the collision that put a 10:13pm TikTok two minutes from an existing 10:15pm.
  const base = Date.UTC(2026, 6, 23, 14, 0, 0); // ~9am CDT: a full window ahead
  const existing = nextSlots(4, { seed: "armed-cycle", platform: "tiktok", fromMs: base });
  const batch = nextSlots(4, { seed: "frx-replication", platform: "tiktok", fromMs: base, avoid: existing });
  assert.equal(batch.length, 4);
  for (const s of batch) {
    for (const e of existing) {
      assert.ok(
        Math.abs(Date.parse(s) - Date.parse(e)) >= gapMs,
        `new slot ${s} is < ${MIN_GAP_MIN}min from already-scheduled ${e}`,
      );
    }
  }
  // and the COMBINED same-platform schedule has NO two posts < MIN_GAP_MIN apart
  const all = [...existing, ...batch].map((s) => Date.parse(s)).sort((a, b) => a - b);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i] - all[i - 1] >= gapMs, `combined gap ${(all[i] - all[i - 1]) / 60000}min < ${MIN_GAP_MIN}`);
  }
});

test("collision-aware slots still respect the window + ODD-minute jitter + increasing", () => {
  const base = Date.UTC(2026, 6, 23, 14, 0, 0);
  const existing = nextSlots(3, { seed: "a", platform: "instagram", fromMs: base });
  const batch = nextSlots(3, { seed: "b", platform: "instagram", fromMs: base, avoid: existing });
  for (let i = 0; i < batch.length; i++) {
    const d = new Date(batch[i]);
    assert.ok(isWithinWindow(d), `${batch[i]} within window`);
    assert.equal(d.getUTCMinutes() % 2, 1, `minute of ${batch[i]} should be ODD`);
    if (i > 0) assert.ok(Date.parse(batch[i]) > Date.parse(batch[i - 1]), "strictly increasing");
  }
});

test("empty avoid is a no-op — identical to omitting the option", () => {
  const base = Date.UTC(2026, 6, 23, 14, 0, 0);
  const a = nextSlots(6, { seed: "same", platform: "tiktok", fromMs: base });
  const b = nextSlots(6, { seed: "same", platform: "tiktok", fromMs: base, avoid: [] });
  assert.deepEqual(a, b, "empty avoid must not change the schedule");
});

test("collision-aware scales to the daily cap (6 already-scheduled + 6 new) with no pile-up", () => {
  const base = Date.UTC(2026, 6, 23, 12, 0, 0); // 7am CDT — the full 18h window
  const existing = nextSlots(6, { seed: "day-1", platform: "tiktok", fromMs: base });
  const batch = nextSlots(6, { seed: "day-2-frx", platform: "tiktok", fromMs: base, avoid: existing });
  assert.equal(batch.length, 6);
  const all = [...existing, ...batch].map((s) => Date.parse(s)).sort((a, b) => a - b);
  assert.equal(new Set(all.map(String)).size, all.length, "no duplicate timestamps across both batches");
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i] - all[i - 1] >= gapMs, `combined gap ${(all[i] - all[i - 1]) / 60000}min < ${MIN_GAP_MIN}`);
  }
});

// ── isoInZone — the offset-carrying render used by the analytics read boundary ──
test("isoInZone: renders a real instant on the Chicago clock WITH its offset", () => {
  assert.equal(isoInZone(Date.parse("2026-08-03T05:21:00Z")), "2026-08-03T00:21:00-05:00");
});

test("isoInZone: round-trips back to the same instant", () => {
  const ms = Date.parse("2026-07-29T22:00:00Z");
  assert.equal(Date.parse(isoInZone(ms)), ms);
});

test("isoInZone: honours DST on both sides of the transition", () => {
  assert.equal(isoInZone(Date.parse("2026-01-15T12:00:00Z")), "2026-01-15T06:00:00-06:00"); // CST
  assert.equal(isoInZone(Date.parse("2026-07-15T12:00:00Z")), "2026-07-15T07:00:00-05:00"); // CDT
});

test("isoInZone: an explicit zone overrides the default", () => {
  assert.equal(isoInZone(Date.parse("2026-08-03T05:21:00Z"), "UTC"), "2026-08-03T05:21:00+00:00");
  assert.equal(isoInZone(Date.parse("2026-08-03T05:21:00Z"), "Europe/Madrid"), "2026-08-03T07:21:00+02:00");
});
