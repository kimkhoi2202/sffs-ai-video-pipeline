/**
 * promptLength.test.ts — the 2026-08-02 prompt shortening, and the three ways it could
 * quietly go wrong.
 *
 * WHAT WAS DONE. Prompt length is the one property of the opening question that tracks
 * the 3-second skip rate (leadPolicy.ts): <=5 words medians 62.3%, >=10 medians 71.0%,
 * p = 0.0008. Length and TYPE were perfectly confounded, because the bank shipped one
 * fixed prompt per type, so the weighting engine could only reshuffle toward odd-one-out.
 * content/shorten-prompts.mjs cuts five types' prompts instead, which applies the finding
 * to every video AND loosens the confound — those types now ship at two lengths either
 * side of the change, so a within-type contrast becomes possible.
 *
 * A SIXTH WAS TRIED AND REVERTED. Verbal analogy went 9w -> 6w by swapping "IS TO ... AS"
 * for an arrow, and went back, because fewer words is only a PROXY for less to parse and
 * the two come apart at notation an eight-year-old has to learn first. That decision is
 * load-bearing for the whole file: the rules that remain all delete scaffolding and leave
 * meaning in plain words, and the tests below pin both halves of it.
 *
 * These tests exist because all four failure modes are SILENT — nothing throws, the
 * cycle keeps producing videos, and the damage only shows up as a wrong decision later:
 *
 *   1. A shortened plate that reads as a fragment when the host says it out loud. The
 *      prompt is ONE string used for both surfaces, so this is a real risk, not a
 *      hypothetical: the arrow in a number-analogy mapping must reach TTS as "is to".
 *   2. A future bank import quietly re-lengthening a type, or a later pass "tidying" the
 *      prompts that were left long ON PURPOSE because their words carry the item.
 *   3. The arrow rewrite creeping back into verbal analogy, where it was judged to cost
 *      more in comprehension than it saves in reading.
 *   4. The bank edit retro-rewriting history. buildLeadEvidence rebuilds each published
 *      post's word count out of the CURRENT bank, so a prompt edit would restate the
 *      campaign as always-short unless the stamped value wins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { speakPrompt } from "./narration.ts";
import { loadBank, toHermesQ } from "./questions.ts";
import { promptWords, bandOf } from "./leadPolicy.ts";
import { leadWordsFor, leadStamp } from "./leadPromotion.ts";
import { quantVerdict } from "./arithmetic.ts";

// ── 1. The spoken surface ────────────────────────────────────────────────────

/**
 * NUMBER ANALOGY is the only live type that puts an arrow on the plate, and it always
 * has — the mapping table shipped "2 -> 3" long before any of this. Until speakPrompt
 * existed the raw glyph went straight to TTS, so this expansion is a fix in its own
 * right, independent of the shortening that prompted it.
 */
test("VO: a number-analogy mapping speaks its numbers as words, never as arrows", () => {
  const said = speakPrompt("2 -> 3,   3 -> 5,   4 -> 7,   5 -> ?");
  assert.equal(said, "two is to three, three is to five, four is to seven, five is to?");
  assert.ok(!/->/.test(said), "a raw arrow must never reach TTS");
});

test("VO: the unicode arrow is handled too, so notation drift cannot break the read", () => {
  assert.equal(speakPrompt("2 → 6,   3 → 9,   4 → 12,   5 → ?"), "two is to six, three is to nine, four is to twelve, five is to?");
});

/**
 * VERBAL ANALOGY briefly shipped as "HOT -> COLD / DAY -> ?" and was reverted, so the
 * arrow branch must not touch it any more. Pinned because the failure would be quiet:
 * speakPrompt turns authored line breaks into COMMAS on an arrow prompt, and if a verbal
 * analogy ever took that branch the host would read "HOT is to COLD, DAY is to?" over a
 * plate that says "AS" — the two surfaces disagreeing with nothing to show for it.
 */
test("VO: a verbal analogy takes the plain path and is read exactly as written", () => {
  assert.equal(
    speakPrompt("HOT IS TO COLD AS\nDAY IS TO ?"),
    "HOT IS TO COLD AS DAY IS TO ?",
  );
  assert.equal(
    speakPrompt("CATERPILLAR IS TO BUTTERFLY AS\nTADPOLE IS TO ?"),
    "CATERPILLAR IS TO BUTTERFLY AS TADPOLE IS TO ?",
  );
});

/**
 * The newline-to-comma rule is scoped to arrow prompts on purpose. SENTENCE COMPLETION
 * wraps ONE sentence over three authored lines, and turning those breaks into commas
 * would have the host pause mid-clause. This pins the scoping, not just the feature.
 */
