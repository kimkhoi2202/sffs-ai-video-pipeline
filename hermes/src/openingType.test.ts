/**
 * openingType.test.ts — the OPENING-QUESTION-TYPE experiment.
 *
 * Every test here guards a way this experiment could produce a confident, meaningless
 * number, and each one is a failure that has ALREADY happened on this campaign:
 *
 *   ONE ARM ONLY. The `opening` hook experiment ran for 41 posts with no control arm in
 *   the store the rollups read; 32 records carry a motion-hook arm and zero carry the
 *   cold plate. It could never have produced a read.
 *   LABELS IN THE WRONG STORE. Those arms went to hermes-data/metricool-scheduled.json
 *   while ab-database.json saw one side, and two analyses reached opposite conclusions.
 *   AN ARM THAT SILENTLY NEVER FILLS. Half the types the brief wanted on the concrete
 *   side are figure kinds, which the pinned format's kind filter cannot draw at all.
 *   DATE. Balanced overall is not balanced: 78% of skip variance here is within-day.
 *   DIRECTION. Skip rate is lower-is-better, and a plain delta promotes the worse hook.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  allocateOpeningTypes,
  armCounts,
  openingTypeArm,
  OPENING_TYPE_ARMS,
  OPENING_TYPE_DIMENSION,
  OPENING_TYPE_TIERS,
  OPEN_ANALOGY,
  OPEN_CONCRETE,
} from "./openingType.ts";
import { openingTypeCount, openingTypeSpecs, selectSpread, newSpreadTally } from "./dimensions.ts";
import { selectBatchSpecs } from "./design.ts";
import { candidateQuestions } from "./questions.ts";
import { leadStamp } from "./leadPromotion.ts";
import { computeRollups } from "./rollup.ts";

// ── the classifier ──

test("ARM: each side claims its own types and nothing else", () => {
  assert.equal(openingTypeArm("ODD ONE OUT"), OPEN_CONCRETE);
  assert.equal(openingTypeArm("VERBAL ANALOGY"), OPEN_ANALOGY);
  assert.equal(openingTypeArm("NUMBER ANALOGY"), OPEN_ANALOGY);
  assert.equal(openingTypeArm("FIGURE ANALOGY"), OPEN_ANALOGY);
});

test("ARM: tier spelling variants all resolve — the bank uses three of them", () => {
  for (const v of ["odd-one-out", "Odd One Out", " ODD  ONE OUT ", "ODD_ONE_OUT"]) {
    assert.equal(openingTypeArm(v), OPEN_CONCRETE, `failed on ${JSON.stringify(v)}`);
  }
  assert.equal(openingTypeArm("figure-analogy"), OPEN_ANALOGY);
});

/**
 * NULL IS A RESULT, not a gap to be filled. A slot that fell back to number puzzle
 * because an arm's stock ran dry must land outside both arms — pooling it into either
 * side is how an arm ends up "winning" on posts it never ran.
 */
test("ARM: a type in neither arm is null, not silently assigned", () => {
  for (const t of ["NUMBER PUZZLE", "NUMBER SERIES", "SENTENCE COMPLETION", "LOGIC", "", null, undefined]) {
    assert.equal(openingTypeArm(t), null, `${t} should belong to neither arm`);
  }
});

test("ARM: the two arms are disjoint", () => {
  const a = new Set(OPENING_TYPE_TIERS[OPEN_CONCRETE]);
  for (const t of OPENING_TYPE_TIERS[OPEN_ANALOGY]) assert.ok(!a.has(t), `${t} is in both arms`);
});

// ── balance and interleaving ──

test("BALANCE: an even allocation is exactly equal, not merely close", () => {
  for (const n of [2, 4, 6, 8, 12]) {
    const c = armCounts(allocateOpeningTypes(n));
    assert.equal(c[OPEN_CONCRETE], n / 2, `n=${n}`);
    assert.equal(c[OPEN_ANALOGY], n / 2, `n=${n}`);
  }
});

