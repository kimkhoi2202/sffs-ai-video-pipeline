/**
 * shorten-prompts.mjs — cut every live question type's opening prompt to the shortest
 * phrasing that still says what to do.
 *
 * WHY. Across 44 matured Instagram posts attributable to their opening question, prompt
 * LENGTH tracks the 3-second skip rate: <=5 words medians 62.3%, 6-9 medians 72.5%, >=10
 * medians 71.0% — a 9.5-point gap, 95% CI [+2.4, +16.5], permutation p = 0.0008, which
 * survives dropping any single type and survives same-day ranking. Question TYPE, tested
 * directly, is flat. But the bank ships ONE fixed prompt per type, so length and type are
 * perfectly confounded and the weighting engine can only shift the mix toward the one
 * short type it can render. Shortening the prompts themselves applies the finding to
 * every video instead of reshuffling toward odd-one-out.
 *
 * THIS IS NOT A VALIDATED INTERVENTION and the code should not pretend otherwise. Because
 * length and type move together in the existing data, the evidence is equally consistent
 * with a real length effect and with a type effect we cannot separate. It is applied
 * because it is cheap and the mechanism — less to read in the three seconds where ~70% of
 * viewers leave — is plausible. Its real value is that it BREAKS the confound: the same
 * type now ships at two different lengths either side of 2026-08-02, so a week from now
 * the within-type before/after contrast can say whether length was ever the lever.
 *
 * WHAT IS NOT CUT, AND WHY. For six of the twelve live types the "prompt" field is not an
 * instruction wrapped around an item — it IS the item. A verbal analogy's stem, a
 * syllogism's premises, a word problem's setup and a sentence-completion's sentence carry
 * the information the question is asking about, and deleting words there deletes the
 * question. Those keep their length; see LEFT_LONG below for the reason in each case. The
 * rule applied throughout is cut words, not meaning.
 *
 * TWO SURFACES. Every prompt here is both drawn on the plate and read aloud by the cloned
 * host (narration.ts stemText reads q.prompt verbatim), so each rule below has to survive
 * being spoken. The arrow rewrites lean on speakPrompt() in narration.ts, which expands
 * "->" back to "is to" for the read — the plate loses the connective scaffolding, the
 * voiceover keeps it.
 *
 * IDEMPOTENT AND NARROW. Every rule matches the exact authored shape and returns null if
 * it does not, so a second run is a no-op and an unrecognised prompt is left untouched
 * rather than half-rewritten. `promptNorm` is deliberately NOT updated: it is a lossy
 * dedup key, and leaving it holding the original wording keeps the pre-cut phrasing
 * recoverable from the bank itself.
 *
 * DEDUP IS UNAFFECTED. Entries are deduped on the stored `sig` and on fuzzySig, which for
 * text questions keys on the option set plus the answer and IGNORES prompt wording
 * entirely (questions.ts). Rewriting a prompt therefore cannot resurrect a used question
 * or collide two fresh ones.
 *
 *   node content/shorten-prompts.mjs            # dry run: the full before/after table
 *   node content/shorten-prompts.mjs --apply    # rewrite content/master-question-bank.json
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BANK = join(HERE, "master-question-bank.json");
const APPLY = process.argv.includes("--apply");

const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;

/**
 * One rule per type whose prompt has an instruction separable from its item.
 * Each `to` returns the shortened prompt, or null to leave the entry alone.
 */