test("VO: a non-arrow prompt is untouched — line breaks stay spaces, blanks stay 'what'", () => {
  assert.equal(
    speakPrompt("THE RAIN POURED ALL DAY, SO THE\nSCHOOL HAD TO ______ THE OUTDOOR\nGAMES."),
    "THE RAIN POURED ALL DAY, SO THE SCHOOL HAD TO what THE OUTDOOR GAMES.",
  );
  assert.equal(
    speakPrompt("ALL CATS PURR.\nMILO IS A CAT.\nSO MILO PURRS."),
    "ALL CATS PURR. MILO IS A CAT. SO MILO PURRS.",
  );
});

test("VO: every live question speaks without leaving a raw arrow behind", () => {
  for (const e of loadBank()) {
    const q = toHermesQ(e);
    if (!q || q.kind !== "text") continue;
    assert.ok(!/(?:->|→)/.test(speakPrompt(q.prompt)), `raw arrow survived: ${q.prompt}`);
  }
});

// ── 2. The bank, and what was deliberately left alone ────────────────────────

const liveByTier = () => {
  const out = new Map<string, string[]>();
  for (const e of loadBank()) {
    const q = toHermesQ(e);
    if (!q || (q.kind !== "text" && q.kind !== "numseries")) continue;
    const t = String(q.tier ?? "").toUpperCase();
    (out.get(t) ?? out.set(t, []).get(t)!).push(q.prompt);
  }
  return out;
};

test("BANK: the five shortened types stay short, and none drifts back", () => {
  const byTier = liveByTier();
  // tier -> the exact word count every one of its prompts must now have
  const PINNED: Record<string, number> = {
    "ODD ONE OUT": 4,
    "NUMBER ANALOGY": 12,
    ANTONYM: 3,
    SYNONYM: 4,
  };
  for (const [tier, want] of Object.entries(PINNED)) {
    const prompts = byTier.get(tier) ?? [];
    assert.ok(prompts.length > 0, `${tier} vanished from the live pool`);
    for (const p of prompts) {
      assert.equal(promptWords(p), want, `${tier} drifted to ${promptWords(p)}w: ${JSON.stringify(p)}`);
    }
  }
  // COMPARE is authored per-item, so it gets a ceiling rather than an exact count.
  for (const p of byTier.get("COMPARE") ?? []) {
    assert.ok(promptWords(p) <= 5, `COMPARE should be in the short band: ${p}`);
  }
});

test("BANK: the shortening removed the scaffolding it claimed to remove", () => {
  const byTier = liveByTier();
  for (const p of byTier.get("NUMBER ANALOGY") ?? []) {
    assert.ok(!/WHICH NUMBER FITS/.test(p), `instruction line survived: ${p}`);
  }
  for (const p of byTier.get("ODD ONE OUT") ?? []) {
    assert.equal(p, "WHICH DOES NOT BELONG?");
  }
});

/**
 * THE TYPES LEFT LONG ARE LEFT LONG ON PURPOSE. Their prompts are not an instruction
 * wrapped around an item — they ARE the item, and a later "make everything <=5 words"
 * pass would be deleting the question rather than shortening it. This test is the
 * tripwire for that, and it is the reason the failure would otherwise be invisible: a
 * truncated word problem still renders, still narrates, and is simply unanswerable.
 */
/**
 * THE VERBAL-ANALOGY REVERT, pinned so it cannot be quietly undone.
 *
 * "X IS TO Y AS / A IS TO ?" was shortened to "X -> Y / A -> ?" (9w -> 6w) and reverted
 * on purpose. Fewer words is a PROXY for less to parse, and the two come apart exactly
 * here: arrow notation is a learned convention, an eight-year-old may not have learned
 * it, and a plate that is shorter but more cryptic can cost more in comprehension than
 * it saves in reading — on the largest type in the pool, where it would show up as MORE
 * skipping. Re-applying it is not a refactor; it needs an experiment that can separate
 * comprehension from reading load.
 */
test("BANK: verbal analogy stays in plain words, not arrow notation", () => {
  const prompts = liveByTier().get("VERBAL ANALOGY") ?? [];
  assert.ok(prompts.length > 300, "verbal analogy is the largest live type; it should be here");
  for (const p of prompts) {
    assert.equal(promptWords(p), 9, `verbal analogy should be 9 plain words: ${JSON.stringify(p)}`);
    assert.ok(/ IS TO .* AS\n.* IS TO \?$/.test(p), `not the plain-English shape: ${JSON.stringify(p)}`);
    assert.ok(!/(?:->|→)/.test(p), `arrow notation came back: ${JSON.stringify(p)}`);
  }
});

