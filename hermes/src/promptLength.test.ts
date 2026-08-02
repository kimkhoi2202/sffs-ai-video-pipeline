/**
 * promptLength.test.ts — the 2026-08-02 prompt shortening, and the three ways it could
 * quietly go wrong.
 *
 * WHAT WAS DONE. Prompt length is the one property of the opening question that tracks
 * the 3-second skip rate (leadPolicy.ts): <=5 words medians 62.3%, >=10 medians 71.0%,
 * p = 0.0008. Length and TYPE were perfectly confounded, because the bank shipped one
 * fixed prompt per type, so the weighting engine could only reshuffle toward odd-one-out.
 * content/shorten-prompts.mjs cut six types' prompts instead, which applies the finding
 * to every video AND breaks the confound — the same type now ships at two lengths either
 * side of the change, so the within-type contrast can eventually separate them.
 *
 * These tests exist because all three failure modes are SILENT — nothing throws, the
 * cycle keeps producing videos, and the damage only shows up as a wrong decision later:
 *
 *   1. A shortened plate that reads as a fragment when the host says it out loud. The
 *      prompt is ONE string used for both surfaces, so this is a real risk, not a
 *      hypothetical: "HOT -> COLD" must still be spoken "HOT is to COLD".
 *   2. A future bank import quietly re-lengthening a type, or a later pass "tidying" the
 *      prompts that were left long ON PURPOSE because their words carry the item.
 *   3. The bank edit retro-rewriting history. buildLeadEvidence rebuilds each published
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

test("VO: an arrow plate is still spoken as a full analogy", () => {
  assert.equal(speakPrompt("HOT -> COLD\nDAY -> ?"), "HOT is to COLD, DAY is to?");
  assert.equal(
    speakPrompt("CATERPILLAR -> BUTTERFLY\nTADPOLE -> ?"),
    "CATERPILLAR is to BUTTERFLY, TADPOLE is to?",
  );
});

test("VO: a number-analogy mapping speaks its numbers as words, never as arrows", () => {
  const said = speakPrompt("2 -> 3,   3 -> 5,   4 -> 7,   5 -> ?");
  assert.equal(said, "two is to three, three is to five, four is to seven, five is to?");
  assert.ok(!/->/.test(said), "a raw arrow must never reach TTS");
});

test("VO: the unicode arrow is handled too, so notation drift cannot break the read", () => {
  assert.equal(speakPrompt("HOT → COLD\nDAY → ?"), "HOT is to COLD, DAY is to?");
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

test("BANK: the six shortened types stay short, and none drifts back", () => {
  const byTier = liveByTier();
  // tier -> the exact word count every one of its prompts must now have
  const PINNED: Record<string, number> = {
    "ODD ONE OUT": 4,
    "VERBAL ANALOGY": 6,
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
  for (const p of byTier.get("VERBAL ANALOGY") ?? []) {
    assert.ok(/^[^\n]+ -> [^\n]+\n[^\n]+ -> \?$/.test(p), `not the arrow shape: ${JSON.stringify(p)}`);
    assert.ok(!/ IS TO /.test(p), `"IS TO" scaffolding survived: ${p}`);
  }
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
 * The whole point of ops/freeze_lead_words.mjs. A post published under the OLD 9-word
 * verbal analogy has to keep reporting nine words even though the bank entry it points
 * at now says six — otherwise shortening the bank silently restates the campaign as
 * having always run short openings, and the contrast the policy rests on disappears.
 */
test("EVIDENCE: a stamped post keeps its published length even when the bank now disagrees", () => {
  const ctx = {
    bySig: new Map([["sig-1", { sig: "sig-1", tier: "VERBAL ANALOGY", prompt: "HOT -> COLD\nDAY -> ?" }]]),
    bySlug: new Map([["slug-1", { questions: [{ sig: "sig-1", tier: "VERBAL ANALOGY" }] }]]),
    typeWords: { "VERBAL ANALOGY": 6 },
  };
  const published = {
    _hermes_key: "hermes:slug-1",
    variant: { lead_prompt_words: 9, lead_type: "VERBAL ANALOGY", question_types: ["VERBAL ANALOGY"] },
  };
  assert.deepEqual(leadWordsFor(published, ctx as any), {
    words: 9,
    type: "VERBAL ANALOGY",
    via: "stamped",
  });
  assert.equal(bandOf(9), "medium", "and it stays in the band it was published in");

  // An UNSTAMPED post is the hazard the freeze removed: it resolves against today's bank.
  const unstamped = { _hermes_key: "hermes:slug-1", variant: { question_types: ["VERBAL ANALOGY"] } };
  assert.equal(leadWordsFor(unstamped, ctx as any)?.words, 6);
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
  assert.deepEqual(leadStamp({ tier: "VERBAL ANALOGY", prompt: "HOT -> COLD\nDAY -> ?" }), {
    lead_type: "VERBAL ANALOGY",
    lead_prompt_words: 6,
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
