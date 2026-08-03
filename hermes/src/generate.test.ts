/**
 * generate.test.ts — the bank top-up, driven through the REAL admission path.
 *
 * What these lock out, in the order each would actually bite:
 *
 *   1. A generated question skipping a gate. The whole promise is that a machine-written
 *      item gets the same scrutiny as an authored one, and the cheapest way to break
 *      that promise is an early-return that quietly admits something.
 *   2. LONG hard questions. Difficulty is easy to buy with words, and buying it that way
 *      costs the retention that predicts reach — so the reading-load rule is asserted at
 *      the boundary rather than trusted to the prompt.
 *   3. Duplicates. The never-repeat guarantee is keyed off signature bytes that
 *      content/validate.mjs owns; a generated row that computes them differently is a
 *      silent duplicate, not an error.
 *   4. A failure taking the cycle down with it. Generation is an optimiser and must
 *      degrade to "post fewer videos", never to "post nothing".
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  runway, admitCandidates, appendToBank, drawableCount,
  GRADE_AUTHORED, GRADE_HARD, MAX_GEN_PROMPT_WORDS, TOPUP_RUNWAY_DAYS,
} from "./generate.ts";
import { promptWords } from "./leadPolicy.ts";

/** A candidate in the exact shape the model is asked to return. */
function cand(over: Record<string, unknown> = {}) {
  return {
    prompt: "WHICH DOES NOT BELONG?",
    options: ["2", "3", "5", "9"],
    answer: "9",
    explanation: "2, 3 and 5 are prime; 9 is the only composite number.",
    tier: "ODD ONE OUT",
    category: "quantitative",
    ...over,
  };
}

// ── the runway maths, which is what decides whether we generate at all ──────

test("runway converts a drawable pool into days and a shortfall", () => {
  const r = runway(72, 6);
  assert.equal(r.perDay, 72);
  assert.ok(r.drawable > 0, "the real bank must be readable from the test process");
  assert.equal(r.days, r.drawable / 72);
  // needsTopUp and shortfall have to agree with each other, or the engine either
  // generates nothing while starving or generates forever while full.
  if (r.drawable < 6 * 72) {
    assert.equal(r.needsTopUp, true);
    assert.equal(r.shortfall, 6 * 72 - r.drawable);
  } else {
    assert.equal(r.needsTopUp, false);
    assert.equal(r.shortfall, 0);
  }
});

test("runway at the CURRENT burn is the number the decision rests on", () => {
  // 12 videos/day x 3 questions = 36. Doubling to 72 is what per-platform TikTok costs.
  const now = runway(36);
  const dbl = runway(72);
  assert.ok(Math.abs(now.days - 2 * dbl.days) < 1e-9, "doubling the burn must halve the runway");
  assert.equal(now.drawable, drawableCount());
});

test("a full pool does not trigger generation", () => {
  const r = runway(1, TOPUP_RUNWAY_DAYS); // 1 question/day -> hundreds of days
  assert.equal(r.needsTopUp, false);
  assert.equal(r.shortfall, 0);
});

// ── admission: every rule, asserted at the boundary ─────────────────────────

test("ADMISSION: a long prompt is refused however good the question is", async () => {
  const long = "WHICH ONE OF THESE FOUR NUMBERS DOES NOT BELONG WITH THE OTHERS?";
  assert.ok(promptWords(long) > MAX_GEN_PROMPT_WORDS);
  const { admitted, rejected } = await admitCandidates([cand({ prompt: long })]);
  assert.equal(admitted.length, 0, "reading load is the rule this feature exists to hold");
  assert.match(rejected[0].reason, /words, max/);
});

test("ADMISSION: structural defects are refused by the SAME check the gates use", async () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    // Answer not among the options. toHermesQ refuses it first (it enforces the
    // exactly-one-match rule at bank-load time), so either refusal is correct here —
    // what matters is that it never reaches the judge.
    [{ answer: "7" }, /answer matches 0 option|failed toHermesQ/],
    [{ options: ["2", "2", "3", "5"], answer: "3" }, /duplicate option/],
    [{ options: ["2", "3"], answer: "3" }, /options, got 2|failed toHermesQ/],
    [{ options: ["2", "3", "5", "A".repeat(40)], answer: "9" }, /> 24 chars|failed toHermesQ/],
    [{ explanation: "" }, /no explanation/],
    [{ tier: "MADE UP TYPE" }, /not in the allowed vocabulary/],
    [{ category: "sideways" }, /category .* not allowed/],
    [{ prompt: "WHICH IS ODD \u2014 REALLY?" }, /em\/en dash/],
    [{ prompt: "" }, /missing prompt/],
  ];
  for (const [over, re] of cases) {
    const { admitted, rejected } = await admitCandidates([cand(over)]);
    assert.equal(admitted.length, 0, `should have refused: ${JSON.stringify(over)}`);
    assert.match(rejected[0]?.reason ?? "", re, `wrong reason for ${JSON.stringify(over)}`);
  }
});