test("BANK: the types that carry meaning in their words were not cut", () => {
  const byTier = liveByTier();
  for (const p of byTier.get("NUMBER PUZZLE") ?? []) {
    assert.ok(/^IF\b/.test(p) && /\bTHEN\b/.test(p), `IF/THEN is load-bearing here: ${p}`);
  }
  for (const p of byTier.get("SENTENCE COMPLETION") ?? []) {
    assert.ok(promptWords(p) >= 10, `the sentence IS the item; do not trim it: ${p}`);
    assert.ok(/_/.test(p), `a sentence completion needs its blank: ${p}`);
  }
  for (const p of byTier.get("NUMBER SERIES") ?? []) {
    assert.equal(p, "WHAT COMES NEXT?", "already minimal at 3 words");
  }
});

test("BANK: shortening cost no questions and no bands collapsed", () => {
  const entries = loadBank();
  const usable = entries.filter((e) => toHermesQ(e) !== null);
  assert.equal(usable.length, entries.length, "toHermesQ must still accept every entry");

  const bands = new Set<string>();
  for (const [, prompts] of liveByTier()) for (const p of prompts) bands.add(bandOf(promptWords(p)));
  assert.ok(bands.size >= 2, "the weighting engine needs more than one band to choose between");
});

test("BANK: the mechanical gate still parses a number analogy with no instruction line", () => {
  const nas = loadBank().map(toHermesQ).filter((q) => q && q.tier === "NUMBER ANALOGY");
  assert.ok(nas.length > 0);
  for (const q of nas) {
    const v = quantVerdict(q!);
    assert.ok(v.handled, `stopped being mechanically checkable: ${q!.prompt}`);
  }
});

// ── 3. History must not be rewritten by a bank edit ──────────────────────────

/**
 * The whole point of ops/freeze_lead_words.mjs, shown on the type where it actually
 * bites. A post published under the OLD 15-word number analogy has to keep reporting
 * fifteen even though the bank entry it points at now says twelve — otherwise editing
 * the bank silently restates the campaign as having always run shorter openings, and
 * the contrast the policy rests on disappears. Note the band flips too (long -> long
 * here, but ODD ONE OUT 5 -> 4 and SYNONYM 7 -> 4 both cross), so this is not a
 * rounding difference: it would move posts between the very buckets being compared.
 */
test("EVIDENCE: a stamped post keeps its published length even when the bank now disagrees", () => {
  const shortened = "2 -> 3,   3 -> 5,   4 -> 7,   5 -> ?"; // 12 words, today's bank
  const ctx = {
    bySig: new Map([["sig-1", { sig: "sig-1", tier: "NUMBER ANALOGY", prompt: shortened }]]),
    bySlug: new Map([["slug-1", { questions: [{ sig: "sig-1", tier: "NUMBER ANALOGY" }] }]]),
    typeWords: { "NUMBER ANALOGY": 12 },
  };
  const published = {
    _hermes_key: "hermes:slug-1",
    variant: { lead_prompt_words: 15, lead_type: "NUMBER ANALOGY", question_types: ["NUMBER ANALOGY"] },
  };
  assert.deepEqual(leadWordsFor(published, ctx as any), {
    words: 15,
    type: "NUMBER ANALOGY",
    via: "stamped",
  });

  // An UNSTAMPED post is the hazard the freeze removed: it resolves against today's bank.
  const unstamped = { _hermes_key: "hermes:slug-1", variant: { question_types: ["NUMBER ANALOGY"] } };
  assert.equal(leadWordsFor(unstamped, ctx as any)?.words, 12);
});

/**
 * The publish-time stamp itself — cycle.ts spreads leadStamp(v.questions[0]) into every
 * post record it writes. Worth pinning directly: if lead_band and lead_prompt_words ever
 * disagreed, the ledger would sort posts into bands their word counts contradict, and
 * the only symptom would be a policy that slowly stops matching its own evidence table.
 */
test("EVIDENCE: the publish-time stamp records length, type and a band that agrees", () => {
  assert.deepEqual(leadStamp({ tier: "odd-one-out", prompt: "WHICH DOES NOT BELONG?" }), {
    lead_type: "ODD ONE OUT",
    lead_prompt_words: 4,
    lead_band: "short",
  });
  assert.deepEqual(leadStamp({ tier: "VERBAL ANALOGY", prompt: "HOT IS TO COLD AS\nDAY IS TO ?" }), {
    lead_type: "VERBAL ANALOGY",
    lead_prompt_words: 9,
    lead_band: "medium",
  });
  assert.deepEqual(leadStamp({ tier: "NUMBER ANALOGY", prompt: "2 -> 3,   3 -> 5,   4 -> 7,   5 -> ?" }), {
    lead_type: "NUMBER ANALOGY",
    lead_prompt_words: 12,
    lead_band: "long",
  });
  // The band is always derivable from the count it ships with, for every live question.
  for (const e of loadBank()) {
    const q = toHermesQ(e);
    if (!q) continue;
    const s = leadStamp(q);
    assert.equal(s.lead_band, bandOf(s.lead_prompt_words));
    assert.equal(s.lead_prompt_words, promptWords(q.prompt));
  }
});
