/**
 * scheduler.test.ts — proves the post-kickoff scheduling policy: every slot lands
 * in the 7:00am–1:00am America/Chicago window (NOTHING 1–7am), minutes are odd +
 * jittered, gaps are irregular, slots are distinct + increasing, and IG != TikTok.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSlots, isWithinWindow, chicagoHour } from "./scheduler.ts";

const dayFrom = Date.UTC(2026, 6, 20, 12, 0, 0); // fixed base (July 2026 = CDT)

test("every slot is inside the window — NOTHING between 1:00am and 7:00am CST", () => {
  const slots = nextSlots(60, { seed: "run-x", platform: "instagram", fromMs: dayFrom });
  assert.equal(slots.length, 60);
  for (const iso of slots) {
    const d = new Date(iso);
    const h = chicagoHour(d);
    assert.ok(h === 0 || h >= 7, `slot ${iso} -> Chicago hour ${h} must be 0 or >=7 (never 1..6)`);
    assert.ok(isWithinWindow(d), `${iso} within window`);
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
  // find a UTC instant that is ~3am in Chicago
  let ms = dayFrom;
  for (let i = 0; i < 48; i++) {
    if (chicagoHour(new Date(ms)) === 3) break;
    ms += 30 * 60000;
  }
  assert.equal(chicagoHour(new Date(ms)), 3, "constructed a 3am-Chicago base");
  const [first] = nextSlots(1, { seed: "dead", platform: "instagram", fromMs: ms });
  assert.ok(isWithinWindow(new Date(first)), `${first} pushed into window from dead hours`);
});
