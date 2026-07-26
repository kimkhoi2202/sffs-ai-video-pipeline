/**
 * rawtext.test.ts — the raw-text bank re-import.
 *
 * The bank used to store only normalized dedup keys and the renderer displayed them,
 * so "2/3" reached the screen as "2 3", "$1.00" as "1 00", "CAN'T TELL" as "can t
 * tell", multi-line syllogisms arrived as one line, and every fill-in-the-blank lost
 * its "______". These tests pin the fix end to end:
 *
 *   1. toHermesQ prefers the RAW fields and the characters survive verbatim.
 *   2. AUTHORED option order survives (payloadNorm's order is alphabetically sorted).
 *   3. Entries WITHOUT raw fields still work — the *Norm fallback is unchanged, which
 *      is what keeps the change safe for anything banked before the re-import.
 *   4. sig/hash are passed straight through (the never-repeat guarantee keys off them).
 *   5. render.ts prefers the AUTHORED explanation and only falls back to its template.
 *
 * Hermetic: config points at a tmp REPO/DATA dir before the modules are imported.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-rawtext-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;
mkdirSync(join(TMP, "content"), { recursive: true });
writeFileSync(join(TMP, "content", "master-question-bank.json"), JSON.stringify({ entries: [] }));

const Q = await import("./questions.ts");
const R = await import("./render.ts");

/** A bank entry as the re-import writes it: lossy *Norm keys PLUS raw authored text. */
const MILO = {
  sig: "text|verbal|logic|all cats purr milo is a cat so milo purrs || can t tell~false~true|true",
  hash: "abc123abc123",
  kind: "text",
  category: "verbal",
  tier: "LOGIC",
  promptNorm: "all cats purr milo is a cat so milo purrs",
  payloadNorm: "all cats purr milo is a cat so milo purrs || can t tell~false~true",
  answerNorm: "true",
  prompt: "ALL CATS PURR.\nMILO IS A CAT.\nSO MILO PURRS.",
  options: ["TRUE", "FALSE", "CAN'T TELL"],
  answer: "TRUE",
  explanation: "If every cat purrs and Milo is a cat, then Milo must purr.",
};

const FRACTION = {
  sig: "text|quantitative|compare|which is the greatest || 2 3~3 5~5 8~7 12|2 3",
  hash: "def456def456",
  kind: "text",
  category: "quantitative",
  tier: "COMPARE",
  promptNorm: "which is the greatest",
  payloadNorm: "which is the greatest || 2 3~3 5~5 8~7 12",
  answerNorm: "2 3",
  prompt: "WHICH IS THE GREATEST?",
  options: ["2/3", "5/8", "3/5", "7/12"], // AUTHORED order; payloadNorm's is sorted
  answer: "2/3",
  explanation: "Two thirds is the largest, since it is the closest one to a whole.",
};

const LETTERS = {
  sig: "numseries|verbal|letter-series|A~B~D~G|k",
  hash: "aaa111aaa111",
  kind: "numseries",
  category: "verbal",
  tier: "LETTER SERIES",
  promptNorm: "what comes next",
  payloadNorm: "A~B~D~G",
  answerNorm: "k",
  prompt: "WHAT COMES NEXT?",
  seq: ["A", "B", "D", "G"],
  answer: "K",
  explanation: "The gaps grow by one: 1, then 2, then 3, then 4, so G plus 4 letters is K.",
};

/** The same Milo entry as it existed BEFORE the re-import: dedup keys only. */
const MILO_LEGACY = {
  sig: MILO.sig, hash: MILO.hash, kind: "text", category: "verbal", tier: "LOGIC",
  promptNorm: MILO.promptNorm, payloadNorm: MILO.payloadNorm, answerNorm: MILO.answerNorm,
};

// ── 1. characters survive ────────────────────────────────────────────────────
test("raw prompt keeps newlines, apostrophes and terminal punctuation", () => {
  const q = Q.toHermesQ(MILO as any);
  assert.ok(q);
  assert.equal(q!.prompt, "ALL CATS PURR.\nMILO IS A CAT.\nSO MILO PURRS.");
  assert.equal(q!.prompt.split("\n").length, 3, "the syllogism must stay three lines");
  assert.ok(q!.options!.includes("CAN'T TELL"), "the apostrophe must survive");
  assert.ok(!q!.options!.includes("can t tell"), "must not fall back to the mangled key");
});

