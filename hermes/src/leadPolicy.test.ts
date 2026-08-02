/**
 * leadPolicy.test.ts — the opening-question weighting, driven through the REAL
 * decision functions rather than hand-built verdict objects.
 *
 * What these lock out, in order of how badly each one has bitten this codebase before:
 *
 *   1. Moving the mix on evidence that cannot support it. The previous engine promoted on
 *      samples as small as three. The min-sample gate and the interval test are asserted
 *      against thin, noisy and lopsided evidence.
 *   2. Collapsing the batch onto one option. Near-duplicate content is what got TikTok
 *      flagged, so the floor and cap are asserted at the extreme where a naive
 *      normalise-then-clamp silently stops holding.
 *   3. A metric arriving as a fabricated zero. A missing skip rate is unknown, never a
 *      perfect hook.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  promptWords, bandOf, median, bootstrapMedianCI, clampShares, computeLeadPolicy,
  allocateLeadBands, LEAD_BANDS, MIN_POSTS_PER_BAND, MIN_SHARE, MAX_SHARE,
  type LeadEvidenceRow, type LeadBand,
} from "./leadPolicy.ts";
import { normType, typeWordTable, leadWordsFor } from "./leadPromotion.ts";
import { selectSpread, newSpreadTally, leadTypeCap } from "./dimensions.ts";

/**
 * THE REAL MEASUREMENT, as of 2026-08-02: every matured Instagram post the loop can
 * attribute to its opening question, grouped by the prompt-length band of that question.
 *
 * These are the actual skip rates, not a fixture shaped to make the gate fire. That
 * matters because the interesting property of this evidence is how NOISY it is — the
 * short band spans 51.4 to 80.5 — and a synthetic generator with tidy spread makes every
 * band look separable, which is precisely the illusion the gate exists to refuse.
 */
const REAL = {
  short: [51.4, 52.1, 52.1, 54.7, 55.7, 59.1, 61.2, 61.3, 62.3, 66.4, 67.7, 69, 69.9, 76.4, 79.5, 79.5, 80.5],
  medium: [59.5, 64.3, 64.5, 67.1, 68, 68.8, 72.5, 74.6, 75, 79.2, 79.5, 85.2, 89.3],
  long: [53.3, 62.1, 62.9, 64.1, 68.5, 70.5, 70.8, 71.2, 71.2, 72, 75.2, 78, 81.7, 92.2],
};

function realEvidence(): LeadEvidenceRow[] {
  return (Object.keys(REAL) as LeadBand[]).flatMap((b) => REAL[b].map((skip) => ({ band: b, skip })));
}

/** n posts in `band` whose skip rates are centred on `mid`, deterministic. */
function rows(band: LeadBand, n: number, mid: number, spread = 4): LeadEvidenceRow[] {
  const out: LeadEvidenceRow[] = [];
  for (let i = 0; i < n; i++) out.push({ band, skip: mid + ((i % 5) - 2) * (spread / 2) });
  return out;
}

// ── the reading-load measure ────────────────────────────────────────────────

test("promptWords counts on-screen words and survives the bank's ragged whitespace", () => {
  assert.equal(promptWords("WHICH ONE DOES NOT BELONG?"), 5);
  assert.equal(promptWords("WHAT COMES NEXT?"), 3);
  // authored prompts carry newlines from the raw-text re-import
  assert.equal(promptWords("GOAT IS TO KID AS\nHEN IS TO ?"), 9);
  assert.equal(promptWords("  spaced   out  "), 2);
  assert.equal(promptWords(""), 0);
  assert.equal(promptWords(null), 0);
});

test("bandOf splits where the evidence splits, and never throws on junk", () => {
  assert.equal(bandOf(3), "short");     // number series
  assert.equal(bandOf(5), "short");     // odd-one-out
  assert.equal(bandOf(6), "medium");    // position
  assert.equal(bandOf(9), "medium");    // verbal analogy
  assert.equal(bandOf(10), "long");
  assert.equal(bandOf(15), "long");     // number analogy
  assert.equal(bandOf(0), "medium");    // unknown -> the neutral band, never "short"
  assert.equal(bandOf(NaN), "medium");
});

// ── the evidence gate ───────────────────────────────────────────────────────