test("BALANCE: the slice size is always even, so a day can never be lopsided", () => {
  for (let available = 0; available <= 20; available++) {
    const n = openingTypeCount(available);
    assert.equal(n % 2, 0, `available=${available} gave an odd ${n}`);
    assert.ok(n <= available, `available=${available} gave ${n}`);
  }
  assert.equal(openingTypeCount(0), 0);
  assert.equal(openingTypeCount(1), 0, "one slot cannot hold a balanced pair");
});

test("BALANCE: arms ALTERNATE rather than block, so neither owns a run of slots", () => {
  const arms = allocateOpeningTypes(6);
  for (let i = 1; i < arms.length; i++) assert.notEqual(arms[i], arms[i - 1], `slots ${i - 1},${i} are the same arm`);
});

test("BALANCE: rotate flips which arm leads, so the spare slot cannot always be one arm", () => {
  assert.equal(allocateOpeningTypes(3, 0)[0], OPEN_CONCRETE);
  assert.equal(allocateOpeningTypes(3, 1)[0], OPEN_ANALOGY);
  // ...and an odd count evens out across two consecutive days.
  const day0 = armCounts(allocateOpeningTypes(3, 0));
  const day1 = armCounts(allocateOpeningTypes(3, 1));
  assert.equal(day0[OPEN_CONCRETE] + day1[OPEN_CONCRETE], day0[OPEN_ANALOGY] + day1[OPEN_ANALOGY]);
});

// ── supply: an arm that cannot fill is worse than no experiment ──

test("SUPPLY: BOTH arms have fresh, drawable questions right now", () => {
  const pool = candidateQuestions({ seed: "supply-test" });
  const have = { [OPEN_CONCRETE]: 0, [OPEN_ANALOGY]: 0 };
  for (const q of pool) {
    const a = openingTypeArm(q.tier);
    if (a) have[a]++;
  }
  for (const arm of OPENING_TYPE_ARMS) {
    assert.ok(have[arm] >= 20, `${arm} has only ${have[arm]} fresh questions — it would starve`);
  }
});

/**
 * The pinned format draws `text` and `numseries` only, so naming a figure tier in an arm
 * would create a side that silently never fills. This asserts the arms are satisfiable by
 * the pool the batch ACTUALLY draws from, not by the bank in the abstract.
 */
test("SUPPLY: every arm is satisfiable from the pinned format's own kind filter", () => {
  const pool = candidateQuestions({ seed: "kind-filter-test" });
  for (const arm of OPENING_TYPE_ARMS) {
    assert.ok(pool.some((q) => openingTypeArm(q.tier) === arm), `${arm} cannot be drawn at all`);
  }
});

// ── the constraint actually binds, and yields rather than costing a video ──

const q = (sig: string, tier: string, prompt = "X") => ({ sig, hash: sig, kind: "text", category: "verbal", tier, prompt, options: ["a", "b"], answer: "a" }) as any;

test("CONSTRAINT: the opening pick comes from the arm's tiers", () => {
  const pool = [q("1", "NUMBER PUZZLE"), q("2", "VERBAL ANALOGY"), q("3", "ODD ONE OUT")];
  const got = selectSpread(pool, 2, newSpreadTally(), undefined, Infinity, OPENING_TYPE_TIERS[OPEN_CONCRETE]);
  assert.equal(got[0].tier, "ODD ONE OUT");
});

test("CONSTRAINT: it outranks the length-band preference it replaced", () => {
  const pool = [q("1", "ODD ONE OUT", "ONE TWO THREE FOUR FIVE"), q("2", "NUMBER ANALOGY", "A B")];
  // "short" would prefer the 2-word number analogy; the arm must win.
  const got = selectSpread(pool, 1, newSpreadTally(), ["short"], Infinity, OPENING_TYPE_TIERS[OPEN_CONCRETE]);
  assert.equal(got[0].tier, "ODD ONE OUT");
});

