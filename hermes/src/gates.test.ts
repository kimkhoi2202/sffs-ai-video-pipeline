/**
 * gates.test.ts — dedup gate: exact + fuzzy near-duplicate (Work item 1).
 *
 * Proves gateDedup keeps its EXACT-sig behavior (used / in-batch / internal
 * duplicates -> "duplicate question(s) detected") AND adds a distinct
 * `near_duplicate` rejection for paraphrase / reordered-option / same-structure
 * variants, both within the batch and vs the used ledger — without re-flagging
 * exact duplicates as near-dups.
 *
 * Hermetic: points config at a tmp REPO/DATA dir BEFORE importing the module.
 * Only the dedup gate is exercised (no LLM rubric, no ffprobe).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

// The bank is only needed so used exact-sigs can be resolved to fuzzy sigs.
const BANK_ENTRIES = [
  { sig: "u1", hash: "hu1", kind: "text", category: "verbal", tier: "A", payloadNorm: "which word does not belong || apple~banana~cherry~rock", answerNorm: "rock" },
];
mkdirSync(join(TMP, "content"), { recursive: true });
writeFileSync(join(TMP, "content", "master-question-bank.json"), JSON.stringify({ entries: BANK_ENTRIES }));

const G = await import("./gates.ts");

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
