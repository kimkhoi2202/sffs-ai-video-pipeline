/**
 * budgetGuard.test.ts — the monthly Metricool guard, and the dedup gate's blind spot
 * for a video's own unshipped claim.
 *
 * BOTH OF THESE WERE LIVE DEFECTS ON 2026-08-03, and both were invisible in the cycle
 * summary, which is why they are pinned here rather than left to review:
 *
 *   1. cycle.ts asked for slots with allocatable(Number.MAX_SAFE_INTEGER). The guard
 *      metricool.ts budget() documents — "fails CLOSED at the budget" — was therefore
 *      never consulted by the autonomous path at all, and no cycle had ever logged a
 *      budget line. What the loop was actually heading for was not its own graceful
 *      stop at 600 but Metricool's 700 Fair Use ceiling, which is a manual account
 *      review during which nothing can post.
 *
 *   2. markUsed() writes the used ledger BEFORE the render. A video that dies between
 *      the validity gate and a passing render therefore leaves its questions banked
 *      having never shipped, and the retry is rejected as a duplicate of itself. On
 *      2026-07-28 that cost videos v08 and v09 — every sig in both rejections was owned
 *      in the ledger by the very video being rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { exhaustionForecast, EXHAUSTION_WARN_DAYS, decide } from "./postingPolicy.ts";
import { gateDedup } from "./gates.ts";
import { loadUsedSigOwners, loadUsedSigs } from "./questions.ts";
import type { HermesQ } from "./state.ts";

// ── 1. the countdown ─────────────────────────────────────────────────────────

test("BUDGET: committed-but-unpublished records are spent, even though the counter has not moved", () => {
  // Metricool counts monthPublishedPostsByBrand — PUBLISHED. At 36/day placed a day or
  // two ahead, a guard reading only that believes it owns headroom it has promised away.
  const naive = exhaustionForecast(54, 0, 36, "2026-08-03");
  const honest = exhaustionForecast(54, 70, 36, "2026-08-03");
  assert.equal(naive.headroom, 546);
  assert.equal(honest.headroom, 476, "70 already on the calendar are gone");
  assert.ok(honest.daysLeft < naive.daysLeft, "counting commitments must shorten the runway, never lengthen it");
});

test("BUDGET: the forecast names a DATE, so the wall is a countdown and not a surprise", () => {
  const f = exhaustionForecast(54, 0, 36, "2026-08-03");
  assert.equal(f.daysLeft, 15, "546 / 36");
  assert.equal(f.exhaustsOn, "2026-08-18");
  assert.match(f.reason, /guard starts refusing on 2026-08-18/);
});

test("BUDGET: warns only inside the last week, so the line means something when it appears", () => {
  assert.equal(exhaustionForecast(54, 0, 36, "2026-08-03").warn, false, "15 days out is not news");
  const near = exhaustionForecast(600 - 36 * EXHAUSTION_WARN_DAYS, 0, 36, "2026-08-03");
  assert.equal(near.warn, true, `exactly ${EXHAUSTION_WARN_DAYS} days out must warn`);
  assert.equal(exhaustionForecast(600, 0, 36, "2026-08-03").warn, true, "and being out of budget certainly warns");
});

test("BUDGET: headroom floors at zero and never goes negative", () => {
  const over = exhaustionForecast(700, 40, 36, "2026-08-03");
  assert.equal(over.headroom, 0);
  assert.equal(over.daysLeft, 0);
  assert.equal(over.exhaustsOn, "2026-08-03", "today — there is nothing left to spend");
});

test("BUDGET: a zero cadence is not an exhaustion date", () => {
  const f = exhaustionForecast(54, 0, 0, "2026-08-03");
  assert.equal(f.exhaustsOn, null);
  assert.equal(f.warn, false);
});

test("BUDGET: the headroom the forecast reports is the number decide() rations on", () => {
  // The bug was the wiring, not the arithmetic: decide() always worked, it was simply
  // handed Number.MAX_SAFE_INTEGER. These two must agree at the boundary.
  const spent = exhaustionForecast(600, 0, 36, "2026-08-03");
  for (const d of decide(spent.headroom)) {
    assert.equal(d.slots, 0, `${d.network} must get nothing once the budget is gone`);
  }
  const roomy = exhaustionForecast(54, 0, 36, "2026-08-03");
  assert.ok(decide(roomy.headroom).some((d) => d.slots > 0), "and everything keeps running while there is room");
});

// ── 2. the dedup gate's own claim ────────────────────────────────────────────

const Q = (sig: string): HermesQ =>
  ({ sig, hash: sig, tier: "ODD ONE OUT", kind: "text", prompt: `p ${sig}`, options: ["a", "b", "c"], answer: "a" }) as unknown as HermesQ;

test("DEDUP: a fresh question passes, with or without a self id", () => {
  const q = [Q("brand-new-sig-not-in-any-ledger")];
  assert.equal(gateDedup(q, new Set()).pass, true);
  assert.equal(gateDedup(q, new Set(), "2026-08-03-v01").pass, true);
});

test("DEDUP: a question claimed earlier IN THIS BATCH is still a duplicate", () => {
  // Self-ownership must not weaken the in-batch guard: two videos in one run cannot
  // share a question just because one of them is asking.
  const q = [Q("shared-sig")];
  const g = gateDedup(q, new Set(["shared-sig"]), "2026-08-03-v01");
  assert.equal(g.pass, false);
  assert.match(g.reason, /duplicate/);
  assert.deepEqual((g.detail as any).dupBatch, ["shared-sig"]);
});

test("DEDUP: the same question twice inside ONE video is still a duplicate", () => {
  const g = gateDedup([Q("twice"), Q("twice")], new Set(), "2026-08-03-v01");
  assert.equal(g.pass, false);
  assert.deepEqual((g.detail as any).dupInternal, ["twice"]);
});

test("DEDUP: a video is NOT a duplicate of its own unshipped claim — the 2026-07-28 failure", () => {
  // Driven off the REAL used ledger rather than a fixture, because the defect was a
  // disagreement between two real files: a sig sitting in hermes-used-sigs.json and the
  // videoSlug that put it there sitting in ab-test-usage.json. A hand-built pair cannot
  // reproduce a disagreement between the things it was built from.
  const owners = loadUsedSigOwners();
  const used = loadUsedSigs();
  const owned = [...owners.entries()].find(([sig]) => used.has(sig));
  assert.ok(owned, "the used ledger should have at least one attributable question");
  const [sig, owner] = owned;

  const asStranger = gateDedup([Q(sig)], new Set());
  assert.equal(asStranger.pass, false, "another video may never reuse it");
  assert.deepEqual((asStranger.detail as any).dupUsed, [sig]);

  const asOwner = gateDedup([Q(sig)], new Set(), owner);
  assert.equal(asOwner.pass, true, `${owner} retrying must not be blocked by its own claim`);
  assert.deepEqual((asOwner.detail as any).dupUsed, []);
  assert.deepEqual((asOwner.detail as any).nearDup, [], "and not via the fuzzy key either");
});

test("DEDUP: omitting the self id preserves the old behaviour exactly", () => {
  // planBatch gates candidate questions that belong to no video yet, and must keep
  // seeing the ledger as a flat never-repeat set.
  const g = gateDedup([Q("unowned")], new Set());
  assert.equal(g.pass, true, "an unowned, unused sig is fine either way");
  assert.deepEqual((g.detail as any).dupUsed, []);
});