/**
 * An arm with nothing fresh left must NOT cost the day a video. It falls back, and the
 * post is then stamped with what it actually opened with — landing outside both arms
 * rather than being miscounted into the one it was supposed to run.
 */
test("CONSTRAINT: an exhausted arm yields, and the post lands in NEITHER arm", () => {
  const pool = [q("1", "NUMBER PUZZLE"), q("2", "SENTENCE COMPLETION")];
  const got = selectSpread(pool, 2, newSpreadTally(), undefined, Infinity, OPENING_TYPE_TIERS[OPEN_CONCRETE]);
  assert.equal(got.length, 2, "the video must still ship");
  assert.equal(openingTypeArm(got[0].tier), null, "and must not be counted as the arm it could not run");
});

// ── the label reaches the store the rollups read ──

test("LABEL: leadStamp derives the arm from the question that actually shipped", () => {
  assert.equal(leadStamp({ tier: "ODD ONE OUT", prompt: "WHICH ONE DOES NOT BELONG?" }).opening_type_arm, OPEN_CONCRETE);
  assert.equal(leadStamp({ tier: "VERBAL ANALOGY", prompt: "HOT IS TO COLD AS\nDAY IS TO ?" }).opening_type_arm, OPEN_ANALOGY);
  assert.equal(leadStamp({ tier: "NUMBER PUZZLE", prompt: "IF 2+3=10\nTHEN 3+4 = ?" }).opening_type_arm, null);
});

test("LABEL: the arm can never disagree with lead_type on the same record", () => {
  for (const tier of ["ODD ONE OUT", "VERBAL ANALOGY", "NUMBER ANALOGY", "NUMBER PUZZLE", "NUMBER SERIES"]) {
    const s = leadStamp({ tier, prompt: "WHATEVER" });
    assert.equal(s.opening_type_arm, openingTypeArm(s.lead_type));
  }
});

test("ROLLUP: by_opening_type keys on the stamp and drops posts in neither arm", () => {
  const post = (arm: string | null, skip: number) => ({
    variant: { opening_type_arm: arm },
    metrics: { source: "live", skip_rate: skip },
  });
  const r = computeRollups([post(OPEN_CONCRETE, 60), post(OPEN_CONCRETE, 64), post(OPEN_ANALOGY, 72), post(null, 99)]);
  assert.deepEqual(Object.keys(r.by_opening_type).sort(), [OPEN_ANALOGY, OPEN_CONCRETE].sort());
  assert.equal(r.by_opening_type[OPEN_CONCRETE].median_skip_rate, 62);
  assert.equal(r.by_opening_type[OPEN_ANALOGY].median_skip_rate, 72);
  assert.equal(r.by_opening_type[OPEN_CONCRETE].n_by_metric.median_skip_rate, 2);
});

/**
 * BOTH ARMS IN by_variant_arm — the cut the Python promotion engine reads. This is the
 * exact property the hook experiment lacked, and the reason it produced two opposite
 * conclusions from one dataset.
 */
test("LABEL: both arms appear as distinct variant labels the promotion engine can see", () => {
  const specs = openingTypeSpecs(4, 0);
  const labels = new Set(specs.map((s) => s.arm));
  assert.equal(labels.size, 2, "both arms must be distinct rollup labels");
  for (const s of specs) {
    assert.equal(s.dimension, OPENING_TYPE_DIMENSION);
    assert.ok(s.leadTiers && s.leadTiers.length > 0, "an arm with no tiers constrains nothing");
  }
});

// ── the batch the cycle will actually build ──

