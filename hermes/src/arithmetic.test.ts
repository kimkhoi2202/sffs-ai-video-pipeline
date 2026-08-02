/**
 * arithmetic.test.ts — the deterministic verifier that took the hidden-operator
 * tiers away from the LLM rubric.
 *
 * Every VALID case below is a REAL question the judge rejected between 2026-07-30 and
 * 2026-08-02, with the verdict it gave. Every INVALID case is a real bank entry that is
 * genuinely broken. That is the point of the fixture set: the module has to rescue the
 * first group and still catch the second, and asserting it on invented items would
 * prove neither.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-arith-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const { quantVerdict, numberPuzzleVerdict, numberAnalogyVerdict } = await import("./arithmetic.ts");

const q = (tier: string, prompt: string, options: string[], answer: string) =>
  ({ sig: "s", hash: "h", kind: "text", category: "quantitative", tier, prompt, options, answer }) as any;

// ── Rescued: the judge said invalid, its own rationale said otherwise ─────────

test("RESCUES the number puzzles the judge threw away", () => {
  const cases: Array<[string, string[], string, string]> = [
    // prompt, options, answer, the judge's (wrong) reason on 2026-07-30..08-02
    ["IF  5+5=20,  1+3=8,  8+4=24\nTHEN  9+6 = ?", ["32", "33", "30", "40"], "30", "(a+b)*2 ... so 9+6=30 correct"],
    ["IF  6+5=55,  7+8=75,  3+5=40\nTHEN  4+9 = ?", ["65", "13", "64", "66"], "65", "however verify: yes 65 corre"],
    ["IF  2+3=25,  3+4=35,  2+1=15\nTHEN  6+4 = ?", ["50", "60", "10", "51"], "50", "rule unclear"],
    ["IF  8+3=13,  5+2=3,  3+5=7\nTHEN  7+8 = ?", ["41", "42", "15", "36"], "41", "no single rule yields 41"],
    ["IF  1+8=36,  1+4=20,  3+3=24\nTHEN  9+9 = ?", ["72", "82", "69", "62"], "72", "no consistent rule"],
    ["IF  7+8=64,  3+7=28,  6+9=63\nTHEN  8+5 = ?", ["50", "13", "44", "45"], "45", "nonstandard/tricky"],
    ["IF  2+1=-1,  6+6=24,  5+4=11\nTHEN  4+6 = ?", ["14", "12", "16", "15"], "14", "rule non-obvious/ambiguous"],
  ];
  for (const [prompt, options, answer, judgeSaid] of cases) {
    const v = numberPuzzleVerdict(prompt, options, answer);
    assert.equal(v.handled, true, `should be decided here, not sent to the rubric (${prompt})`);
    assert.equal(v.valid, true, `must be VALID; the judge said invalid because "${judgeSaid}"`);
    assert.match((v as any).reason, /single consistent rule/);
  }
});

test("RESCUES the number analogies too", () => {
  for (const [prompt, options, answer] of [
    ["WHICH NUMBER FITS?\n3 -> 7,   5 -> 13,   6 -> 16,   7 -> ?", ["19", "9", "22", "21"], "19"],
    ["WHICH NUMBER FITS?\n3 -> 4,   5 -> 8,   7 -> 12,   6 -> ?", ["12", "10", "20", "11"], "10"],
    ["WHICH NUMBER FITS?\n2 -> 9,   3 -> 12,   7 -> 24,   5 -> ?", ["15", "19", "18", "17"], "18"],
  ] as Array<[string, string[], string]>) {
    const v = numberAnalogyVerdict(prompt, options, answer);
    assert.equal(v.handled, true);
    assert.equal(v.valid, true, prompt);
  }
});

// ── Upheld: the real defects, which must still be rejected ───────────────────

test("still REJECTS a circular puzzle — the setup already answers the question", () => {
  const v = numberPuzzleVerdict("IF  8+1=0,  8+5=32,  9+2=9\nTHEN  8+5 = ?", ["34", "33", "32", "31"], "32");
  assert.equal(v.handled, true);
  assert.equal(v.valid, false);
  assert.match((v as any).reason, /circular/);
});

test("still REJECTS a circular analogy", () => {
  const v = numberAnalogyVerdict("WHICH NUMBER FITS?\n3 -> 7,   5 -> 13,   3 -> ?", ["7", "9", "10", "13"], "7");
  assert.equal(v.handled, true);
  assert.equal(v.valid, false);
  assert.match((v as any).reason, /circular/);
});

test("REJECTS a stated answer that no consistent rule produces", () => {
  // Rule is plainly (a+b)*2, so 9+6 is 30. Claiming 33 is simply wrong.
  const v = numberPuzzleVerdict("IF  5+5=20,  1+3=8,  8+4=24\nTHEN  9+6 = ?", ["32", "33", "30", "40"], "33");
  assert.equal(v.handled, true);
  assert.equal(v.valid, false);
  assert.match((v as any).reason, /not produced by any rule/);
});

test("REJECTS a genuinely under-determined item — two options both reachable", () => {
  // One worked example only constrains so much: a+b and a*b both give 4 for 2+2, and
  // both 5 and 4 are on the option list, so the viewer cannot know which is meant.
  const v = numberPuzzleVerdict("IF  2+2=4,  3+3=9\nTHEN  1+4 = ?", ["5", "4", "7", "8"], "4");
  assert.equal(v.handled, true);
  assert.equal(v.valid, false);
  assert.match((v as any).reason, /under-determined/);
});

// ── Fails open: anything it cannot decide goes back to the rubric ────────────

test("FAILS OPEN rather than rejecting what it does not understand", () => {
  // The dangerous direction is a verifier that rejects an item whose rule is simply
  // outside its family. Everything unrecognisable must be handed to the rubric instead.
  const unhandled = [
    q("VERBAL ANALOGY", "PILOT IS TO AIRPLANE AS CHEF IS TO ______?", ["KITCHEN", "OVEN", "BAKERY"], "KITCHEN"),
    q("NUMBER SERIES", "WHAT COMES NEXT?", ["25"], "25"),
    q("NUMBER PUZZLE", "IF  A+B=C\nTHEN  D+E = ?", ["1", "2", "3"], "1"), // no numbers to fit
    q("NUMBER PUZZLE", "IF  5+5=20\nTHEN  9+6 = ?", ["30", "31", "32"], "30"), // one example is not enough
    q("NUMBER ANALOGY", "WHICH NUMBER FITS?\n3 -> 7,   5 -> ?", ["13"], "13"), // options not a real set
    q("NUMBER PUZZLE", "IF  5+5=20,  1+3=8,  8+4=24\nTHEN  9+6 = ?", ["thirty", "33"], "thirty"), // non-numeric options
  ];
  for (const item of unhandled) assert.equal(quantVerdict(item).handled, false, item.prompt);
});

test("claims ONLY the two mechanical tiers, and only text questions", () => {
  assert.equal(quantVerdict(q("ODD ONE OUT", "IF  5+5=20,  1+3=8,  8+4=24\nTHEN  9+6 = ?", ["30", "1", "2"], "30")).handled, false);
  const shape = { ...q("NUMBER PUZZLE", "IF  5+5=20,  1+3=8,  8+4=24\nTHEN  9+6 = ?", ["30", "1", "2"], "30"), kind: "fold" };
  assert.equal(quantVerdict(shape as any).handled, false, "shape questions belong to the structural checker");
});

test("is TOTAL — a malformed question can never throw it", () => {
  for (const bad of [null, undefined, {}, { kind: "text" }, { kind: "text", tier: "NUMBER PUZZLE" },
                     { kind: "text", tier: "NUMBER PUZZLE", prompt: null, options: null, answer: null }]) {
    assert.doesNotThrow(() => quantVerdict(bad as any));
    assert.equal(quantVerdict(bad as any).handled, false);
  }
});
