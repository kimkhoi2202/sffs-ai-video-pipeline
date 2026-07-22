/**
 * shapes.test.ts — the nonverbal SHAPE/FIGURE eligibility path (paper-folding +
 * the figure-matrix family). Proves the new bank->loop->render wiring:
 *   1. toHermesQ reconstructs fold/matrix/analogy2/figure-odd HermesQ from a bank
 *      entry's `figure` field, with structural guards (rejects malformed figures).
 *   2. candidateQuestions offers the shape kinds ONLY when explicitly requested
 *      (default kinds still = text/numseries, so existing behavior is unchanged).
 *   3. render.ts mapProps maps a fold + a matrix HermesQ onto the FullVideo Short
 *      Question shape: fold.ansHoles = unfold(folds,punches,grid); matrix.ans =
 *      the ansLetter option's fig; shape videos use no-options-vo narration.
 *
 * Hermetic: points config at a tmp REPO/DATA dir (bank + ledgers) BEFORE the
 * modules are imported; no network, no TTS, no render.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── isolate config/bank/ledger to a tmp dir BEFORE importing the modules ──────
const TMP = mkdtempSync(join(tmpdir(), "hermes-shapes-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env"); // never load a real env file
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

// A fold entry: one LEFT fold (V crease) + a punch at (1,0). Unfolding mirrors
// the punch across the vertical crease -> holes {1,0} and {1,3}. Option A is that
// correct pattern; the others are wrong.
const FOLD_ENTRY = {
  sig: "fold|nonverbal|paper-folding|test-fold|2 holes",
  hash: "hfold1",
  kind: "fold",
  category: "nonverbal",
  tier: "PAPER FOLDING",
  promptNorm: "what does it look like unfolded",
  payloadNorm: "fold:test",
  answerNorm: "2 holes",
  figure: {
    id: 1,
    kind: "fold",
    category: "nonverbal",
    difficulty: "easy",
    tier: "PAPER FOLDING",
    countdown: 6,
    grid: 4,
    prompt: "WHAT DOES IT LOOK LIKE UNFOLDED?",
    folds: ["left"],
    punches: [{ r: 1, c: 0 }],
    options: [
      { letter: "A", holes: [{ r: 1, c: 0 }, { r: 1, c: 3 }] },
      { letter: "B", holes: [{ r: 1, c: 0 }] },
      { letter: "C", holes: [{ r: 1, c: 0 }, { r: 1, c: 1 }] },
      { letter: "D", holes: [{ r: 0, c: 0 }, { r: 3, c: 0 }] },
    ],
    ansLetter: "A",
    ansLabel: "2 HOLES",
    explanation: "The fold mirrors the hole across the crease, so one punch becomes two.",
  },
};

// A matrix entry: the count doubles (1 star -> 2 stars), so 1 heart -> 2 hearts.
// The correct option is A (two hearts).
const MATRIX_ENTRY = {
  sig: "matrix|nonverbal|figure-matrix|test-matrix|two hearts",
  hash: "hmatrix1",
  kind: "matrix",
  category: "nonverbal",
  tier: "FIGURE MATRIX",
  promptNorm: "which shape completes the grid",
  payloadNorm: "matrix:test",
  answerNorm: "two hearts",
  figure: {
    idx: 1101,
    kind: "matrix",
    tier: "FIGURE MATRIX",
    category: "nonverbal",
    countdown: 7,
    prompt: "WHICH SHAPE COMPLETES THE GRID?",
    cells: [
      { shape: "star", filled: true, count: 1 },
      { shape: "star", filled: true, count: 2 },
      { shape: "heart", filled: true, count: 1 },
    ],
    options: [
      { letter: "A", fig: { shape: "heart", filled: true, count: 2 } },
      { letter: "B", fig: { shape: "heart", filled: true, count: 1 } },
      { letter: "C", fig: { shape: "heart", filled: true, count: 3 } },
      { letter: "D", fig: { shape: "star", filled: true, count: 2 } },
    ],
    ansLetter: "A",
    ansLabel: "TWO HEARTS",
    explanation: "The count doubles while the shape stays the same, so one heart becomes two.",
  },
};

// A text entry so we can prove the default candidate pool is UNCHANGED.
const TEXT_ENTRY = {
  sig: "t1", hash: "ht1", kind: "text", category: "verbal", tier: "ODD ONE OUT",
  payloadNorm: "which word does not belong || apple~banana~cherry~rock", answerNorm: "rock",
};

mkdirSync(join(TMP, "content"), { recursive: true });
writeFileSync(
  join(TMP, "content", "master-question-bank.json"),
  JSON.stringify({ entries: [TEXT_ENTRY, FOLD_ENTRY, MATRIX_ENTRY] }),
);

const Q = await import("./questions.ts");
const R = await import("./render.ts");
const { unfold } = await import("../../remotion/src/data/fold.ts");

const clone = <T>(o: T): T => JSON.parse(JSON.stringify(o));
/** A loop render-question (design.ts renderQuestions shape) from a HermesQ. */
const toLoopQ = (q: any) => ({ kind: q.kind, tier: q.tier, prompt: q.prompt, answer: q.answer, figure: q.figure });