test("EVIDENCE GATE: a band below the min sample cannot move the mix, however good it looks", () => {
  // 5 posts at a wildly better skip rate than 30 posts of everything else.
  const ev = [...rows("short", 5, 40), ...rows("medium", 15, 72), ...rows("long", 15, 72)];
  const p = computeLeadPolicy(ev);
  const short = p.bands.find((b) => b.band === "short")!;
  assert.equal(short.passes, false, "n=5 must not promote");
  assert.match(short.reason, /needs 12/);
  assert.equal(p.applied, false);
  for (const b of LEAD_BANDS) assert.ok(Math.abs(p.shares[b] - 1 / 3) < 1e-9, "shares stay even");
});

test("EVIDENCE GATE: enough posts but an overlapping interval still does not move the mix", () => {
  // 14 posts per band, all centred on the same place with real spread -> nothing separates.
  const ev = [...rows("short", 14, 69, 14), ...rows("medium", 14, 70, 14), ...rows("long", 14, 71, 14)];
  const p = computeLeadPolicy(ev);
  assert.equal(p.applied, false, "overlapping bands must not promote");
  for (const b of p.bands) assert.match(b.reason, /indistinguishable|needs/);
});

test("EVIDENCE GATE: on the REAL evidence, the short band promotes and ONLY the short band", () => {
  const p = computeLeadPolicy(realEvidence());
  const [short, med, lng] = ["short", "medium", "long"].map((b) => p.bands.find((x) => x.band === b)!);

  assert.equal(short.n, 17);
  assert.equal(short.passes, true, "the one band the data separates must fire");
  assert.ok((short.advantage as number) > 0, "short retains BETTER, so advantage is positive");
  assert.ok(short.share > 1 / 3, "and it takes more of the openings than an even draw");
  assert.equal(p.applied, true);

  // The two that the data does NOT separate must stay level with each other. Medium's
  // median (72.5) is the worst of the three and long's (71.0) is close behind, so a
  // weaker gate would happily "promote" one over the other on 13 and 14 noisy posts.
  assert.equal(med.passes, false, `medium must not promote: ${med.reason}`);
  assert.equal(lng.passes, false, `long must not promote: ${lng.reason}`);
  assert.match(med.reason, /indistinguishable/);
  assert.match(lng.reason, /indistinguishable/);
  assert.ok(Math.abs(med.share - lng.share) < 1e-9, "bands that did not separate stay level");
});

test("EVIDENCE GATE: the real short-band advantage is ~9 points and buys a bounded shift", () => {
  const p = computeLeadPolicy(realEvidence());
  const short = p.bands.find((b) => b.band === "short")!;
  assert.ok((short.advantage as number) > 6 && (short.advantage as number) < 13,
    `expected roughly the measured +9 pts, got ${short.advantage}`);
  // a ~9-point advantage against a 10-point scale is a large but not unlimited move
  assert.ok(short.share > 0.42 && short.share < 0.55,
    `short share ${short.share} should be a real shift, still short of the cap`);
});

test("EVIDENCE GATE: a band that measures WORSE is cut, not silently ignored", () => {
  const ev = [...rows("short", 14, 70), ...rows("medium", 14, 70), ...rows("long", 14, 85)];
  const p = computeLeadPolicy(ev);
  const lng = p.bands.find((b) => b.band === "long")!;
  assert.equal(lng.passes, true);
  assert.ok((lng.advantage as number) < 0, "long retains worse");
  assert.ok(lng.share < 1 / 3, "so it gets FEWER openings");
  assert.ok(lng.share >= MIN_SHARE - 1e-9, "but never fewer than the exploration floor");
});

test("the switch turns everything off without touching the evidence", () => {
  const ev = [...rows("short", 20, 55), ...rows("medium", 20, 80), ...rows("long", 20, 80)];
  const on = computeLeadPolicy(ev, { enabled: true });
  const off = computeLeadPolicy(ev, { enabled: false });
  assert.equal(on.applied, true);
  assert.equal(off.applied, false);
  for (const b of LEAD_BANDS) assert.ok(Math.abs(off.shares[b] - 1 / 3) < 1e-9);
  // the numbers are still computed and reported, so the ledger stays honest while off
  assert.equal(off.bands.find((b) => b.band === "short")!.n, 20);
  assert.ok(off.bands.every((b) => /switched off/.test(b.reason)));
});

