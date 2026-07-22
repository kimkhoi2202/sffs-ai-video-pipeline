/**
 * questions.test.ts — fuzzy near-duplicate guard (Work item 1).
 *
 * Proves the LOAD-TIME fuzzy signature catches paraphrases, reordered options,
 * and structurally-identical (proportional) number series that the exact `sig`
 * is blind to, WITHOUT over-rejecting genuinely different questions — and that
 * `candidateQuestions` uses it as a SECOND dedup key (within-pool + vs the used
 * ledger) while exact-sig behavior is unchanged.
 *
 * Hermetic: points config at a tmp REPO/DATA dir (bank + ledgers) BEFORE the
 * module is imported; no network/real bank.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesQ } from "./state.ts";

// ── isolate config/bank/ledger to a tmp dir BEFORE importing the module ───────
const TMP = mkdtempSync(join(tmpdir(), "hermes-questions-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env"); // never load a real env file
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

// n1/n2 = proportional arithmetic series (near-dup); n3 = different shape.
// t1/t2 = same option-set + answer, different prompt + option order (near-dup);
// t3 = different option set.
const BANK_ENTRIES = [
  { sig: "n1", hash: "hn1", kind: "numseries", category: "quantitative", tier: "A", promptNorm: "what comes next?", payloadNorm: "5~10~15~20", answerNorm: "25" },
  { sig: "n2", hash: "hn2", kind: "numseries", category: "quantitative", tier: "A", promptNorm: "what comes next?", payloadNorm: "10~20~30~40", answerNorm: "50" },
  { sig: "n3", hash: "hn3", kind: "numseries", category: "quantitative", tier: "A", promptNorm: "what comes next?", payloadNorm: "2~4~8~16", answerNorm: "32" },
  { sig: "t1", hash: "ht1", kind: "text", category: "verbal", tier: "A", payloadNorm: "which word does not belong || apple~banana~cherry~rock", answerNorm: "rock" },
  { sig: "t2", hash: "ht2", kind: "text", category: "verbal", tier: "A", payloadNorm: "pick the odd one out || rock~cherry~banana~apple", answerNorm: "rock" },
  { sig: "t3", hash: "ht3", kind: "text", category: "verbal", tier: "A", payloadNorm: "which is not a color || red~blue~green~dog", answerNorm: "dog" },
];
mkdirSync(join(TMP, "content"), { recursive: true });
writeFileSync(join(TMP, "content", "master-question-bank.json"), JSON.stringify({ entries: BANK_ENTRIES }));

const Q = await import("./questions.ts");

/** Overwrite the loop's used-sigs ledger (loadUsedSigs re-reads it each call). */
function setUsed(sigs: string[]): void {
  writeFileSync(join(TMP, "hermes-used-sigs.json"), JSON.stringify({ sigs }));
}

const textQ = (over: Partial<HermesQ>): HermesQ => ({
  sig: "s", hash: "h", kind: "text", category: "verbal", tier: "A",
  prompt: "which does not belong", options: ["apple", "banana", "cherry", "rock"], answer: "rock", ...over,
});
const numQ = (over: Partial<HermesQ>): HermesQ => ({
  sig: "s", hash: "h", kind: "numseries", category: "quantitative", tier: "A",
  prompt: "what comes next?", seq: ["5", "10", "15", "20"], answer: "25", ...over,
});

// ── fuzzySig: catches near-dups ───────────────────────────────────────────────
test("fuzzySig collapses a PARAPHRASE + REORDERED options (text)", () => {
  const a = textQ({ prompt: "which word does not belong", options: ["apple", "banana", "cherry", "rock"], answer: "rock" });
  const b = textQ({ prompt: "pick the odd one out here", options: ["rock", "cherry", "banana", "apple"], answer: "rock" });
  assert.equal(Q.fuzzySig(a), Q.fuzzySig(b));
});

test("fuzzySig collapses SAME-STEP series (5 10 15 20 == 10 20 30 40)", () => {
  const s1 = numQ({ seq: ["5", "10", "15", "20"], answer: "25" });
  const s2 = numQ({ seq: ["10", "20", "30", "40"], answer: "50" });
  assert.equal(Q.fuzzySig(s1), Q.fuzzySig(s2));
});