// ── toHermesQ: reconstructs a valid shape HermesQ ─────────────────────────────
test("toHermesQ builds a FOLD HermesQ from the figure field", () => {
  const q = Q.toHermesQ(clone(FOLD_ENTRY) as any);
  assert.ok(q, "fold entry -> HermesQ");
  assert.equal(q!.kind, "fold");
  assert.equal(q!.sig, FOLD_ENTRY.sig);
  assert.ok(q!.figure, "carries the structured figure payload");
  assert.equal(q!.figure!.kind, "fold");
  assert.equal(Q.shapeStructuralIssue(q!), null, "structurally valid");
});

test("toHermesQ builds a MATRIX HermesQ from the figure field", () => {
  const q = Q.toHermesQ(clone(MATRIX_ENTRY) as any);
  assert.ok(q, "matrix entry -> HermesQ");
  assert.equal(q!.kind, "matrix");
  assert.equal(q!.figure!.ansLetter, "A");
  assert.equal(Q.shapeStructuralIssue(q!), null);
});

// ── toHermesQ: structural guards reject malformed figures ─────────────────────
test("toHermesQ rejects a shape entry with NO figure payload", () => {
  const bad = clone(FOLD_ENTRY) as any;
  delete bad.figure;
  assert.equal(Q.toHermesQ(bad), null);
});

test("toHermesQ rejects a fold whose ansLetter matches no option", () => {
  const bad = clone(FOLD_ENTRY) as any;
  bad.figure.ansLetter = "Z"; // not A-D
  assert.equal(Q.toHermesQ(bad), null);
});

test("toHermesQ rejects a fold with too few options", () => {
  const bad = clone(FOLD_ENTRY) as any;
  bad.figure.options = bad.figure.options.slice(0, 2); // only 2 (< minOptions 3)
  assert.equal(Q.toHermesQ(bad), null);
});

test("toHermesQ rejects a matrix missing a valid cells trio", () => {
  const bad = clone(MATRIX_ENTRY) as any;
  bad.figure.cells = [{ shape: "star" }]; // wrong length
  assert.equal(Q.toHermesQ(bad), null);
});

test("toHermesQ rejects a matrix whose figure.kind disagrees with entry.kind", () => {
  const bad = clone(MATRIX_ENTRY) as any;
  bad.figure.kind = "analogy2";
  assert.equal(Q.toHermesQ(bad), null);
});

// ── candidateQuestions: shape kinds are opt-in ────────────────────────────────
test("candidateQuestions offers shape kinds only when requested", () => {
  const shapes = Q.candidateQuestions({ category: "nonverbal", kinds: ["fold", "matrix"], seed: "s" });
  const kinds = shapes.map((q) => q.kind).sort();
  assert.deepEqual([...new Set(kinds)].sort(), ["fold", "matrix"]);
  assert.equal(shapes.length, 2);
});

test("candidateQuestions default pool EXCLUDES shape kinds (unchanged behavior)", () => {
  const def = Q.candidateQuestions({ seed: "s" });
  assert.ok(!def.some((q) => q.kind === "fold" || q.kind === "matrix"), "no shapes in default pool");
  assert.ok(def.some((q) => q.kind === "text"), "text still offered");
});