test("raw options keep slashes, decimals, dollars and percents", () => {
  const q = Q.toHermesQ(FRACTION as any);
  assert.ok(q);
  assert.deepEqual(q!.options, ["2/3", "5/8", "3/5", "7/12"]);
  assert.equal(q!.answer, "2/3");
  const money = Q.toHermesQ({
    ...FRACTION,
    sig: "s2", hash: "h2",
    prompt: "A $40 TOY IS 25% OFF TODAY.\nWHAT IS THE SALE PRICE?",
    options: ["$35", "$32", "$30", "$10"], answer: "$30", answerNorm: "30",
    payloadNorm: "a 40 toy is 25 off today what is the sale price || 10~30~32~35",
  } as any);
  assert.ok(money);
  assert.deepEqual(money!.options, ["$35", "$32", "$30", "$10"]);
  assert.equal(money!.answer, "$30");
});

test("fill-in-the-blank keeps its ______ and is allowed up to the new 110 budget", () => {
  const prompt = "THE LIBRARY WAS SO QUIET THAT EVEN A\nWHISPER SEEMED ______, SO EVERYONE\nTRIED HARD NOT TO MAKE A SOUND.";
  assert.equal(prompt.length, 103, "this is the longest authored prompt in the bank");
  assert.ok(prompt.length > 92, "it would have been dropped under the old 92 budget");
  const q = Q.toHermesQ({
    sig: "sc1", hash: "hsc1", kind: "text", category: "verbal", tier: "SENTENCE COMPLETION",
    promptNorm: "the library was so quiet", payloadNorm: "x || colorful~expensive~heavy~loud", answerNorm: "loud",
    prompt, options: ["HEAVY", "LOUD", "COLORFUL", "EXPENSIVE"], answer: "LOUD",
    explanation: "In a place that quiet, even a tiny whisper stands out and seems loud.",
  } as any);
  assert.ok(q, "a 103-char authored prompt must survive the length guard");
  assert.ok(q!.prompt.includes("______"), "the blank must reach the screen");
});

test("a prompt beyond the length budget is still rejected", () => {
  const q = Q.toHermesQ({ ...MILO, sig: "long", hash: "hlong", prompt: "X".repeat(Q.LIMITS.maxPrompt + 1) } as any);
  assert.equal(q, null);
});

// ── 2. authored option order ─────────────────────────────────────────────────
test("AUTHORED option order is preserved, not payloadNorm's alphabetical order", () => {
  const q = Q.toHermesQ(FRACTION as any);
  const sortedByKey = FRACTION.payloadNorm.split(" || ")[1].split("~");
  assert.deepEqual(sortedByKey, ["2 3", "3 5", "5 8", "7 12"], "the dedup key is sorted");
  assert.deepEqual(q!.options, ["2/3", "5/8", "3/5", "7/12"], "the render order is the authored one");
  assert.notDeepEqual(q!.options!.map((o) => o.replace("/", " ")), sortedByKey);
});

test("the answer still resolves to exactly one option after re-ordering", () => {
  const mapped = R.mapProps({ questions: [{ kind: "text", tier: FRACTION.tier, prompt: FRACTION.prompt, options: FRACTION.options, answer: FRACTION.answer }] });
  const q = mapped.questions[0];
  assert.equal(q.ansLabel, "2/3");
  assert.equal(q.ansLetter, "A", "2/3 is authored first, so it is option A");
  assert.deepEqual(q.options.map((o: any) => o.text), ["2/3", "5/8", "3/5", "7/12"]);
});

// ── 3. back-compat: entries with no raw fields ───────────────────────────────
test("an entry with NO raw fields still loads from the *Norm keys", () => {
  const q = Q.toHermesQ(MILO_LEGACY as any);
  assert.ok(q, "pre-re-import entries must keep working");
  assert.equal(q!.prompt, "all cats purr milo is a cat so milo purrs");
  assert.deepEqual(q!.options, ["can t tell", "false", "true"]);
  assert.equal(q!.explanation, undefined);
});

