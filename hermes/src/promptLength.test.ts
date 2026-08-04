/**
 * promptLength.test.ts — the prompt-shortening episode, now withdrawn, and the guards
 * that outlived it.
 *
 * WHAT HAPPENED. On 2026-08-02 (33aa690) six question types had their opening prompts
 * cut, on a finding that prompt LENGTH tracks the 3-second skip rate: <=6 words medians
 * 62.0%, >=9 words 71.4%, d = 0.84, positive within-day on 4 of 4 days. Verbal analogy
 * was put back the same day (339b6a4) because arrow notation trades reading load for
 * comprehension. The remaining five were put back on 2026-08-04, for a more basic reason:
 *
 *   In this bank prompt length is a DETERMINISTIC FUNCTION of question type. Eight of the
 *   twelve live types ship exactly one prompt length — verbal analogy 9 words on all 362
 *   entries, odd-one-out 5 on all 200, number analogy 15 on all 182 — and NO type contains
 *   both a <=6-word and a >=9-word opener. So "short opener" and "the odd-one-out /
 *   number-series family" are the same set of posts. The 9.4pp gap is real; the label on
 *   it was not. Rewording a prompt does not change its question type, so the change could
 *   not move whatever the gap was actually measuring. Question TYPE is now tested
 *   directly — see the `opening-question-type` dimension.
 *
 * WHAT SURVIVED, and why these tests still earn their place. Three of the four failure
 * modes the original file guarded are properties of the bank and the VO, not of the
 * shortening, and they are still silent failures — nothing throws, the cycle keeps
 * producing videos, and the damage only shows up as a wrong decision later:
 *
 *   1. A plate that reads as a fragment when the host says it out loud. The prompt is ONE
 *      string used for both surfaces, and NUMBER ANALOGY has always shipped "->" inside
 *      its mapping table, so speakPrompt() is a fix in its own right — it predates the
 *      shortening's need for it and outlives the withdrawal.
 *   2. A later pass "tidying" the types left long ON PURPOSE, whose words carry the item.
 *      A truncated word problem still renders, still narrates, and is unanswerable.
 *   3. The arrow rewrite creeping back into verbal analogy.
 *   4. A bank edit retro-rewriting history. This one cut both ways and is why the
 *      restoration was safe to run at all: buildLeadEvidence rebuilds each published
 *      post's word count from the CURRENT bank, so any prompt edit — shortening OR
 *      restoring — would restate the campaign unless the stamped value wins. 204 of 206
 *      records carry a stamp, and the two that do not carry no skip rate between them.
 *
 * SCOPE NOTE. The wording assertions below read the AUTHORED bank (slug !== "generated").
 * generate.ts's runway top-up admits items at <= MAX_GEN_PROMPT_WORDS under its own rules
 * and may legitimately add a shorter odd-one-out later; that is generate.ts's contract to
 * keep, not this file's. It has not fired yet — all 1,544 entries are authored.
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
 * right, independent of the shortening that prompted it and unaffected by its withdrawal.
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
  assert.equal(speakPrompt("HOT IS TO COLD AS\nDAY IS TO ?"), "HOT IS TO COLD AS DAY IS TO ?");
  assert.equal(
    speakPrompt("CATERPILLAR IS TO BUTTERFLY AS\nTADPOLE IS TO ?"),
    "CATERPILLAR IS TO BUTTERFLY AS TADPOLE IS TO ?",
  );
});

/**
 * The newline-to-comma rule is scoped to arrow prompts on purpose. SENTENCE COMPLETION
 * wraps ONE sentence over three authored lines, and turning those breaks into commas
 * would have the host pause mid-clause. This pins the scoping, not just the feature.
 *
 * It also now covers the RESTORED types, whose instruction line is separated from the
 * item by a newline: "WHICH WORD MEANS THE\nOPPOSITE OF ANCIENT?" must be read as one
 * sentence, and "WHICH NUMBER FITS?" must not turn into a comma before the mapping.
 */
test("VO: a non-arrow prompt is untouched — line breaks stay spaces, blanks stay 'what'", () => {
  assert.equal(
    speakPrompt("THE RAIN POURED ALL DAY, SO THE\nSCHOOL HAD TO ______ THE OUTDOOR\nGAMES."),
    "THE RAIN POURED ALL DAY, SO THE SCHOOL HAD TO what THE OUTDOOR GAMES.",
  );
  assert.equal(
    speakPrompt("WHICH WORD MEANS THE\nOPPOSITE OF ANCIENT?"),
    "WHICH WORD MEANS THE OPPOSITE OF ANCIENT?",
  );
});