test("a missing skip rate is dropped, never counted as a zero", () => {
  const ev: LeadEvidenceRow[] = [
    ...rows("short", 14, 62),
    ...rows("medium", 14, 71),
    ...rows("long", 14, 71),
    { band: "short", skip: NaN as unknown as number },
  ];
  const p = computeLeadPolicy(ev);
  assert.equal(p.bands.find((b) => b.band === "short")!.n, 14, "the NaN row must not be counted");
  // a fabricated 0 would look like a perfect hook and drag the median hard
  assert.ok((p.bands.find((b) => b.band === "short")!.median as number) > 50);
});

// ── the exploration floor ───────────────────────────────────────────────────

test("EXPLORATION FLOOR: one option can never take the whole batch", () => {
  // an absurd advantage that would zero the other two under naive normalisation
  const s = clampShares({ short: 100, medium: 0, long: 0 });
  assert.ok(s.short <= MAX_SHARE + 1e-9, `short ${s.short} must not exceed the cap`);
  assert.ok(s.medium >= MIN_SHARE - 1e-9 && s.long >= MIN_SHARE - 1e-9, "both others keep the floor");
  assert.ok(Math.abs(s.short + s.medium + s.long - 1) < 1e-9, "shares still sum to 1");
});

test("EXPLORATION FLOOR: clamping cannot push another band back out of bounds", () => {
  // The bug a plain clamp-then-renormalise has: fixing one share re-inflates another.
  const s = clampShares({ short: 90, medium: 9, long: 1 });
  for (const b of LEAD_BANDS) {
    assert.ok(s[b] >= MIN_SHARE - 1e-9, `${b} ${s[b]} below floor`);
    assert.ok(s[b] <= MAX_SHARE + 1e-9, `${b} ${s[b]} above cap`);
  }
  assert.ok(Math.abs(s.short + s.medium + s.long - 1) < 1e-9);
});

test("EXPLORATION FLOOR: a full day's batch always ships every band", () => {
  const p = computeLeadPolicy([...rows("short", 30, 55), ...rows("medium", 30, 82), ...rows("long", 30, 82)]);
  const alloc = allocateLeadBands(12, p.shares);
  assert.equal(alloc.length, 12);
  for (const b of LEAD_BANDS) {
    assert.ok(alloc.filter((x) => x === b).length >= 1, `${b} was wiped out of a 12-slot batch`);
  }
  assert.ok(alloc.filter((x) => x === "short").length <= 7, "and the favourite cannot take them all");
});

test("allocation is exact, interleaved, and degrades sanely on tiny batches", () => {
  const even = { short: 1 / 3, medium: 1 / 3, long: 1 / 3 };
  assert.equal(allocateLeadBands(12, even).length, 12);
  assert.equal(allocateLeadBands(0, even).length, 0);
  assert.equal(allocateLeadBands(1, even).length, 1);
  assert.deepEqual([...new Set(allocateLeadBands(3, even))].sort(), ["long", "medium", "short"]);
  // interleaved, not blocked: the first three slots of a full batch are not all one band
  const skewed = computeLeadPolicy([...rows("short", 30, 58), ...rows("medium", 30, 80), ...rows("long", 30, 80)]);
  const a = allocateLeadBands(12, skewed.shares);
  assert.ok(new Set(a.slice(0, 3)).size > 1, "a run cut short must still ship a mix");
});

// ── determinism ─────────────────────────────────────────────────────────────

test("the verdict is deterministic — the same evidence always gives the same shares", () => {
  const ev = [...rows("short", 17, 62.3), ...rows("medium", 13, 72.5), ...rows("long", 14, 71.0)];
  const a = computeLeadPolicy(ev);
  const b = computeLeadPolicy(ev);
  assert.deepEqual(a.shares, b.shares);
  assert.deepEqual(
    a.bands.map((x) => [x.ci_lo, x.ci_hi]),
    b.bands.map((x) => [x.ci_lo, x.ci_hi]),
    "a seeded bootstrap must reproduce, or a ledger entry cannot be audited",
  );
});

test("median and the bootstrap interval behave on the shapes that actually occur", () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(bootstrapMedianCI([70, 71], 1), null, "two posts cannot yield an interval");
  const ci = bootstrapMedianCI([60, 61, 62, 63, 64, 65, 66], 1)!;
  assert.ok(ci[0] <= 63 && ci[1] >= 63, "the interval must contain the sample median");
  assert.ok(ci[0] >= 60 && ci[1] <= 66, "and cannot escape the observed range");
});

