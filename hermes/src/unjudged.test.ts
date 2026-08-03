/**
 * unjudged.test.ts — what happens when NO model can be reached.
 *
 * The validity gate used to admit questions on a deterministic structural check when the
 * rubric was unreachable, on the reasoning that a judge outage should not cost the day
 * its posting. The structural check cannot read: it verifies that exactly one option
 * matches the stated answer, and has no way to know whether that answer is CORRECT. So a
 * question asserting 48 has an odd digit sum passes it perfectly.
 *
 * These tests pin the two halves of the fix, which only work together:
 *   1. an unjudged question is HELD BACK rather than published unchecked;
 *   2. and is NOT quarantined, because quarantine is permanent and a 429 storm would
 *      otherwise bury the bank (28 of 29 questions on 2026-07-25).
 *
 * THE GATEWAY IS BROKEN BEFORE ANYTHING IS IMPORTED, and that ordering is the test.
 * config.ts reads the environment once and Object.freeze()s the result at module load,
 * so mutating process.env after importing gates.ts changes nothing and the suite quietly
 * makes REAL model calls against the live gateway — which is exactly what the first
 * version of this file did, and it passed a "valid" verdict straight through the
 * assertion it was supposed to be testing.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

process.env.HERMES_ENV_FILE = "/nonexistent/hermes.env"; // stop config loading the real one
process.env.TFY_LLM_BASE_URL = "http://127.0.0.1:9/never";
process.env.TFY_API_KEY = "";
process.env.OPENAI_API_KEY = "";
/**
 * A THROWAWAY DATA DIR, which is the other half of the isolation.
 *
 * The gate caches verdicts under CONFIG.CACHE_DIR (derived from HERMES_DATA_DIR), and a
 * cache hit returns before any model is consulted — so a test whose questions are
 * already cached asserts nothing at all. Worse, the first version of this file reached
 * the LIVE gateway and wrote its fixture verdicts into the production cache, which then
 * made the fixed version pass for the wrong reason. Point the whole data dir at a temp
 * directory so this suite can neither read nor write the real one.
 */
process.env.HERMES_DATA_DIR = mkdtempSync(`${tmpdir()}/hermes-unjudged-`);

import test from "node:test";
import assert from "node:assert/strict";
import type { HermesQ } from "./state.ts";

// Dynamic, so the env above is in place before config.ts freezes it.
const { validateQuestions } = await import("./gates.ts");

function q(over: Partial<HermesQ> = {}): HermesQ {
  return {
    sig: "text|verbal|odd-one-out|unjudged probe || alpha~beta~gamma~delta|delta",
    hash: "unjudgedtest1",
    kind: "text",
    category: "verbal",
    tier: "ODD ONE OUT",
    prompt: "WHICH DOES NOT BELONG?",
    options: ["ALPHA", "BETA", "GAMMA", "DELTA"],
    answer: "DELTA",
    ...over,
  } as HermesQ;
}

test("UNJUDGED: a structurally-fine question is HELD BACK when no model answers", async () => {
  const { results, gate } = await validateQuestions([q()]);
  const v = results[q().sig];
  assert.equal(v.valid, false, "a question nobody read must not be published");
  assert.equal(v.unjudged, true, "and must be marked unjudged, not defective");
  assert.match(v.reason, /unreachable|no rubric verdict/i);
  assert.equal(gate.pass, false, "the video does not ship");
});

test("UNJUDGED: the flag is what stops a 429 storm quarantining the bank", async () => {
  const qs = [q(), q({ sig: "s2", hash: "h2", answer: "GAMMA" })];
  const { results } = await validateQuestions(qs);
  // cycle.ts's quarantine predicate, verbatim. It must select NOTHING here.
  const bad = qs.filter((x) => {
    const r = results[x.sig];
    return r && !r.valid && !r.unjudged;
  });
  assert.equal(bad.length, 0, "an outage must never permanently bury a question");
});

test("UNJUDGED: a genuinely malformed question is still a REAL failure, outage or not", async () => {
  // The answer matches no option. The structural check catches that without a model, so
  // it is a defect rather than an absence of opinion, and SHOULD be quarantined.
  const bad = q({ sig: "s3", hash: "h3", answer: "OMEGA" });
  const { results } = await validateQuestions([bad]);
  const v = results["s3"];
  assert.equal(v.valid, false);
  assert.notEqual(v.unjudged, true, "structural defects are judged, just not by a model");
  assert.match(v.reason, /structural/);
});

test("UNJUDGED: enumeration-decided types still pass with no model at all", async () => {
  // NUMBER PUZZLE / NUMBER ANALOGY are settled by arithmetic.ts by enumerating the
  // candidate rules. Those are proofs, so an outage must not hold them back — this is
  // what keeps a total gateway failure from costing the day EVERY video.
  const puzzle = q({
    sig: "text|quantitative|number-puzzle|if 2 3 10 4 1 10 5 2 14 then 3 4 || 7~12~14~24|14",
    hash: "hpuzzle",
    category: "quantitative",
    tier: "NUMBER PUZZLE",
    prompt: "IF  2+3=10,  4+1=10,  5+2=14\nTHEN  3+4 = ?",
    options: ["7", "12", "14", "24"],
    answer: "14",
  });
  const { results } = await validateQuestions([puzzle]);
  const v = results[puzzle.sig];
  assert.notEqual(v.unjudged, true, "a proof does not need the model to be up");
  assert.equal(v.valid, true, "and this one is arithmetically correct");
});