test("VO: the restored number-analogy instruction line survives the arrow expansion", () => {
  // The prompt now carries BOTH an instruction line and arrows, which is the one shape
  // that exercises the arrow branch and the newline rule at the same time.
  const said = speakPrompt("WHICH NUMBER FITS?\n2 -> 3,   3 -> 5,   4 -> 7,   5 -> ?");
  assert.ok(!/(?:->|→)/.test(said), `a raw arrow survived: ${said}`);
  assert.ok(/WHICH NUMBER FITS/.test(said), `the instruction line was lost: ${said}`);
  assert.ok(/is to/.test(said), `the mapping was not expanded: ${said}`);
});

test("VO: every live question speaks without leaving a raw arrow behind", () => {
  for (const e of loadBank()) {
    const q = toHermesQ(e);
    if (!q || q.kind !== "text") continue;
    assert.ok(!/(?:->|→)/.test(speakPrompt(q.prompt)), `raw arrow survived: ${q.prompt}`);
  }
});

// ── 2. The bank, restored and left alone ─────────────────────────────────────

/** The AUTHORED pool, by type. Excludes generate.ts's runway top-up; see the scope note. */
const authoredByTier = () => {
  const out = new Map<string, string[]>();
  for (const e of loadBank()) {
    if (e.slug === "generated") continue;
    const q = toHermesQ(e);
    if (!q || (q.kind !== "text" && q.kind !== "numseries")) continue;
    const t = String(q.tier ?? "").toUpperCase();
    (out.get(t) ?? out.set(t, []).get(t)!).push(q.prompt);
  }
  return out;
};

test("BANK: the five shortened types are back in plain words", () => {
  const byTier = authoredByTier();
  // tier -> the exact word count every authored prompt must have again
  const RESTORED: Record<string, number> = {
    "ODD ONE OUT": 5,
    "NUMBER ANALOGY": 15,
    ANTONYM: 7,
    SYNONYM: 7,
  };
  for (const [tier, want] of Object.entries(RESTORED)) {
    const prompts = byTier.get(tier) ?? [];
    assert.ok(prompts.length > 0, `${tier} vanished from the live pool`);
    for (const p of prompts) {
      assert.equal(promptWords(p), want, `${tier} is still cut to ${promptWords(p)}w: ${JSON.stringify(p)}`);
    }
  }
  // COMPARE is authored per-item, so it gets its article back rather than an exact count.
  // The whitespace is \s+ because four of the five wrap onto a second line right there —
  // a line break the forward rule's own \s+ had silently swallowed along with the article.
  for (const p of byTier.get("COMPARE") ?? []) {
    assert.ok(/\bIS\s+THE (LARGEST|SMALLEST|GREATEST|LEAST)\b/.test(p), `COMPARE lost its article: ${JSON.stringify(p)}`);
  }
});

test("BANK: the scaffolding the shortening removed is back", () => {
  const byTier = authoredByTier();
  for (const p of byTier.get("NUMBER ANALOGY") ?? []) {
    assert.ok(/^WHICH NUMBER FITS\?\n/.test(p), `no instruction line — nothing says the answer is a number: ${p}`);
  }
  for (const p of byTier.get("ODD ONE OUT") ?? []) {
    assert.equal(p, "WHICH ONE DOES NOT BELONG?");
  }
  for (const p of byTier.get("ANTONYM") ?? []) {
    assert.ok(/^WHICH WORD MEANS THE\nOPPOSITE OF /.test(p), `antonym still cut: ${p}`);
  }
  for (const p of byTier.get("SYNONYM") ?? []) {
    assert.ok(/^WHICH WORD MEANS THE\nSAME AS /.test(p), `synonym still cut: ${p}`);
  }
});

/**
 * THE BANK AND THE CODE THAT FILLS IT NOW AGREE AGAIN, which is the second and entirely
 * independent reason the shortening should not have shipped. content/gen-rounds.mjs emits
 * "WHICH NUMBER FITS?\n..." and content/verbal-bank.mjs emits "WHICH ONE DOES NOT
 * BELONG?"; neither was ever updated. Every future authored round would therefore have
 * re-introduced the long wording next to the shortened entries and split each type across
 * two phrasings for no reason at all.
 */