test("BATCH: both arms run every day, in equal numbers, on the live target", () => {
  for (const runId of ["2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"]) {
    const { specs } = selectBatchSpecs(runId, 11);
    const arms = specs.filter((s) => s.dimension === OPENING_TYPE_DIMENSION).map((s) => s.arm);
    assert.ok(arms.length >= 2, `${runId}: the experiment got ${arms.length} slots`);
    const c = armCounts(arms as any);
    assert.equal(c[OPEN_CONCRETE], c[OPEN_ANALOGY], `${runId} is lopsided: ${JSON.stringify(c)}`);
  }
});

/**
 * NEITHER ARM MAY OWN A TIME OF DAY OR A HASHTAG SET. Slot index decides both — posts go
 * out in slot order and the tag set is HASHTAG_ROTATION[i % 3] — so an arm that always
 * took the same indices would be confounded with both. It is checked across two
 * consecutive days because `rotate` is what makes the pairing alternate.
 */
test("BATCH: arms swap slots day to day, so neither owns a slot, a time or a tag set", () => {
  const slotsFor = (runId: string) =>
    selectBatchSpecs(runId, 11)
      .specs.map((s, i) => (s.dimension === OPENING_TYPE_DIMENSION ? { i, arm: s.arm } : null))
      .filter((x): x is { i: number; arm: string } => x !== null);

  const d0 = slotsFor("2026-08-04");
  const d1 = slotsFor("2026-08-05");
  assert.deepEqual(d0.map((x) => x.i), d1.map((x) => x.i), "the slice should occupy stable indices");
  for (let k = 0; k < d0.length; k++) {
    assert.notEqual(d0[k].arm, d1[k].arm, `slot ${d0[k].i} ran the same arm two days running`);
  }
  // and over the pair, each arm has held every experiment slot exactly once
  for (const k of d0.keys()) {
    assert.deepEqual(new Set([d0[k].arm, d1[k].arm]), new Set(OPENING_TYPE_ARMS));
  }
});

test("BATCH: the experiment never eats the exploration floor or the whole batch", () => {
  const { specs } = selectBatchSpecs("2026-08-04", 11);
  const open = specs.filter((s) => s.dimension === OPENING_TYPE_DIMENSION).length;
  const explore = specs.filter((s) => s.arm === "control" || s.arm === "one-question").length;
  assert.ok(explore >= 2, `the exploration slice was squeezed to ${explore}`);
  assert.ok(open < specs.length - explore, "the experiment took every non-exploration slot");
});

test("BATCH: a top-up wave too small for a balanced pair simply runs none", () => {
  const { specs } = selectBatchSpecs("2026-08-04", 2);
  assert.equal(specs.filter((s) => s.dimension === OPENING_TYPE_DIMENSION).length, 0);
});

// ── direction: skip rate is LOWER-IS-BETTER ──

/**
 * The one number that decides the experiment. A recent fix corrected several
 * lower-is-better inversions in the promotion path; this asserts the direction holds for
 * THIS dimension rather than assuming it inherits, by checking the live config and the
 * rollup the engine reads. The Python side is pinned in
 * hermes-nous/tests/test_opening_type_promotion.py.
 */
test("DIRECTION: the arm with the LOWER median skip rate is the better one", async () => {
  const { readFileSync } = await import("node:fs");
  const defaults = JSON.parse(readFileSync("ab-testing/content-defaults.json", "utf8"));
  assert.equal(defaults.promotion.metric, "median_skip_rate");
  assert.equal(defaults.promotion.lower_is_better, true);

  const post = (arm: string, skip: number) => ({ variant: { opening_type_arm: arm }, metrics: { source: "live", skip_rate: skip } });
  const r = computeRollups([
    post(OPEN_CONCRETE, 60), post(OPEN_CONCRETE, 62),
    post(OPEN_ANALOGY, 74), post(OPEN_ANALOGY, 76),
  ]);
  const better = Object.entries(r.by_opening_type).sort((a, b) => a[1].median_skip_rate! - b[1].median_skip_rate!)[0][0];
  assert.equal(better, OPEN_CONCRETE, "lower skip must read as the better arm");
});
