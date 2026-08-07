/**
 * contested.test.ts — the signposted-trap label.
 *
 * The tests are written against the two ways this label can be wrong in a way that
 * costs real money, rather than against its happy path:
 *
 *   A FALSE POSITIVE ships a question with no argument in it. The arm then measures
 *   comment volume on posts that were never contested, and concludes the mechanism
 *   does not work when it was never applied.
 *   A FALSE NEGATIVE is worse in the other direction: the one post that HAS produced
 *   an outlier on this account would not be recognised by its own label. So the
 *   winner is pinned here as a fixture, exactly as it shipped.
 *
 * The separation from arithmetic.ts is also asserted. This module says a trap is
 * present; it must never be read as saying the question is answerable, and the
 * ambiguity case (where the naive answer is genuinely as good) is not this module's
 * to bless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { contestedLabel, CONTESTED_ARM, CONTESTED_DIMENSION } from "./contested.ts";
import { numberPuzzleVerdict } from "./arithmetic.ts";

const puzzle = (prompt: string, options: string[], answer: string) =>
  ({ kind: "text" as const, tier: "NUMBER PUZZLE", prompt, options, answer });

/** THE WINNER, exactly as it shipped: 1,256 views, 8 comments, an argument. */
const WINNER = puzzle("IF 6+6=42, 4+1=5, 6+5=35 THEN 3+2=?", ["5", "18", "8", "11"], "8");

test("the winning post is labelled contested, and names the line that does the work", () => {
  const l = contestedLabel(WINNER);
  assert.equal(l.contested, true);
  assert.equal(l.naiveAnswer, "5", "plain 3+2");
  assert.equal(l.naiveOffered, true, "5 is option A");
  assert.equal(l.endorsedBy, "4+1=5", "the example true under BOTH readings");
});

test("the winner is ALSO a valid question — a trap is not an ambiguity", () => {
  const v = numberPuzzleVerdict(WINNER.prompt, WINNER.options, WINNER.answer);
  assert.equal(v.handled, true);
  assert.equal(v.valid, true, "a*b+b is the single consistent rule; the trap is rhetorical, not arithmetic");
});

test("no endorsing example means no trap, even when the naive answer is offered", () => {
  // 6+6=42, 6+5=35, 7+3=28 are all a*b+b, and NONE of them is also plain addition.
  const l = contestedLabel(puzzle("IF 6+6=42, 6+5=35, 7+3=28 THEN 3+2=?", ["5", "18", "8", "11"], "8"));
  assert.equal(l.contested, false);
  assert.equal(l.naiveOffered, true, "5 is still on the list");
  assert.equal(l.endorsedBy, null, "but nothing licenses reading it as addition");
});

test("an unreachable trap is not a trap: the naive answer must be selectable", () => {
  const l = contestedLabel(puzzle("IF 6+6=42, 4+1=5, 6+5=35 THEN 3+2=?", ["18", "8", "11", "20"], "8"));
  assert.equal(l.contested, false);
  assert.equal(l.naiveOffered, false);
  assert.equal(l.endorsedBy, "4+1=5", "the endorsement is still detected, the option is not there");
});

test("when the plain sum IS the official answer there is nothing to argue about", () => {
  // 4+2 under a*b-b gives 6, and plain 4+2 is also 6.
  const l = contestedLabel(puzzle("IF 3+3=6, 9+9=72, 8+6=42 THEN 4+2=?", ["6", "8", "10", "12"], "6"));
  assert.equal(l.contested, false);
  assert.match(l.reason, /IS the official answer/);
});

test("tiers with no plain-arithmetic reading are declined rather than guessed at", () => {
  const l = contestedLabel({ kind: "text", tier: "VERBAL ANALOGY", prompt: "CAT is to KITTEN as DOG is to?", options: ["PUPPY", "BONE", "PAW", "TAIL"], answer: "PUPPY" });
  assert.equal(l.contested, false);
  assert.match(l.reason, /no plain-arithmetic reading/);
});

test("the label is total — malformed input returns a verdict, never a throw", () => {
  for (const bad of [
    undefined as any,
    {} as any,
    { kind: "text", tier: "NUMBER PUZZLE", prompt: "", options: undefined, answer: undefined } as any,
    { kind: "text", tier: "NUMBER PUZZLE", prompt: "IF 6+6=42 THEN 3+2=?", options: ["5"], answer: "8" } as any,
    { kind: "numseries", tier: "NUMBER SERIES", prompt: "2 4 6 ?", options: [], answer: "8" } as any,
  ]) {
    const l = contestedLabel(bad);
    assert.equal(typeof l.contested, "boolean");
    assert.equal(l.contested, false);
  }
});

test("the arm label is a single constant, so the rollups and the planner cannot drift", () => {
  assert.equal(CONTESTED_ARM, "contested-answer");
  assert.equal(CONTESTED_DIMENSION, "contested-answer");
});

/**
 * The five questions shipped on 2026-08-07. Pinned as fixtures because the report to
 * the owner claims each one is BOTH uniquely answerable and trapped, and that claim
 * should fail loudly in CI rather than quietly in the comments.
 */
const SHIPPED: Array<[string, string[], string, string, string]> = [
  ["IF 8+9=80, 1+2=3, 9+9=90 THEN 2+3=?", ["5", "7", "8", "9"], "8", "5", "1+2=3"],
  ["IF 7+4=53, 5+3=28, 1+5=6 THEN 3+2=?", ["9", "5", "11", "15"], "11", "5", "1+5=6"],
  ["IF 3+3=6, 9+9=72, 8+6=42 THEN 4+3=?", ["8", "9", "7", "12"], "9", "7", "3+3=6"],
  ["IF 9+8=55, 7+6=29, 4+4=8 THEN 3+5=?", ["8", "15", "7", "23"], "7", "8", "4+4=8"],
  ["IF 9+2=77, 2+1=3, 8+5=39 THEN 5+2=?", ["12", "7", "21", "9"], "21", "7", "2+1=3"],
];

for (const [prompt, options, answer, naive, endorsedBy] of SHIPPED) {
  test(`shipped 2026-08-07: ${prompt}`, () => {
    const q = puzzle(prompt, options, answer);
    const l = contestedLabel(q);
    assert.equal(l.contested, true, "must carry a signposted trap");
    assert.equal(l.naiveAnswer, naive);
    assert.equal(l.endorsedBy, endorsedBy);
    // and it must still be a question with ONE defensible answer
    const v = numberPuzzleVerdict(prompt, options, answer);
    assert.equal(v.handled, true);
    assert.equal(v.valid, true, `not uniquely answerable: ${JSON.stringify(v)}`);
  });
}
