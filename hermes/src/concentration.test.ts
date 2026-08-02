/**
 * concentration.test.ts — the batch designer, before and after the pivot.
 *
 * WHAT THESE USED TO ASSERT. That HERMES_ONLY_DIMENSIONS really concentrated the batch:
 * the flag WAS read and DID filter, but planBatch then took `.slice(0, target)` of a
 * three-arm catalog and planned three videos instead of twelve, quartering the day's
 * output while looking like it was accelerating the experiment.
 *
 * WHAT THEY ASSERT NOW. Exploration is over (2026-08-02): every slot runs the PINNED
 * format, so the operator concentration switch no longer reaches the live path at all.
 * That is a bigger change than a filter tweak and it deserves tests that would FAIL if
 * some future edit quietly reopened the rotation — which is what the first group below
 * does. The catalog helpers (cycleToTarget, applyBatchOverrides) are unchanged and
 * still tested, because restarting exploration means calling them again, not rebuilding
 * them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cycleToTarget, buildDimensions, applyBatchOverrides, PINNED_ARM, type DimSpec } from "./dimensions.ts";
import { selectBatchSpecs } from "./design.ts";

const spec = (arm: string): DimSpec => ({ dimension: "opening", arm, numQ: 3, category: "mixed", showProgress: true, progressStyle: "short", countdownSec: 5, rationale: "" }) as DimSpec;
const tally = (specs: DimSpec[]) => specs.reduce<Record<string, number>>((a, s) => ((a[s.arm] = (a[s.arm] ?? 0) + 1), a), {});

const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { return fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
};

const OLD_PIN = "motion-hook,motion-hook-stat,motion-hook-declared";

// ── The pivot: one format, every slot ────────────────────────────────────────

test("PINNED: every slot of the batch is the pinned format", () => {
  const { specs } = selectBatchSpecs("2026-08-02", 12);
  assert.equal(specs.length, 12, "the pin changes WHAT runs, never how many posts run");
  assert.deepEqual(tally(specs), { [PINNED_ARM]: 12 });
});

test("PINNED: the format is the shape the winners share, not an A/B arm", () => {
  const { specs } = selectBatchSpecs("2026-08-02", 3);
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
  const { specs, onlyDims } = withEnv({ HERMES_ONLY_DIMENSIONS: OLD_PIN }, () => selectBatchSpecs("2026-08-02", 12));
  assert.deepEqual(onlyDims, []);
  assert.deepEqual(tally(specs), { [PINNED_ARM]: 12 });
  for (const s of specs) assert.notEqual(s.opening, "motion-hook");
});

test("PINNED: no mascot elevation and no winner replication reach the batch", () => {
  const r = withEnv({ HERMES_MASCOT_WEIGHT: "3" }, () => selectBatchSpecs("2026-08-02", 12));
  assert.equal(r.nReplicas, 0);
  assert.equal(r.directive.active, false);
  assert.equal(r.specs.some((s) => s.dimension === "mascot" || s.dimension === "replication"), false);
});

test("PINNED: the batch does not vary with the run id — there is no rotation left", () => {
  const a = selectBatchSpecs("2026-08-02", 12).specs.map((s) => s.arm);
  const b = selectBatchSpecs("2026-09-14", 12).specs.map((s) => s.arm);
  assert.deepEqual(a, b);
});

test("PINNED: a zero or negative target still yields nothing", () => {
  assert.equal(selectBatchSpecs("2026-08-02", 0).specs.length, 0);
  assert.equal(selectBatchSpecs("2026-08-02", -3).specs.length, 0);
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