// ── recovering the opening question from what the repo already stores ───────

test("normType folds the db's two spellings of the same question type together", () => {
  assert.equal(normType("odd-one-out"), "ODD ONE OUT");
  assert.equal(normType("ODD ONE OUT"), "ODD ONE OUT");
  assert.equal(normType("word-analogy"), "VERBAL ANALOGY");
  assert.equal(normType("VERBAL ANALOGY"), "VERBAL ANALOGY");
  assert.equal(normType(undefined), "");
});

test("typeWordTable reads prompt lengths off the bank instead of hardcoding them", () => {
  const t = typeWordTable([
    { sig: "a", tier: "ODD ONE OUT", prompt: "WHICH ONE DOES NOT BELONG?" },
    { sig: "b", tier: "odd-one-out", prompt: "WHICH ONE DOES NOT BELONG?" },
    { sig: "c", tier: "NUMBER ANALOGY", prompt: "WHICH NUMBER FITS 2 2 3 4 4 6 7 ?" },
    // a type with authored variation takes the median rather than the first it sees
    { sig: "d", tier: "SENTENCE COMPLETION", prompt: "one two three four five six seven eight nine ten eleven" },
    { sig: "e", tier: "SENTENCE COMPLETION", prompt: "one two three four five six seven eight nine ten eleven twelve thirteen" },
    { sig: "f", tier: "SENTENCE COMPLETION", prompt: "one two three four five six seven eight nine ten eleven twelve" },
  ]);
  assert.equal(t["ODD ONE OUT"], 5);
  assert.equal(t["NUMBER ANALOGY"], 11);
  assert.equal(t["SENTENCE COMPLETION"], 12);
});

test("leadWordsFor prefers the exact record and falls back in a stated order", () => {
  const ctx = {
    bySig: new Map([["sig-1", { sig: "sig-1", tier: "ODD ONE OUT", prompt: "WHICH ONE DOES NOT BELONG?" }]]),
    bySlug: new Map([["2026-08-01-v07", { questions: [{ sig: "sig-1" }] }]]),
    typeWords: { "VERBAL ANALOGY": 9 },
  };
  // 1. stamped wins
  assert.deepEqual(
    leadWordsFor({ variant: { lead_prompt_words: 5, lead_type: "ODD ONE OUT", question_types: ["VERBAL ANALOGY"] } }, ctx),
    { words: 5, type: "ODD ONE OUT", via: "stamped" },
  );
  // 2. then the usage ledger, which knows the question that actually shipped
  assert.deepEqual(
    leadWordsFor({ _hermes_key: "hermes:2026-08-01-v07:instagram", variant: { question_types: ["VERBAL ANALOGY"] } }, ctx),
    { words: 5, type: "ODD ONE OUT", via: "ledger" },
  );
  // 3. then the type table, for legacy posts with no ledger row
  assert.deepEqual(
    leadWordsFor({ variant: { question_types: ["word-analogy"] } }, ctx),
    { words: 9, type: "VERBAL ANALOGY", via: "type" },
  );
  // and an unattributable post contributes NOTHING rather than a guess
  assert.equal(leadWordsFor({ variant: {} }, ctx), null);
  assert.equal(leadWordsFor({ variant: { question_types: ["NEVER HEARD OF IT"] } }, ctx), null);
});

test("MIN_POSTS_PER_BAND is one full day of production, so the gate can actually fire", () => {
  assert.equal(MIN_POSTS_PER_BAND, 12);
});

// ── the steer, where it meets real question selection ───────────────────────

/** A bank-shaped question. `tier` is the TYPE; prompt length is what the steer reads. */
function q(sig: string, tier: string, prompt: string, kind = "text"): any {
  return { sig, hash: sig, kind, category: "verbal", tier, prompt, options: ["A", "B", "C"], answer: "A" };
}
const ODD = (n: number) => q(`odd-${n}`, "ODD ONE OUT", "WHICH ONE DOES NOT BELONG?");
const VERB = (n: number) => q(`verb-${n}`, "VERBAL ANALOGY", "GOAT IS TO KID AS HEN IS TO ?");
const NUMA = (n: number) => q(`numa-${n}`, "NUMBER ANALOGY", "WHICH NUMBER FITS 2 2 3 4 4 6 7 IN PLACE OF THE MARK ?", "numseries");
const FIGS = (n: number) => q(`figs-${n}`, "FIGURE SERIES", "which shape comes next");