const RULES = {
  // "ONE" is filler once four options are on screen. Kept as words rather than a
  // contraction so no apostrophe has to survive the plate font and the TTS.
  "ODD ONE OUT": (p) =>
    p === "WHICH ONE DOES NOT BELONG?" ? "WHICH DOES NOT BELONG?" : null,

  // "IS TO ... AS ... IS TO" is six of the nine words and carries none of the item: the
  // question is the three terms. The arrow is already the bank's own notation for a
  // mapping (NUMBER ANALOGY has always used it), the renderer draws it as a real vector
  // arrow (TextQuestion.tsx), and speakPrompt reads it back as "is to".
  "VERBAL ANALOGY": (p) => {
    const m = /^(.+?) IS TO (.+?) AS\n(.+?) IS TO \?$/.exec(p);
    return m ? `${m[1]} -> ${m[2]}\n${m[3]} -> ?` : null;
  },

  // The mapping table already says what to do — four pairs ending in "?" is the
  // question — and the host still announces "a number analogy" before reading it. The
  // PAIRS stay: three worked examples plus the query is what pins the rule down, and
  // dropping one to save three words would leave a puzzle several rules fit.
  "NUMBER ANALOGY": (p) => {
    const m = /^WHICH NUMBER FITS\?\n([\s\S]+)$/.exec(p);
    return m ? m[1] : null;
  },

  // "WHICH WORD MEANS THE" is pure preamble; the options are all words.
  ANTONYM: (p) => {
    const m = /^WHICH WORD MEANS THE\nOPPOSITE OF (.+)\?$/.exec(p);
    return m ? `OPPOSITE OF ${m[1]}?` : null;
  },

  // Same preamble. "ANOTHER WORD FOR X?" over the tighter "SAME AS X?" because it is one
  // word longer and much less clipped read aloud, and both are already inside the band.
  SYNONYM: (p) => {
    const m = /^WHICH WORD MEANS THE\nSAME AS (.+)\?$/.exec(p);
    return m ? `ANOTHER WORD FOR ${m[1]}?` : null;
  },

  // Just the article. The superlative and the noun both stay.
  COMPARE: (p) => {
    const out = p.replace(/\bIS\s+THE\s+(LARGEST|SMALLEST|GREATEST|LEAST)\b/, "IS $1");
    return out !== p ? out : null;
  },
};

/** Types deliberately left at their current length, and the reason. */
const LEFT_LONG = {
  "NUMBER SERIES": 'already minimal at 3 words ("WHAT COMES NEXT?")',
  "LETTER SERIES": 'already minimal at 3 words ("WHAT COMES NEXT?")',
  "NUMBER PUZZLE":
    "IF/THEN is load-bearing: the setup equations are FALSE in ordinary arithmetic " +
    '("2+3=10"), and IF is what tells a child they are a pretend rule rather than a mistake',
  "SENTENCE COMPLETION":
    "the sentence IS the item, and the clause after the blank is what constrains which " +
    "word fits — cutting it makes the answer ambiguous",
  LOGIC: "the premises ARE the item; a syllogism minus a premise is not a shorter syllogism",
  "WORD PROBLEM": "the setup carries the numbers the question is asking about",
};

const bank = JSON.parse(readFileSync(BANK, "utf8"));
const entries = Array.isArray(bank.entries) ? bank.entries : [];

// Only the two headless-renderable kinds ever reach a video (questions.ts toHermesQ maps
// the rest to null), so the live pool is what we touch.
const LIVE_KINDS = new Set(["text", "numseries"]);

const changed = [];
const samples = new Map();
const unmatched = new Map();

for (const e of entries) {
  if (!LIVE_KINDS.has(e.kind)) continue;
  const tier = String(e.tier ?? "").trim().toUpperCase();
  const rule = RULES[tier];
  if (!rule) continue;
  const before = String(e.prompt ?? "");
  if (!before) continue;
  const after = rule(before);
  if (after === null || after === before) {
    unmatched.set(tier, (unmatched.get(tier) ?? 0) + 1);
    continue;
  }
  if (!samples.has(tier)) samples.set(tier, { before, after });
  changed.push({ e, after });
}

const counts = new Map();
for (const c of changed) {
  const t = String(c.e.tier).toUpperCase();
  counts.set(t, (counts.get(t) ?? 0) + 1);
}

console.log(`bank entries: ${entries.length}  live (text|numseries): ${entries.filter((e) => LIVE_KINDS.has(e.kind)).length}`);
console.log(`entries to rewrite: ${changed.length}\n`);

console.log("SHORTENED");
for (const [tier, { before, after }] of samples) {
  console.log(`\n  ${tier}  (n=${counts.get(tier)})  ${words(before)}w -> ${words(after)}w`);
  console.log(`    before: ${JSON.stringify(before)}`);
  console.log(`    after : ${JSON.stringify(after)}`);
}

if (unmatched.size) {
  console.log("\nRULE DID NOT FIRE (already shortened, or an unrecognised authored shape)");
  for (const [t, n] of unmatched) console.log(`  ${t}: ${n}`);
}

console.log("\nLEFT LONG ON PURPOSE");
for (const [t, why] of Object.entries(LEFT_LONG)) console.log(`  ${t}: ${why}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

for (const { e, after } of changed) e.prompt = after;
// Date-only, matching the field's existing format rather than switching it to a timestamp.
bank.updated = new Date().toISOString().slice(0, 10);
const tmp = `${BANK}.shorten.tmp`;
writeFileSync(tmp, `${JSON.stringify(bank, null, 2)}\n`);
renameSync(tmp, BANK);
console.log(`\nwrote ${BANK} (${changed.length} prompts)`);