test("fuzzySig: an EXACT duplicate produces the same fuzzy sig", () => {
  const a = textQ({});
  assert.equal(Q.fuzzySig(a), Q.fuzzySig({ ...a, sig: "other", hash: "other" }));
});

// ── fuzzySig: does NOT over-reject genuinely different questions ───────────────
test("fuzzySig keeps genuinely DIFFERENT text distinct (different option set)", () => {
  const a = textQ({ options: ["apple", "banana", "cherry", "rock"], answer: "rock" });
  const c = textQ({ options: ["apple", "banana", "cherry", "dog"], answer: "dog" });
  assert.notEqual(Q.fuzzySig(a), Q.fuzzySig(c));
});

test("fuzzySig keeps text with same options but DIFFERENT answer distinct", () => {
  const a = textQ({ options: ["apple", "banana", "cherry", "rock"], answer: "rock" });
  const b = textQ({ options: ["apple", "banana", "cherry", "rock"], answer: "apple" });
  assert.notEqual(Q.fuzzySig(a), Q.fuzzySig(b));
});

test("fuzzySig keeps different series SHAPES distinct (arithmetic vs geometric)", () => {
  const arith = numQ({ seq: ["5", "10", "15", "20"], answer: "25" });
  const geo = numQ({ seq: ["2", "4", "8", "16"], answer: "32" });
  assert.notEqual(Q.fuzzySig(arith), Q.fuzzySig(geo));
});

test("fuzzySig keeps different LENGTH / DIRECTION series distinct", () => {
  const four = numQ({ seq: ["5", "10", "15", "20"], answer: "25" });
  const three = numQ({ seq: ["5", "10", "15"], answer: "20" });
  const desc = numQ({ seq: ["20", "15", "10", "5"], answer: "0" });
  assert.notEqual(Q.fuzzySig(four), Q.fuzzySig(three)); // length differs
  assert.notEqual(Q.fuzzySig(four), Q.fuzzySig(desc)); // sign/direction differs
});

test("fuzzySig never collides across kinds", () => {
  assert.notEqual(Q.fuzzySig(textQ({})), Q.fuzzySig(numQ({})));
});

// ── candidateQuestions: fuzzy as a SECOND key ─────────────────────────────────
test("candidateQuestions drops within-pool near-dups but keeps distinct ones", () => {
  setUsed([]);
  const pool = Q.candidateQuestions();
  const sigs = pool.map((q) => q.sig);
  // each near-dup pair collapses to exactly one survivor
  assert.equal(sigs.filter((s) => s === "n1" || s === "n2").length, 1);
  assert.equal(sigs.filter((s) => s === "t1" || s === "t2").length, 1);
  // the structurally-distinct questions are kept
  assert.ok(sigs.includes("n3"), "distinct series kept");
  assert.ok(sigs.includes("t3"), "distinct text kept");
  // no two returned candidates share a fuzzy signature
  const fs = pool.map((q) => Q.fuzzySig(q));
  assert.equal(new Set(fs).size, fs.length);
});

test("candidateQuestions excludes near-dups of an already-USED question", () => {
  setUsed(["n1"]); // mark the '5 10 15 20' series used
  const sigs = Q.candidateQuestions().map((q) => q.sig);
  assert.ok(!sigs.includes("n1"), "exact-used excluded (unchanged behavior)");
  assert.ok(!sigs.includes("n2"), "near-dup of used series excluded (new)");
  assert.ok(sigs.includes("n3"), "unrelated series still offered");
  setUsed([]);
});

test("candidateQuestions honors an explicit excludeFuzzy claim", () => {
  setUsed([]);
  const t3 = Q.candidateQuestions().find((q) => q.sig === "t3");
  assert.ok(t3, "t3 present before exclusion");
  const pool = Q.candidateQuestions({ excludeFuzzy: new Set([Q.fuzzySig(t3!)]) });
  assert.ok(!pool.some((q) => q.sig === "t3"), "excludeFuzzy removes the near-dup");
});

test("loadUsedFuzzySigs derives fuzzy sigs from the used ledger", () => {
  setUsed(["t1"]);
  const uf = Q.loadUsedFuzzySigs();
  const expected = Q.fuzzySig(textQ({ options: ["apple", "banana", "cherry", "rock"], answer: "rock" }));
  assert.ok(uf.has(expected));
  setUsed([]);
  assert.equal(Q.loadUsedFuzzySigs().size, 0);
});
