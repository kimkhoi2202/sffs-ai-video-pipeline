/**
 * judgeContract.test.ts — the rubric's output contract, and the quarantine ledger.
 *
 * THE BUG THESE PIN. The old contract asked for {"index","valid","reason"} in that
 * order, so the model had to commit to a boolean before it had done any reasoning. It
 * then reasoned inside the `reason` string and repeatedly talked itself round — and the
 * verdict never moved. Four of twelve flags on 2026-08-02 read like this:
 *
 *   valid=false  reason="Rule 3->7,5->13,6->16,7->? uses 3n-2: ... Correct, single answer"
 *   valid=false  reason="Pattern (a+b)*2: 5+5=20,1+3=8,8+4=24, so 9+6=30 correct"
 *
 * Two whole videos died on those two lines. The contract now puts `analysis` and
 * `issues` BEFORE `verdict`, and makes `issues` the evidence: an "invalid" with no
 * issue named is a self-contradiction, not a rejection, and it fails OPEN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-judge-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const { reconcileVerdict } = await import("./gates.ts");
const { markRejected, loadRejectedSigs } = await import("./questions.ts");
const { CONFIG } = await import("./config.ts");

// ── The self-contradiction guard ─────────────────────────────────────────────

test("an INVALID that names no issue is kept, not discarded", () => {
  const { verdict, contradiction } = reconcileVerdict({
    index: 0,
    analysis: "Rule 3->7, 5->13, 6->16, 7->? uses 3n-2, so 7 -> 19. Correct, single answer.",
    issues: [],
    verdict: "invalid",
  });
  assert.equal(contradiction, true, "a verdict with no evidence behind it is a contradiction");
  assert.equal(verdict.valid, true, "an item whose own rationale says it is fine must survive");
  assert.match(verdict.reason, /named no issue/);
  assert.match(verdict.reason, /3n-2/, "and the analysis is carried through so a human can check");
});

test("an INVALID that DOES name an issue is honoured", () => {
  const { verdict, contradiction } = reconcileVerdict({
    index: 0,
    analysis: "Both jacket and goldfish can be the odd one out depending on the category chosen.",
    issues: ["more than one option is correct"],
    verdict: "invalid",
  });
  assert.equal(contradiction, false);
  assert.equal(verdict.valid, false);
  assert.match(verdict.reason, /more than one option is correct/);
});

test("a VALID verdict is honoured, and its analysis becomes the reason", () => {
  const { verdict } = reconcileVerdict({ index: 0, analysis: "CUBE is 3D, the rest are 2D.", issues: [], verdict: "valid" });
  assert.equal(verdict.valid, true);
  assert.equal(verdict.reason, "CUBE is 3D, the rest are 2D.");
});

test("a MISSING verdict falls back to the evidence rather than to a guess", () => {
  assert.equal(reconcileVerdict({ index: 0, analysis: "fine", issues: [] }).verdict.valid, true);
  assert.equal(reconcileVerdict({ index: 0, analysis: "bad", issues: ["the stated_answer is wrong"] }).verdict.valid, false);
});

test("the model's vocabulary is accepted in the spellings it actually uses", () => {
  for (const v of ["invalid", "false", "no", "INVALID"]) {
    assert.equal(reconcileVerdict({ index: 0, issues: ["the stated_answer is wrong"], verdict: v }).verdict.valid, false, v);
  }
  for (const v of ["valid", "true", "yes", "Valid"]) {
    assert.equal(reconcileVerdict({ index: 0, issues: [], verdict: v }).verdict.valid, true, v);
  }
});

test("a single issue sent as a bare string is not mistaken for 'no issues'", () => {
  const { verdict, contradiction } = reconcileVerdict({ index: 0, issues: "the stated_answer is wrong", verdict: "invalid" } as any);
  assert.equal(contradiction, false);
  assert.equal(verdict.valid, false);
});

test("reasons are no longer truncated at the length that hid the bug", () => {
  // "...however verify: yes 65 corre" — cut at 200 characters, mid-word, mid-argument.
  const long = "x".repeat(600);
  const { verdict } = reconcileVerdict({ index: 0, analysis: long, issues: [], verdict: "valid" });
  assert.ok(verdict.reason.length > 200, "200 was too short to see the contradiction");
  assert.ok(verdict.reason.length <= 400, "but it is still bounded");
});

// ── The quarantine ledger ────────────────────────────────────────────────────

const mkQ = (sig: string) => ({ sig, hash: `h-${sig}`, kind: "text", category: "verbal", tier: "ODD ONE OUT", prompt: "p", options: ["a", "b", "c"], answer: "a" }) as any;

test("a rejected question is quarantined and never offered again", () => {
  assert.equal(loadRejectedSigs().size, 0);
  markRejected("2026-08-02-v11", [mkQ("bad-1"), mkQ("bad-2")], { "bad-1": "more than one option is correct" });
  const after = loadRejectedSigs();
  assert.equal(after.size, 2);
  assert.ok(after.has("bad-1") && after.has("bad-2"));
});

test("quarantine is idempotent — re-rejecting the same item adds nothing", () => {
  markRejected("2026-08-02-t1-v04", [mkQ("bad-1")]);
  assert.equal(loadRejectedSigs().size, 2, "still just the two");
});

test("quarantine records WHY, so a bad rule set can be audited and undone", () => {
  assert.ok(existsSync(CONFIG.HERMES_REJECTED));
  const j = JSON.parse(readFileSync(CONFIG.HERMES_REJECTED, "utf8"));
  const entry = j.log.find((l: any) => l.sig === "bad-1");
  assert.equal(entry.videoSlug, "2026-08-02-v11");
  assert.equal(entry.reason, "more than one option is correct");
  assert.ok(entry.ts, "and when");
});

test("quarantine is SEPARATE from the used ledger — these were never published", () => {
  // Conflating them would make the dedup gate report a rejected question as a
  // "duplicate", which is a different and misleading fact about it.
  const used = join(TMP, "hermes-used-sigs.json");
  const sigs = existsSync(used) ? JSON.parse(readFileSync(used, "utf8")).sigs ?? [] : [];
  assert.equal(sigs.includes("bad-1"), false);
});