test("BANK: the authored wording matches what the round generators emit", () => {
  const byTier = authoredByTier();
  assert.ok((byTier.get("ODD ONE OUT") ?? []).every((p) => p === "WHICH ONE DOES NOT BELONG?"));
  assert.ok((byTier.get("NUMBER ANALOGY") ?? []).every((p) => p.startsWith("WHICH NUMBER FITS?")));
});

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
  const prompts = authoredByTier().get("VERBAL ANALOGY") ?? [];
  assert.ok(prompts.length > 300, "verbal analogy is the largest live type; it should be here");
  for (const p of prompts) {
    assert.equal(promptWords(p), 9, `verbal analogy should be 9 plain words: ${JSON.stringify(p)}`);
    assert.ok(/ IS TO .* AS\n.* IS TO \?$/.test(p), `not the plain-English shape: ${JSON.stringify(p)}`);
    assert.ok(!/(?:->|→)/.test(p), `arrow notation came back: ${JSON.stringify(p)}`);
  }
});

test("BANK: the types that carry meaning in their words were never cut", () => {
  const byTier = authoredByTier();
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

test("BANK: restoring cost no questions and no bands collapsed", () => {
  const entries = loadBank();
  const usable = entries.filter((e) => toHermesQ(e) !== null);
  assert.equal(usable.length, entries.length, "toHermesQ must still accept every entry");

  const bands = new Set<string>();
  for (const [, prompts] of authoredByTier()) for (const p of prompts) bands.add(bandOf(promptWords(p)));
  assert.ok(bands.size >= 2, "the weighting engine needs more than one band to choose between");
});

test("BANK: the mechanical gate still parses a number analogy WITH its instruction line", () => {
  const nas = loadBank().map(toHermesQ).filter((q) => q && q.tier === "NUMBER ANALOGY");
  assert.ok(nas.length > 0);
  for (const q of nas) {
    const v = quantVerdict(q!);
    assert.ok(v.handled, `stopped being mechanically checkable: ${q!.prompt}`);
  }
});

// ── 3. History must not be rewritten by a bank edit, in EITHER direction ─────

/**
 * The whole point of ops/freeze_lead_words.mjs, and the reason this restoration was safe
 * to run at all. It bites hardest on NUMBER ANALOGY, which has now been 15 words, then 12,
 * then 15 again. A post published on 2026-08-02 or -03 shipped the 12-word plate and has
 * to keep reporting twelve, even though the bank entry it points at says fifteen again —
 * otherwise editing the bank silently restates those posts as having run the long opener,
 * and moves them between the very buckets being compared. The hazard is symmetric: the
 * shortening could have rewritten the campaign as always-short, and the restoration could
 * rewrite it as always-long. The stamp is what makes both harmless.
 */
test("EVIDENCE: a stamped post keeps its published length even when the bank now disagrees", () => {
  const restored = "WHICH NUMBER FITS?\n2 -> 3,   3 -> 5,   4 -> 7,   5 -> ?"; // 15 words, today's bank
  const ctx = {
    bySig: new Map([["sig-1", { sig: "sig-1", tier: "NUMBER ANALOGY", prompt: restored }]]),
    bySlug: new Map([["slug-1", { questions: [{ sig: "sig-1", tier: "NUMBER ANALOGY" }] }]]),
    typeWords: { "NUMBER ANALOGY": 15 },
  };
  // published 2026-08-02, under the SHORTENED bank
  const published = {
    _hermes_key: "hermes:slug-1",
    variant: { lead_prompt_words: 12, lead_type: "NUMBER ANALOGY", question_types: ["NUMBER ANALOGY"] },
  };
  assert.deepEqual(leadWordsFor(published, ctx as any), { words: 12, type: "NUMBER ANALOGY", via: "stamped" });

  // An UNSTAMPED post is the hazard the freeze removed: it resolves against today's bank.
  const unstamped = { _hermes_key: "hermes:slug-1", variant: { question_types: ["NUMBER ANALOGY"] } };
  assert.equal(leadWordsFor(unstamped, ctx as any)?.words, 15);
});

/**
 * The publish-time stamp itself — cycle.ts spreads leadStamp(v.questions[0]) into every
 * post record it writes. Worth pinning directly: if lead_band and lead_prompt_words ever
 * disagreed, the ledger would sort posts into bands their word counts contradict, and
 * the only symptom would be a policy that slowly stops matching its own evidence table.
 */
test("EVIDENCE: the publish-time stamp records length, type and a band that agrees", () => {
  assert.deepEqual(leadStamp({ tier: "odd-one-out", prompt: "WHICH ONE DOES NOT BELONG?" }), {
    lead_type: "ODD ONE OUT",
    lead_prompt_words: 5,
    lead_band: "short",
  });
  assert.deepEqual(leadStamp({ tier: "VERBAL ANALOGY", prompt: "HOT IS TO COLD AS\nDAY IS TO ?" }), {
    lead_type: "VERBAL ANALOGY",
    lead_prompt_words: 9,
    lead_band: "medium",
  });
  // The 12-word form a post published 2026-08-02/03 actually carried.
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