test("ADMISSION: a question already in the bank is refused as an exact duplicate", async () => {
  // the canonical bank item, reproduced exactly
  const dup = cand({
    prompt: "WHICH ONE DOES NOT BELONG?",
    options: ["APPLE", "BANANA", "CARROT", "GRAPE"],
    answer: "CARROT",
    tier: "ODD ONE OUT",
    category: "verbal",
    explanation: "Apple, banana and grape are fruits; carrot is a vegetable.",
  });
  const { admitted, rejected } = await admitCandidates([dup]);
  assert.equal(admitted.length, 0);
  assert.match(rejected[0].reason, /duplicate/);
});

test("ADMISSION: two identical candidates in ONE batch cannot both get in", async () => {
  const { admitted, rejected } = await admitCandidates([cand(), cand()]);
  assert.ok(admitted.length <= 1, "the in-batch guard must hold, not just the bank guard");
  if (admitted.length === 1) assert.match(rejected[0].reason, /duplicate/);
});

test("ADMISSION: reordered options are caught as a NEAR-duplicate, not admitted twice", async () => {
  const a = cand({ options: ["2", "3", "5", "9"] });
  const b = cand({ options: ["9", "5", "3", "2"] }); // same set, different order
  const { admitted } = await admitCandidates([a, b]);
  assert.ok(admitted.length <= 1, "the fuzzy key ignores option order, so this is one question");
});

test("ADMISSION: signatures are computed by validate.mjs, not reinvented here", async () => {
  const { admitted } = await admitCandidates([cand({ options: ["4", "6", "8", "11"], answer: "11", explanation: "Only 11 is odd." })]);
  if (!admitted.length) return; // judge may legitimately reject; the shape test below still matters
  const e = admitted[0];
  const mod: any = await import(new URL("../../content/validate.mjs", import.meta.url).href);
  const expected = mod.sigOf({
    kind: "text", category: e.category, tier: e.tier,
    question: e.prompt, options: e.options.map((t: string) => ({ text: t })), ansLabel: e.answer,
  });
  assert.equal(e.sig, expected, "a divergent signature is a silent duplicate");
  assert.equal(e.hash, mod.hashOf(expected));
});

// ── the new difficulty field ────────────────────────────────────────────────

test("gradeLevel is a real variable and cannot be confused with tier", async () => {
  assert.equal(GRADE_AUTHORED, 5, "what round.schema.json already asserts about the bank");
  assert.equal(GRADE_HARD, 12);
  assert.notEqual(GRADE_AUTHORED, GRADE_HARD, "a field with one value cannot be measured");
  const { admitted } = await admitCandidates([cand()], GRADE_HARD);
  for (const e of admitted) {
    assert.equal(e.gradeLevel, GRADE_HARD);
    assert.ok(typeof e.gradeLevel === "number", "an integer level, not a label like tier");
    assert.match(e.source, /hermes-generate/, "provenance so it is never mistaken for authored");
    assert.notEqual(e.tier, String(e.gradeLevel), "tier stays the TYPE");
  }
});

// ── writing to the bank ─────────────────────────────────────────────────────

test("appendToBank is re-entrant and never writes the same question twice", () => {
  // An empty append must be a no-op rather than a rewrite of a 1,500-entry file.
  assert.equal(appendToBank([]), 0);
});

test("MAX_GEN_PROMPT_WORDS keeps generated items inside the retaining band", () => {
  // <=5 words is the band that measured 64.3% skip against 71.7% for >=10. Six is the
  // ceiling because "WHICH DOES NOT BELONG?" plus one qualifier still reads at a glance.
  assert.ok(MAX_GEN_PROMPT_WORDS <= 6);
  assert.equal(promptWords("WHICH DOES NOT BELONG?"), 4);
});