test("raw and normalized paths are not mixed (raw answer never matched against normalized options)", () => {
  // Raw answer present but no raw prompt/options: must use the *Norm pair for both,
  // and still find exactly one match (norm() lowercases both sides).
  const q = Q.toHermesQ({ ...MILO_LEGACY, answer: "TRUE" } as any);
  assert.ok(q);
  assert.deepEqual(q!.options, ["can t tell", "false", "true"]);
});

// ── 4. sig/hash untouched ────────────────────────────────────────────────────
test("sig and hash pass through byte-identical", () => {
  for (const e of [MILO, FRACTION, LETTERS]) {
    const q = Q.toHermesQ(e as any);
    assert.equal(q!.sig, e.sig);
    assert.equal(q!.hash, e.hash);
  }
});

// ── 5. numseries ─────────────────────────────────────────────────────────────
test("numseries keeps its '?' prompt and its answer's case", () => {
  const q = Q.toHermesQ(LETTERS as any);
  assert.ok(q);
  assert.equal(q!.prompt, "WHAT COMES NEXT?", "the '?' was stripped by promptNorm");
  assert.equal(q!.answer, "K", "answerNorm had lowercased this to 'k'");
  assert.deepEqual(q!.seq, ["A", "B", "D", "G"]);
});

// ── 6. explanations ──────────────────────────────────────────────────────────
test("the AUTHORED explanation reaches the reveal plate", () => {
  const q = Q.toHermesQ(LETTERS as any)!;
  const mapped = R.mapProps({ questions: [q] });
  assert.equal(mapped.questions[0].explanation, LETTERS.explanation);
});

test("the generated template is used ONLY when the bank has no explanation", () => {
  const mapped = R.mapProps({ questions: [{ kind: "numseries", tier: "NUMBER SERIES", prompt: "what comes next?", seq: ["5", "10", "15", "20"], answer: "25" }] });
  assert.equal(mapped.questions[0].explanation, "the numbers climb by 5 each step");
});

test("two different questions no longer share one explanation", () => {
  // The exact regression: the template collapses every non-arithmetic series to
  // "spot the pattern to crack the sequence", so answers 53 and K got the same copy.
  const templated = R.mapProps({
    questions: [
      { kind: "numseries", tier: "NUMBER SERIES", prompt: "what comes next?", seq: ["2", "3", "5", "11"], answer: "53" },
      { kind: "numseries", tier: "LETTER SERIES", prompt: "what comes next?", seq: ["A", "B", "D", "G"], answer: "K" },
    ],
  });
  assert.equal(
    templated.questions[0].explanation,
    templated.questions[1].explanation,
    "without authored text the template really does collide (this is the bug)",
  );

  const authored = R.mapProps({
    questions: [
      { kind: "numseries", tier: "NUMBER SERIES", prompt: "what comes next?", seq: ["2", "3", "5", "11"], answer: "53", explanation: "Each step squares the last number and subtracts: 11 squared is 121, and the rule lands on 53." },
      { kind: "numseries", tier: "LETTER SERIES", prompt: "what comes next?", seq: ["A", "B", "D", "G"], answer: "K", explanation: LETTERS.explanation },
    ],
  });
  assert.notEqual(authored.questions[0].explanation, authored.questions[1].explanation);
  assert.ok(authored.questions[1].explanation.includes("K"), "the explanation should reference its own answer");
});

test("the reveal VO speaks the authored explanation", () => {
  // reveal:"all" is the full-reveal arm; the default ("last") skips the final
  // question's reveal, and a one-question video is all final question.
  const mapped = R.mapProps({ questions: [Q.toHermesQ(MILO as any)!], reveal: "all" });
  const spoken = mapped.reveals.map((r: any) => r.text).join(" ");
  assert.ok(spoken.includes("Milo"), `reveal VO should carry the authored line, got: ${spoken}`);
});
