/**
 * gates.test.ts — dedup gate (exact + fuzzy near-duplicate) and the question-validity
 * gate's behaviour when the LLM rubric judge is UNREACHABLE.
 *
 * Proves gateDedup keeps its EXACT-sig behavior (used / in-batch / internal
 * duplicates -> "duplicate question(s) detected") AND adds a distinct
 * `near_duplicate` rejection for paraphrase / reordered-option / same-structure
 * variants, both within the batch and vs the used ledger — without re-flagging
 * exact duplicates as near-dups.
 *
 * Also proves validateQuestions DEGRADES instead of throwing when the judge is
 * unreachable (the 2026-07-25 incident, where a gateway budget 429 threw out of the
 * gate and killed 9 of 10 videos), while still rejecting structurally-broken ones.
 *
 * Hermetic: points config at a tmp REPO/DATA dir BEFORE importing the module, and
 * the LLM base URL at a closed local port so the "judge unreachable" path is real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermesQ } from "./state.ts";

const TMP = mkdtempSync(join(tmpdir(), "hermes-gates-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;
// gates.ts -> llm.ts eagerly constructs the OpenAI client; give it a dummy key so
// import succeeds. gateDedup makes NO network calls, so this is never used.
process.env.TFY_API_KEY = process.env.TFY_API_KEY || "test-dummy-key";
// Port 1 is never listening: every rubric call fails fast, exercising the real
// "judge unreachable" path end-to-end without stubbing the module graph.
process.env.TFY_LLM_BASE_URL = "http://127.0.0.1:1/v1";

// The bank is only needed so used exact-sigs can be resolved to fuzzy sigs.
const BANK_ENTRIES = [
  { sig: "u1", hash: "hu1", kind: "text", category: "verbal", tier: "A", payloadNorm: "which word does not belong || apple~banana~cherry~rock", answerNorm: "rock" },
];
mkdirSync(join(TMP, "content"), { recursive: true });
writeFileSync(join(TMP, "content", "master-question-bank.json"), JSON.stringify({ entries: BANK_ENTRIES }));

const G = await import("./gates.ts");
const Q = await import("./questions.ts");

function setUsed(sigs: string[]): void {
  writeFileSync(join(TMP, "hermes-used-sigs.json"), JSON.stringify({ sigs }));
}

const textQ = (over: Partial<HermesQ>): HermesQ => ({
  sig: "s", hash: "h", kind: "text", category: "verbal", tier: "A",
  prompt: "which does not belong", options: ["apple", "banana", "cherry", "rock"], answer: "rock", ...over,
});
const numQ = (over: Partial<HermesQ>): HermesQ => ({
  sig: "s", hash: "h", kind: "numseries", category: "quantitative", tier: "A",
  prompt: "what comes next?", seq: ["3", "6", "9", "12"], answer: "15", ...over,
});
const detail = (r: { detail?: unknown }) => r.detail as { dupUsed: string[]; dupBatch: string[]; dupInternal: string[]; nearDup: string[] };

test("gateDedup passes a fresh, unique, structurally-distinct batch", () => {
  setUsed([]);
  const r = G.gateDedup([textQ({ sig: "a" }), numQ({ sig: "b" })], new Set());
  assert.equal(r.pass, true);
  assert.equal(r.reason, "all questions fresh + unique");
  assert.deepEqual(detail(r).nearDup, []);
});

test("gateDedup still flags an EXACT internal duplicate (unchanged behavior)", () => {
  setUsed([]);
  const q = textQ({ sig: "dup" });
  const r = G.gateDedup([q, { ...q }], new Set());
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /duplicate question\(s\) detected/);
  assert.doesNotMatch(r.reason ?? "", /near_duplicate/); // exact dup is NOT re-labelled near
  assert.deepEqual(detail(r).dupInternal, ["dup"]);
  assert.deepEqual(detail(r).nearDup, []);
});

test("gateDedup flags an in-batch NEAR-duplicate (paraphrase + reordered options)", () => {
  setUsed([]);
  const a = textQ({ sig: "a", prompt: "which word does not belong", options: ["apple", "banana", "cherry", "rock"], answer: "rock" });
  const b = textQ({ sig: "b", prompt: "pick the odd one out", options: ["rock", "cherry", "banana", "apple"], answer: "rock" });
  const r = G.gateDedup([a, b], new Set());
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /near_duplicate question\(s\) detected/);
  assert.deepEqual(detail(r).dupInternal, []); // NOT an exact dup
  assert.deepEqual(detail(r).nearDup, ["b"]);
});

test("gateDedup flags a same-structure number series near-dup in a batch", () => {
  setUsed([]);
  const a = numQ({ sig: "a", seq: ["5", "10", "15", "20"], answer: "25" });
  const b = numQ({ sig: "b", seq: ["10", "20", "30", "40"], answer: "50" });
  const r = G.gateDedup([a, b], new Set());
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /near_duplicate/);
  assert.deepEqual(detail(r).nearDup, ["b"]);
});

test("gateDedup flags a NEAR-duplicate of an already-USED question", () => {
  setUsed(["u1"]); // u1 = apple/banana/cherry/rock -> rock
  const nearUsed = textQ({ sig: "x1", prompt: "spot the outsider", options: ["rock", "apple", "cherry", "banana"], answer: "rock" });
  const r = G.gateDedup([nearUsed], new Set());
  assert.equal(r.pass, false);
  assert.match(r.reason ?? "", /near_duplicate/);
  assert.deepEqual(detail(r).dupUsed, []); // not an EXACT used sig
  assert.deepEqual(detail(r).nearDup, ["x1"]);
  setUsed([]);
});

test("gateDedup keeps flagging EXACT used + in-batch-claimed sigs", () => {
  setUsed(["u1"]);
  const exactUsed = textQ({ sig: "u1" }); // same exact sig as the used bank entry
  const r1 = G.gateDedup([exactUsed], new Set());
  assert.equal(r1.pass, false);
  assert.deepEqual(detail(r1).dupUsed, ["u1"]);
  assert.deepEqual(detail(r1).nearDup, []); // exact used is not double-counted as near
  setUsed([]);

  const claimed = new Set(["a"]);
  const r2 = G.gateDedup([textQ({ sig: "a" })], claimed);
  assert.equal(r2.pass, false);
  assert.match(r2.reason ?? "", /duplicate question\(s\) detected/);
  assert.deepEqual(detail(r2).dupBatch, ["a"]);
  assert.deepEqual(detail(r2).nearDup, []);
});

// ── textStructuralIssue: the deterministic stand-in for the LLM rubric ───────

test("textStructuralIssue accepts well-formed text + numseries questions", () => {
  assert.equal(Q.textStructuralIssue(textQ({})), null);
  assert.equal(Q.textStructuralIssue(numQ({})), null);
});

test("textStructuralIssue enforces EXACTLY ONE correct answer", () => {
  // zero matches
  assert.match(
    Q.textStructuralIssue(textQ({ options: ["apple", "banana", "cherry"], answer: "rock" })) ?? "",
    /answer matches 0 option\(s\)/,
  );
  // two matches (a second correct option — the rubric's headline failure mode)
  assert.match(
    Q.textStructuralIssue(textQ({ options: ["rock", "rock ", "banana", "cherry"], answer: "rock" })) ?? "",
    /duplicate option\(s\)/,
  );
});

test("textStructuralIssue enforces the on-screen budgets and option count", () => {
  assert.match(Q.textStructuralIssue(textQ({ options: ["a", "b"] })) ?? "", /needs 3-4 options/);
  assert.match(Q.textStructuralIssue(textQ({ prompt: "x".repeat(200) })) ?? "", /prompt 200 chars/);
  assert.match(Q.textStructuralIssue(textQ({ options: ["y".repeat(40), "b", "c", "rock"] })) ?? "", /> 24 chars/);
  assert.match(Q.textStructuralIssue(numQ({ seq: ["1", "2"] })) ?? "", /needs 3-6 terms/);
  assert.match(Q.textStructuralIssue(textQ({ prompt: "  " })) ?? "", /missing prompt/);
});

// ── question-validity gate when the LLM rubric judge is UNREACHABLE ──────────
// These drive the real retry/backoff in llm.ts against a closed port, so each one
// spends a few seconds failing over. That is the point: it is the regression guard
// for an outage silently costing the day its throughput.

test("validateQuestions does NOT throw when the rubric judge is unreachable", async () => {
  setUsed([]);
  const q = textQ({ sig: "ok1", hash: "hok1" });
  const r = await G.validateQuestions([q]); // must RESOLVE, not reject
  assert.equal(r.gate.pass, true, "a structurally-sound question still passes");
  assert.match(r.gate.reason ?? "", /deterministic fallback/);
  assert.match(r.results["ok1"].reason, /structural check passed/);
});

test("the fallback is NOT a blanket bypass — a broken question still fails closed", async () => {
  setUsed([]);
  // stated answer matches NO option => the rubric's "exactly one correct answer"
  // criterion is structurally violated, and the fallback must catch it.
  const broken = textQ({ sig: "bad1", hash: "hbad1", options: ["apple", "banana", "cherry"], answer: "rock" });
  const r = await G.validateQuestions([broken]);
  assert.equal(r.gate.pass, false);
  assert.match(r.results["bad1"].reason, /answer matches 0 option\(s\)/);
});

test("fallback verdicts are NOT persisted — the real rubric re-judges later", async () => {
  setUsed([]);
  await G.validateQuestions([textQ({ sig: "nc1", hash: "hnc1" })]);
  const cachePath = join(TMP, "cache", "qvalidation.json");
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  assert.equal(cache.hnc1, undefined, "a fallback verdict must not poison the rubric cache");
});