test("STEER: the opening slot honours the requested band, and only the opening slot", () => {
  const pool = [NUMA(1), VERB(1), ODD(1), NUMA(2), VERB(2), ODD(2)];
  const picked = selectSpread(pool, 3, newSpreadTally(), ["short"], Infinity);
  assert.equal(picked[0].tier, "ODD ONE OUT", "question one must come from the requested band");
  assert.equal(bandOf(promptWords(picked[0].prompt)), "short");
  // the other two are still chosen for spread, not for band
  assert.equal(new Set(picked.map((p: any) => p.tier)).size, 3, "in-video type variety survives the steer");
});

test("STEER: with no band requested, selection is exactly what it was before", () => {
  const pool = [NUMA(1), VERB(1), ODD(1), NUMA(2), VERB(2), ODD(2)];
  const before = selectSpread(pool, 3, newSpreadTally()).map((x: any) => x.sig);
  const withEmpty = selectSpread(pool, 3, newSpreadTally(), []).map((x: any) => x.sig);
  assert.deepEqual(withEmpty, before, "an empty preference list must not change the old behaviour");
  assert.deepEqual(before, ["numa-1", "verb-1", "odd-1"], "and the old behaviour is pool order under spread");
});

test("VARIETY CAP: a band supplied by ONE type cannot take the whole batch's openings", () => {
  // This is the live situation: the near-duplicate guard has exhausted number series, so
  // the short band is odd-one-out and nothing else. Without a cap, a 49% short share
  // would open five, six, eventually every video with the same line.
  const pool: any[] = [];
  for (let i = 0; i < 40; i++) pool.push(ODD(i), VERB(i), NUMA(i));
  const batch = newSpreadTally();
  const cap = leadTypeCap(12);
  assert.equal(cap, 5, "40% of a twelve-video day, rounded up");
  const opens: string[] = [];
  for (let i = 0; i < 12; i++) {
    const picked = selectSpread(pool.filter((p) => !opens.includes(p.sig)), 3, batch, ["short", "medium", "long"], cap);
    opens.push(picked[0].sig);
  }
  const odd = opens.filter((s) => s.startsWith("odd-")).length;
  assert.equal(odd, cap, `odd-one-out must stop at the cap, opened ${odd} of 12`);
  assert.ok(new Set(opens.map((s) => s.split("-")[0])).size >= 2, "the batch must open more than one way");
});

test("VARIETY CAP: within a band that HAS several types, openings rotate across them", () => {
  const pool: any[] = [];
  for (let i = 0; i < 20; i++) pool.push(ODD(i), FIGS(i), VERB(i));
  const batch = newSpreadTally();
  const opens: string[] = [];
  const used = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const picked = selectSpread(pool.filter((p) => !used.has(p.sig)), 3, batch, ["short"], leadTypeCap(12));
    for (const p of picked) used.add(p.sig);
    opens.push(picked[0].tier);
  }
  // both short types exist, so the opener must alternate rather than drain one
  assert.deepEqual(opens, ["ODD ONE OUT", "FIGURE SERIES", "ODD ONE OUT", "FIGURE SERIES"]);
});

test("STEER: an exhausted band yields to the NEXT band, never to a dropped video", () => {
  // no short questions at all in the pool
  const pool = [VERB(1), NUMA(1), VERB(2), NUMA(2), VERB(3), NUMA(3)];
  const picked = selectSpread(pool, 3, newSpreadTally(), ["short", "medium", "long"], Infinity);
  assert.equal(picked.length, 3, "the video still ships");
  assert.equal(bandOf(promptWords(picked[0].prompt)), "medium", "and falls to the next-best band");
});

test("STEER: when every band is capped out the video still ships", () => {
  const batch = newSpreadTally();
  batch.lead = { "ODD ONE OUT": 99, "VERBAL ANALOGY": 99, "NUMBER ANALOGY": 99 };
  const pool = [ODD(1), VERB(1), NUMA(1)];
  const picked = selectSpread(pool, 3, batch, ["short", "medium", "long"], 5);
  assert.equal(picked.length, 3, "the cap must never cost the day a video");
});
