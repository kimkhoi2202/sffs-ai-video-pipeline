/**
 * replication.test.ts — the loop's READ side of the winner-replication engine.
 *
 * The value being protected here is the EXPLORATION FLOOR. Replication exists to
 * spend more of the batch on a style that already won, and the obvious failure mode
 * is that it spends ALL of it — at which point the loop can only ever rediscover
 * what it already believes. `winner_share_cap` is what stops that, so these tests
 * hammer it from both sides (a greedy ledger, a greedy config) and assert the batch
 * always keeps at least one exploration slot.
 *
 * Hermetic: points config at a tmp REPO dir BEFORE importing the module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-repl-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;
process.env.TFY_API_KEY = process.env.TFY_API_KEY || "test-dummy-key";
mkdirSync(join(TMP, "ab-testing"), { recursive: true });

const LEDGER = join(TMP, "ab-testing", "replication.json");
const DEFAULTS = join(TMP, "ab-testing", "content-defaults.json");

const FP = {
  key: "odd-one-out|3|standard|full|cliffhanger",
  lead_type: "odd-one-out",
  question_types: ["odd-one-out", "number-series", "figure-analogy"],
  num_questions: 3,
  family: "standard",
  narration: "full",
  ending: "cliffhanger",
};

function writeLedger(active: Record<string, unknown> | null): void {
  writeFileSync(LEDGER, JSON.stringify({ active, history: [] }));
}
function writeDefaults(replication: Record<string, unknown> | undefined): void {
  writeFileSync(DEFAULTS, JSON.stringify(replication ? { replication } : {}));
}
const openRound = (over: Record<string, unknown> = {}) => ({
  key: FP.key, fingerprint: FP, status: "active", share: 0.25, share_cap: 0.5,
  round: 1, confidence: "high", vary_only: ["hashtag_set", "tempo", "time_of_day"], ...over,
});

writeLedger(null);
writeDefaults(undefined);
const R = await import("./replication.ts");

test("no ledger / no open round => inactive, zero share", () => {
  writeLedger(null);
  const d = R.currentDirective();
  assert.equal(d.active, false);
  assert.equal(d.share, 0);
  assert.equal(R.replicaCount(12, d), 0);
});

test("an open round yields the recorded style and share", () => {
  writeLedger(openRound());
  const d = R.currentDirective();
  assert.equal(d.active, true);
  assert.equal(d.key, FP.key);
  assert.equal(d.share, 0.25);
  assert.equal(d.fingerprint?.lead_type, "odd-one-out");
  assert.equal(R.replicaCount(12, d), 3); // floor(12 * 0.25)
});

test("EXPLORATION FLOOR: a greedy ledger cannot exceed the hard cap", () => {
  writeLedger(openRound({ share: 0.99, share_cap: 0.99 }));
  const d = R.currentDirective();
  assert.ok(d.share <= R.HARD_SHARE_CAP, `share ${d.share} must be <= ${R.HARD_SHARE_CAP}`);
  assert.equal(R.replicaCount(12, d), 6); // half of 12, never more
});

test("EXPLORATION FLOOR: a greedy CONFIG cap cannot exceed the hard cap either", () => {
  writeLedger(openRound({ share: 0.99, share_cap: 0.99 }));
  writeDefaults({ winner_share_cap: 5 });
  const d = R.currentDirective();
  assert.equal(d.share_cap, R.HARD_SHARE_CAP);
  assert.ok(R.replicaCount(12, d) <= 6);
  writeDefaults(undefined);
});

test("EXPLORATION FLOOR: at least one slot always keeps exploring", () => {
  writeLedger(openRound({ share: 0.5, share_cap: 0.5 }));
  const d = R.currentDirective();
  for (const target of [1, 2, 3, 8, 12]) {
    const k = R.replicaCount(target, d);
    assert.ok(k < target, `target=${target}: replicas ${k} must leave an exploration slot`);
  }
});

test("replication can be switched off in content-defaults.json", () => {
  writeLedger(openRound());
  writeDefaults({ enabled: false });
  const d = R.currentDirective();
  assert.equal(d.active, false);
  assert.equal(R.replicaCount(12, d), 0);
  writeDefaults(undefined);
});

test("normalizeTier folds the two eras of tier labels together", () => {
  // The corpus spans "odd-one-out" (original pipeline) and "ODD ONE OUT" (current
  // loop). If these did not fold, a replica could never match the winner.
  assert.equal(R.normalizeTier("ODD ONE OUT"), "odd-one-out");
  assert.equal(R.normalizeTier("odd-one-out"), "odd-one-out");
  assert.equal(R.normalizeTier("Number_Series"), "number-series");
  assert.equal(R.normalizeTier(undefined), "?");
});

test("replica specs hold the STYLE constant and vary only the secondary knobs", async () => {
  // The whole point of replication is attribution: if the replicas also win, it has
  // to be because of the style. So every spec pins the same style + arm label, and
  // the only thing that moves is tempo (countdownSec) — hashtags rotate separately
  // in planBatch, and time-of-day falls out of the scheduler's jitter.
  const { replicaSpecs } = await import("./design.ts");
  const specs = replicaSpecs(4, FP as any);
  assert.equal(specs.length, 4);
  assert.deepEqual([...new Set(specs.map((s) => s.arm))], ["replica-odd-one-out"], "one arm label => one rollup cell");
  assert.deepEqual([...new Set(specs.map((s) => s.dimension))], ["replication"]);
  assert.deepEqual([...new Set(specs.map((s) => s.numQ))], [3], "question count is part of the style");
  assert.deepEqual([...new Set(specs.map((s) => s.narrationArm))], ["full"], "narration is part of the style");
  assert.deepEqual([...new Set(specs.map((s) => s.endingArm))], ["cliffhanger"], "ending is part of the style");
  // ...and the secondary knob genuinely moves across the replicas
  assert.ok(new Set(specs.map((s) => s.countdownSec)).size >= 3, `tempo must vary, got ${specs.map((s) => s.countdownSec)}`);
});

test("a fingerprint from the older corpus era inherits current defaults rather than guessing", async () => {
  // Pre-loop posts have no recorded narration/ending ("?"). Those axes must fall
  // through to the current defaults instead of pinning a made-up arm.
  const { replicaSpecs } = await import("./design.ts");
  const [spec] = replicaSpecs(1, { ...FP, narration: "?", ending: "?" } as any);
  assert.equal(spec.narrationArm, undefined);
  assert.equal(spec.endingArm, undefined);
});

test("matchesFingerprint keys on the LEAD question type and the question count", () => {
  assert.equal(R.matchesFingerprint({ leadType: "ODD ONE OUT", numQuestions: 3 }, FP as any), true);
  assert.equal(R.matchesFingerprint({ leadType: "NUMBER SERIES", numQuestions: 3 }, FP as any), false);
  assert.equal(R.matchesFingerprint({ leadType: "odd-one-out", numQuestions: 1 }, FP as any), false);
  assert.equal(R.matchesFingerprint({ leadType: "odd-one-out", numQuestions: 3 }, undefined), false);
});
