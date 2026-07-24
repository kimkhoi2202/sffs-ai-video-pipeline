import { test } from "node:test";
import assert from "node:assert/strict";
import { mapProps } from "./render.ts";
import { showTierPill } from "../../remotion/src/components/headerPillVisibility.ts";

/**
 * Regression guard for the empty category pill (the blank green header pill that
 * shipped on odd-one-out / number-series videos). The loop's render mapper MUST
 * carry the tier/category label onto EVERY mapped question — it previously
 * dropped it for `text` and `numseries`, leaving q.tier undefined so HeaderPills
 * rendered an empty capsule — and the pill must hide itself when no label exists.
 */

// Minimal figure payloads carrying only the fields mapShapeQuestion reads.
const foldFig = {
  kind: "fold", countdown: 6, ansLetter: "A", ansLabel: "1 hole",
  explanation: "unfolds to one hole", prompt: "WHAT DOES IT LOOK LIKE UNFOLDED?",
  grid: 4, folds: ["right"], punches: [{ r: 0, c: 0 }],
  options: [
    { letter: "A", holes: [{ r: 0, c: 0 }] },
    { letter: "B", holes: [{ r: 1, c: 1 }] },
    { letter: "C", holes: [{ r: 2, c: 2 }] },
  ],
};
const fig = (shape: string) => ({ shape });
const oddFig = {
  kind: "figure-odd", countdown: 6, ansLetter: "A", ansLabel: "the circle",
  explanation: "the others match", prompt: "WHICH SHAPE DOES NOT BELONG?",
  options: [
    { letter: "A", fig: fig("circle") },
    { letter: "B", fig: fig("square") },
    { letter: "C", fig: fig("square") },
  ],
};

const loopQs = [
  { kind: "text", tier: "ODD ONE OUT", prompt: "which one does not belong", options: ["drum", "guitar", "harp", "hawk"], answer: "hawk" },
  { kind: "numseries", tier: "NUMBER SERIES", prompt: "what comes next", seq: ["4", "17", "30", "43"], answer: "56" },
  { kind: "fold", tier: "PAPER FOLDING", prompt: foldFig.prompt, answer: "1 hole", figure: foldFig },
  { kind: "figure-odd", tier: "VISUAL ODD ONE OUT", prompt: oddFig.prompt, answer: "the circle", figure: oddFig },
];

test("mapProps carries a non-empty tier/category label onto every question kind", () => {
  const { questions } = mapProps({ questions: loopQs, reveal: "all", narration: { mode: "none" }, countdownSec: 5 });
  assert.equal(questions.length, loopQs.length);
  questions.forEach((q: any, i: number) => {
    assert.equal(typeof q.tier, "string", `Q${i} (${q.kind}) tier must be a string`);
    assert.ok(q.tier.trim().length > 0, `Q${i} (${q.kind}) tier must be non-empty`);
    assert.equal(q.tier, loopQs[i].tier, `Q${i} (${q.kind}) tier must match its source label`);
    assert.ok(showTierPill(q.tier), `Q${i} (${q.kind}) header pill must render`);
  });
});

test("showTierPill hides the pill when there is no real label", () => {
  assert.equal(showTierPill(undefined), false);
  assert.equal(showTierPill(null), false);
  assert.equal(showTierPill(""), false);
  assert.equal(showTierPill("   "), false);
  assert.equal(showTierPill("ODD ONE OUT"), true);
  assert.equal(showTierPill("NUMBER SERIES"), true);
});