// ── mapProps: fold + matrix -> FullVideo Short Question shape ──────────────────
test("mapProps maps a FOLD onto the Short shape with derived ansHoles", () => {
  const fold = Q.toHermesQ(clone(FOLD_ENTRY) as any)!;
  const mapped = R.mapProps({ reveal: "all", countdownSec: 5, narration: { mode: "full" }, questions: [toLoopQ(fold)] });
  const q = mapped.questions[0];
  assert.equal(q.kind, "fold");
  assert.equal(q.idx, 0);
  assert.equal(q.countdown, 6, "uses the figure's authored countdown");
  assert.equal(q.grid, 4);
  assert.equal(q.ansLetter, "A");
  assert.equal(q.ansLabel, "2 HOLES");
  // ansHoles is DERIVED (not in the bank) via unfold(folds, punches, grid)
  assert.deepEqual(q.ansHoles, unfold(["left"], [{ r: 1, c: 0 }], 4));
  assert.deepEqual(q.ansHoles, [{ r: 1, c: 0 }, { r: 1, c: 3 }]);
  // every option renders as an unfolded hole grid
  assert.equal(q.options.length, 4);
  assert.ok(q.options.every((o: any) => Array.isArray(o.holes)));
});

test("mapProps maps a MATRIX onto the Short shape with ans = ansLetter option's fig", () => {
  const matrix = Q.toHermesQ(clone(MATRIX_ENTRY) as any)!;
  const mapped = R.mapProps({ reveal: "all", countdownSec: 5, narration: { mode: "full" }, questions: [toLoopQ(matrix)] });
  const q = mapped.questions[0];
  assert.equal(q.kind, "matrix");
  assert.equal(q.cells.length, 3);
  assert.equal(q.options.length, 4);
  // ans (the reveal figure) == the fig of the option whose letter == ansLetter
  assert.deepEqual(q.ans, { shape: "heart", filled: true, count: 2 });
  assert.ok(q.options.every((o: any) => o.fig && typeof o.fig.shape === "string"));
});

test("mapProps maps a mixed fold+matrix video (both kinds in one Short)", () => {
  const fold = Q.toHermesQ(clone(FOLD_ENTRY) as any)!;
  const matrix = Q.toHermesQ(clone(MATRIX_ENTRY) as any)!;
  const mapped = R.mapProps({ reveal: "all", countdownSec: 5, narration: { mode: "full" }, questions: [toLoopQ(fold), toLoopQ(matrix)] });
  assert.equal(mapped.questions.length, 2);
  assert.deepEqual(mapped.questions.map((q: any) => q.kind), ["fold", "matrix"]);
  assert.deepEqual(mapped.questions.map((q: any) => q.idx), [0, 1]);
});

// ── mapProps: shape-safe narration (never TTS figure options) ──────────────────
test("mapProps DOWNGRADES full/no-question-vo to no-options-vo for shape videos", () => {
  const fold = Q.toHermesQ(clone(FOLD_ENTRY) as any)!;
  for (const requested of ["full", "no-question-vo"]) {
    const mapped = R.mapProps({ reveal: "all", narration: { mode: requested }, questions: [toLoopQ(fold)] });
    assert.equal(mapped.mode, "no-options-vo", `${requested} -> no-options-vo`);
    assert.equal(mapped.readVO, "full");
  }
});

test("mapProps leaves music-only (none) narration untouched for shapes", () => {
  const fold = Q.toHermesQ(clone(FOLD_ENTRY) as any)!;
  const mapped = R.mapProps({ reveal: "none", narration: { mode: "none" }, questions: [toLoopQ(fold)] });
  assert.equal(mapped.mode, "none");
  assert.equal(mapped.readVO, "none");
  assert.equal(mapped.reveals.length, 0, "reveal=none -> no reveal beats -> no TTS");
});

test("mapProps does NOT downgrade a pure text video (no-question-vo preserved)", () => {
  const text = Q.toHermesQ(clone(TEXT_ENTRY) as any)!;
  const mapped = R.mapProps({
    reveal: "all",
    narration: { mode: "no-question-vo" },
    questions: [{ kind: text.kind, tier: text.tier, prompt: text.prompt, options: text.options, answer: text.answer }],
  });
  assert.equal(mapped.mode, "no-question-vo", "text videos keep the requested mode");
});
