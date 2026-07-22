/**
 * dimensions.test.ts — the PURE question TYPE-variety selector (P1):
 * selectSpread picks numQ questions maximizing per-video tier/kind spread and
 * per-batch anti-clustering, deterministically. Complements the fuzzy near-dup
 * guard (questions.test.ts).
 *
 * Hermetic: points config at a tmp dir BEFORE importing (dimensions.ts pulls in
 * defaults.ts -> config.ts) and exercises only the pure, network-free helpers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "hermes-dims-"));
process.env.HERMES_ENV_FILE = join(TMP, "nonexistent.env");
process.env.HERMES_REPO_DIR = TMP;
process.env.HERMES_DATA_DIR = TMP;

const { selectSpread, newSpreadTally } = await import("./dimensions.ts");

let n = 0;
function q(tier: string, kind: "text" | "numseries" = "text"): any {
  n++;
  return { sig: `s${n}`, hash: `h${n}`, kind, category: "verbal", tier, prompt: `p${n}`, options: ["a", "b", "c"], answer: "a" };
}

const tiersOf = (arr: any[]) => arr.map((x) => x.tier);

test("per-video spread: picks distinct tiers instead of the biggest bucket", () => {
  // Pool over-samples tier A (as the seeded pool would for the biggest type).
  const pool = [q("A"), q("A"), q("A"), q("B"), q("B"), q("C")];
  const chosen = selectSpread(pool, 3, newSpreadTally());
  assert.equal(chosen.length, 3);
  assert.equal(new Set(tiersOf(chosen)).size, 3); // one A, one B, one C — not A,A,A
  assert.deepEqual([...new Set(tiersOf(chosen))].sort(), ["A", "B", "C"]);
});

test("returns fewer than numQ when the pool is too small (caller drops it)", () => {
  const chosen = selectSpread([q("A"), q("B")], 3, newSpreadTally());
  assert.equal(chosen.length, 2);
});

test("per-batch anti-clustering: prefers the globally rarer tier on a within-video tie", () => {
  const batch = newSpreadTally();
  batch.tier["A"] = 5; // tier A already heavily used across the batch
  batch.tier["C"] = 0;
  // both are new to THIS video (tie on per-video keys) -> batch tally breaks it.
  const chosen = selectSpread([q("A"), q("C")], 1, batch);
  assert.deepEqual(tiersOf(chosen), ["C"]);
});

test("kind is a secondary spread axis", () => {
  // tiers identical but kinds differ -> should not pick two of the same kind first.
  const pool = [q("T", "text"), q("T", "text"), q("T", "numseries")];
  const chosen = selectSpread(pool, 2, newSpreadTally());
  assert.equal(new Set(chosen.map((x) => x.kind)).size, 2); // one text, one numseries
});

test("deterministic: same pool + fresh batch -> identical selection", () => {
  const pool = [q("A"), q("B"), q("A"), q("C"), q("B")];
  const a = tiersOf(selectSpread(pool, 3, newSpreadTally()));
  const b = tiersOf(selectSpread(pool, 3, newSpreadTally()));
  assert.deepEqual(a, b);
});

test("stable tie-break by pool index when nothing else differs", () => {
  const pool = [q("A"), q("A"), q("A")]; // all identical tier+kind
  const chosen = selectSpread(pool, 2, newSpreadTally());
  assert.deepEqual(chosen.map((x) => x.sig), [pool[0].sig, pool[1].sig]);
});

test("mutates the batch tally so later videos balance against earlier ones", () => {
  const batch = newSpreadTally();
  selectSpread([q("A"), q("B")], 2, batch);
  assert.equal(batch.tier["A"], 1);
  assert.equal(batch.tier["B"], 1);
  assert.equal(batch.kind["text"], 2);
});
