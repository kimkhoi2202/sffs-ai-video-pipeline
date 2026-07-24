/**
 * dimensions.test.ts — the PURE question TYPE-variety selector (P1):
 * selectSpread picks numQ questions maximizing per-video tier/kind spread and
 * per-batch anti-clustering, deterministically. Complements the fuzzy near-dup
 * guard (questions.test.ts).
 *
 * Hermetic: points config at a tmp dir BEFORE importing (dimensions.ts pulls in
 * defaults.ts -> config.ts) and exercises only the pure, network-free helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-dims-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const { selectSpread, newSpreadTally, buildDimensions, applyBatchOverrides, elevateMascot } = await import("./dimensions.ts");

let n = 0;
function q(tier: string, kind: "text" | "numseries" = "text"): any {
  n++;
  return { sig: `s${n}`, hash: `h${n}`, kind, category: "verbal", tier, prompt: `p${n}`, options: ["a", "b", "c"], answer: "a" };
}

const tiersOf = (arr: any[]) => arr.map((x) => x.tier);

test("per-video spread: picks distinct tiers instead of the biggest bucket", () => {
  // Pool over-samples tier A (as the seeded pool would for the biggest type).
  const pool = [q("A"), q("A"), q("A"), q("B"), q("B"), q("C")];
  const chosen = selectSpread(pool, 3, newSpreadTally());
  assert.equal(chosen.length, 3);
  assert.equal(new Set(tiersOf(chosen)).size, 3); // one A, one B, one C — not A,A,A
  assert.deepEqual([...new Set(tiersOf(chosen))].sort(), ["A", "B", "C"]);
});

test("returns fewer than numQ when the pool is too small (caller drops it)", () => {
  const chosen = selectSpread([q("A"), q("B")], 3, newSpreadTally());
  assert.equal(chosen.length, 2);
});

test("per-batch anti-clustering: prefers the globally rarer tier on a within-video tie", () => {
  const batch = newSpreadTally();
  batch.tier["A"] = 5; // tier A already heavily used across the batch
  batch.tier["C"] = 0;
  // both are new to THIS video (tie on per-video keys) -> batch tally breaks it.
  const chosen = selectSpread([q("A"), q("C")], 1, batch);
  assert.deepEqual(tiersOf(chosen), ["C"]);
});

test("kind is a secondary spread axis", () => {
  // tiers identical but kinds differ -> should not pick two of the same kind first.
  const pool = [q("T", "text"), q("T", "text"), q("T", "numseries")];
  const chosen = selectSpread(pool, 2, newSpreadTally());
  assert.equal(new Set(chosen.map((x) => x.kind)).size, 2); // one text, one numseries
});

test("deterministic: same pool + fresh batch -> identical selection", () => {
  const pool = [q("A"), q("B"), q("A"), q("C"), q("B")];
  const a = tiersOf(selectSpread(pool, 3, newSpreadTally()));
  const b = tiersOf(selectSpread(pool, 3, newSpreadTally()));
  assert.deepEqual(a, b);
});

test("stable tie-break by pool index when nothing else differs", () => {
  const pool = [q("A"), q("A"), q("A")]; // all identical tier+kind
  const chosen = selectSpread(pool, 2, newSpreadTally());
  assert.deepEqual(chosen.map((x) => x.sig), [pool[0].sig, pool[1].sig]);
});

test("mutates the batch tally so later videos balance against earlier ones", () => {
  const batch = newSpreadTally();
  selectSpread([q("A"), q("B")], 2, batch);
  assert.equal(batch.tier["A"], 1);
  assert.equal(batch.tier["B"], 1);
  assert.equal(batch.kind["text"], 2);
});

// ── applyBatchOverrides (targeted/showcase batch hook) ───────────────────────
// Critical invariant: with NO opts it must be byte-for-byte the default catalog,
// so the live loop + rotation are unchanged unless an operator opts in via env.

test("applyBatchOverrides: no opts -> catalog unchanged (behavior-preserving)", () => {
  const cat = buildDimensions();
  assert.deepEqual(applyBatchOverrides(cat).map((d) => d.arm), cat.map((d) => d.arm));
  assert.deepEqual(applyBatchOverrides(cat, {}).map((d) => d.dimension), cat.map((d) => d.dimension));
});

test("applyBatchOverrides: only restricts + orders by dimension/arm name", () => {
  const cat = buildDimensions();
  const out = applyBatchOverrides(cat, { only: ["shapes", "verbal-only", "quant-only"] });
  assert.deepEqual(out.map((d) => d.arm), ["shapes", "verbal-only", "quant-only"]);
});

test("applyBatchOverrides: unknown names are skipped (blank/whitespace too)", () => {
  const cat = buildDimensions();
  const out = applyBatchOverrides(cat, { only: ["nope", " control ", "also-nope"] });
  assert.deepEqual(out.map((d) => d.arm), ["control"]);
});

test("applyBatchOverrides: shapeNumQ overrides ONLY the shape dimension's numQ", () => {
  const cat = buildDimensions();
  const out = applyBatchOverrides(cat, { shapeNumQ: 4 });
  assert.equal(out.find((d) => d.dimension === "type-nonverbal-shapes")?.numQ, 4);
  for (const d of out) {
    if (d.dimension === "type-nonverbal-shapes") continue;
    const orig = cat.find((c) => c.dimension === d.dimension && c.arm === d.arm);
    assert.equal(d.numQ, orig?.numQ);
  }
});

test("applyBatchOverrides: shapeNumQ ignores non-positive / non-integer", () => {
  const cat = buildDimensions();
  const origShape = cat.find((d) => d.dimension === "type-nonverbal-shapes")?.numQ;
  for (const bad of [0, -1, 2.5, NaN]) {
    const out = applyBatchOverrides(cat, { shapeNumQ: bad as number });
    assert.equal(out.find((d) => d.dimension === "type-nonverbal-shapes")?.numQ, origShape);
  }
});

test("applyBatchOverrides: only + shapeNumQ compose", () => {
  const cat = buildDimensions();
  const out = applyBatchOverrides(cat, { only: ["shapes", "control"], shapeNumQ: 4 });
  assert.deepEqual(out.map((d) => d.arm), ["shapes", "control"]);
  assert.equal(out.find((d) => d.arm === "shapes")?.numQ, 4);
});

// ── elevateMascot (Part B mascot allocation bias) ──────────────────────────
// The mascot dimension must be tested EVERY cycle (elevated out of the seeded
// random subset) and weighted toward more mascot, capped at target (12/day intact).

test("elevateMascot: forces mascot controls every cycle, weighted, absent-first, capped", () => {
  const cat = buildDimensions(); // mascot challengers = universe minus the default (now standard + absent; prominent is the default)
  const out = elevateMascot(cat.slice(), 10, 3);
  assert.equal(out.length, 10);
  assert.equal(out.filter((d) => d.dimension === "mascot").length, 3);
  assert.equal(out[0].arm, "mascot-absent"); // prominent is the baked-in default; absent (the no-mascot control) leads the challengers
  assert.ok(out.some((d) => d.arm === "mascot-absent"));
  assert.ok(!out.some((d) => d.arm === "mascot-prominent")); // the default is never re-run as a challenger arm
});

test("elevateMascot: weight 0 disables the bias (plain seeded slice)", () => {
  const cat = buildDimensions();
  const out = elevateMascot(cat.slice(), 5, 0);
  assert.deepEqual(out.map((d) => d.arm), cat.slice(0, 5).map((d) => d.arm));
});

test("elevateMascot: never exceeds target and stays deterministic", () => {
  const cat = buildDimensions();
  const a = elevateMascot(cat.slice(), 6, 3).map((d) => d.arm);
  const b = elevateMascot(cat.slice(), 6, 3).map((d) => d.arm);
  assert.equal(a.length, 6);
  assert.deepEqual(a, b);
});
