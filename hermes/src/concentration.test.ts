/**
 * concentration.test.ts — the batch designer, before and after the pivot.
 *
 * WHAT THESE USED TO ASSERT. That HERMES_ONLY_DIMENSIONS really concentrated the batch:
 * the flag WAS read and DID filter, but planBatch then took `.slice(0, target)` of a
 * three-arm catalog and planned three videos instead of twelve, quartering the day's
 * output while looking like it was accelerating the experiment.
 *
 * WHAT THEY ASSERT NOW. The batch is 70% pinned format and 30% a two-arm exploration
 * slice (2026-08-03). The operator concentration switch still never reaches the live
 * path, and the old rotation stays shut — the first group below would FAIL if some
 * future edit quietly reopened it. The second group pins the exploration floor itself,
 * because a 100% allocation is exactly how a bet stops being measurable: on 2026-08-03
 * the pinned format had 12 scheduled Instagram posts and ZERO published, so it carried
 * no performance data of its own and nothing was running that could produce any. The
 * catalog helpers (cycleToTarget, applyBatchOverrides) are unchanged and still tested.
 *
 * THE ONE THING THE RUN ID NOW DECIDES. Three slots across two arms cannot split evenly,
 * so the odd slot ALTERNATES BY CALENDAR DAY rather than going to the same arm forever.
 * Without that, the second arm gets 1 post/day and needs twelve days to reach
 * min_sample=12 — the read lands after the window it was sized for. The batch is still
 * fully reproducible from the date; nothing here is random, and same date in means same
 * batch out. The tests below pin BOTH halves of that: it varies by day, and it varies
 * ONLY in which exploration arm takes the spare slot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cycleToTarget, buildDimensions, applyBatchOverrides, PINNED_ARM, EXPLORATION_ARMS, type DimSpec } from "./dimensions.ts";
import { selectBatchSpecs, explorationCount, EXPLORATION_SHARE } from "./design.ts";

const spec = (arm: string): DimSpec => ({ dimension: "opening", arm, numQ: 3, category: "mixed", showProgress: true, progressStyle: "short", countdownSec: 5, rationale: "" }) as DimSpec;
const tally = (specs: DimSpec[]) => specs.reduce<Record<string, number>>((a, s) => ((a[s.arm] = (a[s.arm] ?? 0) + 1), a), {});

const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { return fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
};

const OLD_PIN = "motion-hook,motion-hook-stat,motion-hook-declared";

// ── The pivot: one format, every slot ────────────────────────────────────────

test("PINNED: the batch is 70% pinned format, 30% exploration", () => {
  const { specs } = selectBatchSpecs("2026-08-03", 12);
  assert.equal(specs.length, 12, "the mix changes WHAT runs, never how many posts run");
  assert.deepEqual(tally(specs), { [PINNED_ARM]: 9, "control": 2, "one-question": 1 });
  // At the live ceiling of 11 the slice must still be 3, not 2 — see EXPLORATION_SHARE.
  const day11 = selectBatchSpecs("2026-08-03", 11);
  assert.equal(day11.specs.length, 11);
  assert.deepEqual(tally(day11.specs), { [PINNED_ARM]: 8, "control": 2, "one-question": 1 });
});

test("PINNED: the format is the shape the winners share, not an A/B arm", () => {
  // target 3 floors to zero exploration slots, so this is the pure pinned spec.
  const { specs } = selectBatchSpecs("2026-08-02", 3);
  assert.deepEqual(tally(specs), { [PINNED_ARM]: 3 });
  for (const s of specs) {
    assert.equal(s.numQ, 3, "three questions");
    assert.equal(s.opening, "cold-plate", "cold open — question one at 0.00s");
    assert.equal(s.hookMechanism, undefined, "no spoken hook rides the opening any more");
    assert.equal(s.countdownSec, 5);
    assert.equal(s.showProgress, true);
    assert.equal(s.progressStyle, "short");
    // Narration / ending / mascot are deliberately UNSET so the video inherits the
    // current content defaults; a spec that pinned them would silently outrank the
    // human promotion CLI.
    assert.equal(s.narrationArm, undefined);
    assert.equal(s.endingArm, undefined);
    assert.equal(s.mascotArm, undefined);
  }
});

test("PINNED: the concentrated hook arms cannot come back through the env switch", () => {
  // HERMES_ONLY_DIMENSIONS was live on the box pinning every slot to the three
  // motion-hook arms — the worst-measured openings in the account. It must now be inert.
  const { specs, onlyDims } = withEnv({ HERMES_ONLY_DIMENSIONS: OLD_PIN }, () => selectBatchSpecs("2026-08-03", 12));
  assert.deepEqual(onlyDims, []);
  assert.deepEqual(tally(specs), { [PINNED_ARM]: 9, "control": 2, "one-question": 1 });
  for (const s of specs) assert.notEqual(s.opening, "motion-hook");
  // The exploration slice is a deliberate two-arm list, NOT a reopened rotation.
  for (const s of specs) assert.ok(s.arm === PINNED_ARM || EXPLORATION_ARMS.includes(s.arm), `unexpected arm ${s.arm}`);
});

test("PINNED: no mascot elevation and no winner replication reach the batch", () => {
  const r = withEnv({ HERMES_MASCOT_WEIGHT: "3" }, () => selectBatchSpecs("2026-08-02", 12));
  assert.equal(r.nReplicas, 0);
  assert.equal(r.directive.active, false);
  assert.equal(r.specs.some((s) => s.dimension === "mascot" || s.dimension === "replication"), false);
});

test("PINNED: the run id moves the exploration arms and nothing else", () => {
  // The old rotation over the whole catalog is still shut. Two days apart run the
  // identical batch; one day apart differ ONLY where an exploration arm sits.
  const a = selectBatchSpecs("2026-08-03", 12).specs.map((s) => s.arm);
  const b = selectBatchSpecs("2026-08-05", 12).specs.map((s) => s.arm);
  assert.deepEqual(a, b, "same parity day => byte-identical batch");
  const c = selectBatchSpecs("2026-08-04", 12).specs.map((s) => s.arm);
  assert.notDeepEqual(a, c, "consecutive days must alternate the spare exploration slot");
  for (let i = 0; i < a.length; i++) {
    if (a[i] === c[i]) continue;
    assert.ok(EXPLORATION_ARMS.includes(a[i]) && EXPLORATION_ARMS.includes(c[i]),
      `slot ${i} may only differ between exploration arms, got ${a[i]} vs ${c[i]}`);
  }
  // The pinned slots are the same slots on both days — only the arms inside the
  // slice move, so the day's shape and volume never change.
  assert.deepEqual(
    a.map((x) => x === PINNED_ARM),
    c.map((x) => x === PINNED_ARM),
  );
});

test("PINNED: a top-up wave inherits its day's rotation, so a day stays coherent", () => {
  const base = selectBatchSpecs("2026-08-04", 12).specs.map((s) => s.arm);
  const wave = selectBatchSpecs("2026-08-04-t1", 12).specs.map((s) => s.arm);
  assert.deepEqual(base, wave, "the -tN suffix is not a different day");
});

test("PINNED: a zero or negative target still yields nothing", () => {
  assert.equal(selectBatchSpecs("2026-08-02", 0).specs.length, 0);
  assert.equal(selectBatchSpecs("2026-08-02", -3).specs.length, 0);
});

// ── The exploration floor: the batch may never go all-in again ───────────────

test("EXPLORE: a full batch always keeps a measurable exploration slice", () => {
  for (const target of [4, 6, 8, 10, 12, 16, 24]) {
    const { specs } = selectBatchSpecs("2026-08-03", target);
    const n = specs.filter((s) => s.arm !== PINNED_ARM).length;
    assert.equal(specs.length, target, `target ${target}: slot count is unchanged`);
    assert.ok(n >= 1, `target ${target}: exploration must never be zero on a full batch`);
    assert.ok(n < target, `target ${target}: exploration must never take the whole batch`);
  }
});

test("EXPLORE: the slice is 30% floored, so the pinned format takes the rounding", () => {
  assert.equal(EXPLORATION_SHARE, 0.3);
  // THREE is the number that matters: two arms alternating over three slots is
  // 1.5 posts/arm/day, which reaches min_sample=12 in eight days. Two slots is 1/day
  // and takes twelve — the read would land after the window closes.
  assert.equal(explorationCount(12), 3);
  assert.equal(explorationCount(11), 3, "the live ceiling must still fund three slots");
  assert.equal(explorationCount(8), 2);
  assert.equal(explorationCount(4), 1);
  // Small top-up waves stay 100% pinned: those slots exist to hit the daily floor.
  assert.equal(explorationCount(3), 0);
  assert.equal(explorationCount(1), 0);
  assert.equal(explorationCount(0), 0);
  assert.equal(explorationCount(-5), 0);
});

test("EXPLORE: over two days each arm gets three of the six slots", () => {
  // The property the eight-day read-out rests on. One day alone cannot be even.
  const two = [
    ...selectBatchSpecs("2026-08-03", 11).specs,
    ...selectBatchSpecs("2026-08-04", 11).specs,
  ].filter((s) => s.arm !== PINNED_ARM);
  assert.deepEqual(tally(two), { control: 3, "one-question": 3 });
});

test("EXPLORE: exploration slots are spread through the batch, not bolted on the end", () => {
  // Slot index decides the hashtag set (HASHTAG_ROTATION[i % 3]) and the posting
  // time, so a slice clustered at the tail would confound the arm with both.
  const { specs } = selectBatchSpecs("2026-08-03", 12);
  const at = specs.map((s, i) => (s.arm === PINNED_ARM ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(at, [3, 7, 11]);
  assert.deepEqual([...new Set(at.map((i) => i % 3))].sort(), [0, 1, 2], "one slot per hashtag set");
});

test("EXPLORE: the slice is the two named arms and stays reproducible", () => {
  assert.deepEqual([...EXPLORATION_ARMS], ["control", "one-question"]);
  // Reproducible, not frozen: the same date always yields the same batch, with no
  // clock read and no randomness. Two calls for one day must never disagree.
  const a = selectBatchSpecs("2026-08-03", 12).specs.map((s) => s.arm);
  const b = selectBatchSpecs("2026-08-03", 12).specs.map((s) => s.arm);
  assert.deepEqual(a, b, "no clock, no randomness");
  // Both arms must actually run across the pair of days, or the pinned format has no
  // comparator and the probe has no sample.
  const c = selectBatchSpecs("2026-08-04", 12).specs.map((s) => s.arm);
  assert.ok(a.includes("control") && c.includes("control"));
  assert.ok(a.includes("one-question") && c.includes("one-question"));
});

test("EXPLORE: an unparseable run id falls back to a fixed order rather than throwing", () => {
  const { specs } = selectBatchSpecs("not-a-date", 12);
  assert.equal(specs.length, 12);
  assert.deepEqual(tally(specs), { [PINNED_ARM]: 9, control: 2, "one-question": 1 });
});

test("EXPLORE: exploration arms are real catalog arms, not redeclared lookalikes", () => {
  const catalog = buildDimensions();
  for (const arm of EXPLORATION_ARMS) {
    assert.ok(catalog.some((d) => d.arm === arm), `${arm} must exist in buildDimensions()`);
  }
});

// ── The catalog helpers, kept intact for whenever exploration restarts ───────

test("cycleToTarget fills every slot from a short catalog", () => {
  assert.equal(cycleToTarget([spec("a"), spec("b"), spec("c")], 12).length, 12);
  assert.deepEqual(tally(cycleToTarget([spec("a"), spec("b"), spec("c")], 12)), { a: 4, b: 4, c: 4 });
});

test("cycleToTarget spreads a remainder one per arm rather than piling it on the first", () => {
  const t = tally(cycleToTarget([spec("a"), spec("b"), spec("c"), spec("d"), spec("e")], 12));
  assert.deepEqual(Object.values(t).sort(), [2, 2, 2, 3, 3]);
});

test("cycleToTarget never exceeds target and never invents specs from nothing", () => {
  assert.equal(cycleToTarget([spec("a")], 12).length, 12);
  assert.equal(cycleToTarget([], 12).length, 0);
  assert.equal(cycleToTarget([spec("a"), spec("b")], 0).length, 0);
  // A catalog already at or over target is untouched.
  const big = Array.from({ length: 25 }, (_, i) => spec(`a${i}`));
  assert.equal(cycleToTarget(big, 12).length, 12);
});

test("applyBatchOverrides itself only ever returns arms that were asked for", () => {
  const out = applyBatchOverrides(buildDimensions(), { only: ["motion-hook-stat"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].arm, "motion-hook-stat");
});

test("the arm catalog still builds, so exploration is one call away from restarting", () => {
  const catalog = buildDimensions();
  assert.ok(catalog.length > 5);
  assert.ok(catalog.some((d) => d.dimension === "control"));
  assert.ok(catalog.some((d) => d.dimension === "opening"));
});
