/**
 * concentration.test.ts — HERMES_ONLY_DIMENSIONS actually concentrates the batch.
 *
 * This repo has a history of configuration that looks live and is inert: experiment_lock
 * is read by nothing, the hook-challenge arm rendered byte-identical to control for
 * weeks, lower_is_better was never consulted. The failure here was a subtler cousin — the
 * flag WAS read and DID filter, but planBatch then took `.slice(0, target)` of a
 * three-arm catalog and planned three videos instead of twelve. Pinning three arms to
 * reach a conclusion faster would have quartered the day's output and made the sample
 * mature slower, and nothing would have said so.
 *
 * So these assert the EFFECT (slot count, arm balance, control present) rather than the
 * wiring, and they call selectBatchSpecs, which is the same function planBatch calls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cycleToTarget, buildDimensions, applyBatchOverrides, type DimSpec } from "./dimensions.ts";
import { selectBatchSpecs } from "./design.ts";

const spec = (arm: string): DimSpec => ({ dimension: "opening", arm, numQ: 3, category: "mixed", showProgress: true, progressStyle: "short", countdownSec: 5, rationale: "" }) as DimSpec;
const tally = (specs: DimSpec[]) => specs.reduce<Record<string, number>>((a, s) => ((a[s.arm] = (a[s.arm] ?? 0) + 1), a), {});

const withEnv = <T>(env: Record<string, string | undefined>, fn: () => T): T => {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { return fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
};

const PINNED = "motion-hook,motion-hook-stat,motion-hook-declared";

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

test("THE EFFECT: pinning three arms plans TWELVE videos, four per arm", () => {
  const { specs } = withEnv({ HERMES_ONLY_DIMENSIONS: PINNED }, () => selectBatchSpecs("2026-08-01", 12));
  assert.equal(specs.length, 12, "concentration must change which arms run, not how many posts run");
  assert.deepEqual(tally(specs), { "motion-hook": 4, "motion-hook-stat": 4, "motion-hook-declared": 4 });
});

test("THE CONTROL SURVIVES: the wordless motion-hook arm is in the pinned batch", () => {
  const { specs } = withEnv({ HERMES_ONLY_DIMENSIONS: PINNED }, () => selectBatchSpecs("2026-08-01", 12));
  const wordless = specs.filter((s) => s.arm === "motion-hook");
  assert.equal(wordless.length, 4);
  // It is the comparison that answers the question, so it must be genuinely wordless.
  for (const s of wordless) assert.equal(s.hookMechanism, undefined);
});

test("a pinned batch contains NOTHING but the named arms", () => {
  const { specs } = withEnv({ HERMES_ONLY_DIMENSIONS: PINNED }, () => selectBatchSpecs("2026-08-01", 12));
  const named = new Set(PINNED.split(","));
  for (const s of specs) assert.ok(named.has(s.arm), `${s.arm} leaked into a pinned batch`);
  // The other five opening arms, and every other dimension, are absent.
  const absent = buildDimensions().map((d) => d.arm).filter((a) => !named.has(a));
  for (const a of absent) assert.equal(specs.some((s) => s.arm === a), false, `${a} should be absent`);
});

test("pinning suppresses mascot elevation and winner replication (verbatim, no injection)", () => {
  const r = withEnv({ HERMES_ONLY_DIMENSIONS: PINNED, HERMES_MASCOT_WEIGHT: "3" }, () => selectBatchSpecs("2026-08-01", 12));
  assert.equal(r.nReplicas, 0);
  assert.equal(r.directive.active, false);
  assert.equal(r.specs.some((s) => s.dimension === "mascot" || s.dimension === "replication"), false);
});

test("NO REGRESSION: unset leaves the batch exactly as it is today", () => {
  const { specs, onlyDims } = withEnv({ HERMES_ONLY_DIMENSIONS: undefined }, () => selectBatchSpecs("2026-08-01", 12));
  assert.equal(onlyDims.length, 0);
  assert.equal(specs.length, 12);
  // The unpinned batch still ranges across the catalog rather than one dimension.
  assert.ok(new Set(specs.map((s) => s.dimension)).size > 1);
  // ...and an empty / whitespace value must not be mistaken for a pin.
  assert.equal(withEnv({ HERMES_ONLY_DIMENSIONS: "  ,  " }, () => selectBatchSpecs("2026-08-01", 12)).onlyDims.length, 0);
});

test("an unknown arm name is skipped rather than silently emptying the batch", () => {
  const { specs } = withEnv({ HERMES_ONLY_DIMENSIONS: "motion-hook,does-not-exist,motion-hook-stat" }, () => selectBatchSpecs("2026-08-01", 12));
  assert.deepEqual(tally(specs), { "motion-hook": 6, "motion-hook-stat": 6 });
});

test("applyBatchOverrides itself only ever returns arms that were asked for", () => {
  const out = applyBatchOverrides(buildDimensions(), { only: ["motion-hook-stat"] });
  assert.equal(out.length, 1);
  assert.equal(out[0].arm, "motion-hook-stat");
});
