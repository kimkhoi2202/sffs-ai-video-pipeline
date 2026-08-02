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
 * viewers leave — is plausible.
 *
 * IT ALSO LOOSENS THE CONFOUND, THOUGH LESS THAN IT FIRST DID. Because a type now ships at
 * two lengths either side of 2026-08-02, a within-type before/after contrast becomes
 * possible for the first time. But be honest about how much signal that is: after the
 * verbal-analogy revert the only usable contrasts are NUMBER ANALOGY (15 -> 12 words, the
 * one with real leverage) and ODD ONE OUT (5 -> 4, almost certainly too small to resolve);
 * ANTONYM, SYNONYM and COMPARE move further but have n <= 5 between them. The largest type
 * in the pool no longer varies at all. So a week from now this can support a NUMBER ANALOGY
 * before/after and little else — worth having, not the clean separation of length from type
 * that a full rewrite would have bought.
 *
 * WHAT IS NOT CUT, AND WHY. For most of the twelve live types the "prompt" field is not an
 * instruction wrapped around an item — it IS the item. A verbal analogy's stem, a
 * syllogism's premises, a word problem's setup and a sentence-completion's sentence carry
 * the information the question is asking about, and deleting words there deletes the
 * question. Those keep their length; see LEFT_LONG below for the reason in each case. The
 * rule applied throughout is cut words, not meaning.
 *
 * AND NOT AT THE COST OF COMPREHENSION. Fewer words is the proxy, not the goal: what the
 * finding is really about is how much a viewer must PARSE before deciding to stay. So a
 * rewrite that trades plain English for a compact convention is not obviously a win, and
 * every rule below is a deletion of scaffolding rather than a change of notation. The
 * verbal-analogy arrow form was written, shipped into the bank and then reverted on
 * exactly this ground; LEFT_LONG records why, so it does not look arbitrary later.
 *
 * TWO SURFACES. Every prompt here is both drawn on the plate and read aloud by the cloned
 * host (narration.ts stemText reads q.prompt verbatim), so each rule below has to survive
 * being spoken. NUMBER ANALOGY still ships "->" inside its mapping table, and
 * speakPrompt() in narration.ts expands it back to "is to" for the read.
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
  // TRIED AND REVERTED, 2026-08-02. "X IS TO Y AS / A IS TO ?" (9w) was briefly rewritten
  // to "X -> Y / A -> ?" (6w) on the grounds that the connective scaffolding is six of
  // the nine words and carries none of the item. It was reverted deliberately, and the
  // reason is the same premise the whole change rests on: the point is to cut what a
  // viewer must PARSE in three seconds, and arrow notation is a learned convention an
  // eight-year-old may simply not have learned. A prompt that is shorter but more cryptic
  // can cost more in comprehension than it saves in reading — and it would cost it on the
  // LARGEST type in the pool, showing up as more skipping, not less. Every other rule here
  // deletes scaffolding and leaves the meaning in plain words, so none carries that risk;
  // this was the only one that changed HOW the item is expressed rather than trimming
  // around it. Do not re-apply it without an experiment that can measure comprehension
  // separately from reading load.
  "VERBAL ANALOGY":
    "9 words, and they are plain English an eight-year-old already reads; the shorter " +
    "arrow form was tried and reverted because notation has to be learned before it is fast",
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
