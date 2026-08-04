/**
 * restore-prompts.mjs — put the five shortened prompt types back into plain words.
 *
 * This is the withdrawal of content/shorten-prompts.mjs (commit 33aa690, 2026-08-02),
 * which cut six question types' opening prompts. One of the six — verbal analogy — was
 * already put back the same day (339b6a4) on comprehension grounds. This restores the
 * other five, for a different and more basic reason: the finding the change was built on
 * cannot mean what it was read to mean.
 *
 * WHY IT SHOULD NOT HAVE SHIPPED. The claim was that a shorter opening prompt lowers the
 * 3-second skip rate: <=6 words medians 62.0%, >=9 words 71.4%, d = 0.84, positive
 * within-day on 4 of 4 days. The effect is real in the data. It is the LABEL that is
 * wrong, because in this bank prompt length is a deterministic function of question TYPE.
 * Measured on the bank as it stood when the finding was derived:
 *
 *     VERBAL ANALOGY   362 entries   9 words   — every single one
 *     NUMBER SERIES    318 entries   3 words   — every single one
 *     ODD ONE OUT      200 entries   5 words   — every single one
 *     NUMBER ANALOGY   182 entries  15 words   — every single one
 *     NUMBER PUZZLE    100 entries   8 words   — every single one
 *
 * Eight of the twelve live types ship exactly ONE prompt length, and — the part that
 * settles it — ZERO types contain both a <=6-word and a >=9-word opener. The four types
 * whose length does vary (sentence completion, logic, word problem, compare) vary only
 * within one side of the split. So in the contrast that produced the 9.4pp gap, "short
 * opener" and "the odd-one-out / number-series family" are the same set of posts, and
 * "long opener" and "the analogy family" are the same set of posts. The comparison could
 * not have distinguished them.
 *
 * That makes the intervention a category error rather than a mere overreach: rewording a
 * prompt does not change its question type, so if type is what the 9.4pp was measuring,
 * the change moves nothing. It only spends clarity. "WHICH ONE DOES NOT BELONG?" became
 * "WHICH DOES NOT BELONG?" and a number analogy lost the line that says it is asking for
 * a number, and the account bought no retention for either.
 *
 * The original commit was honest that length and type were confounded, and argued the
 * change was worth making anyway because it BREAKS the confound — the same type would
 * then ship at two lengths either side of 2026-08-02, enabling a within-type before/after
 * read. After the verbal-analogy revert that argument survives only for NUMBER ANALOGY
 * (15 -> 12 words); odd-one-out moves 5 -> 4, and antonym/synonym/compare have ten entries
 * between them. One within-type contrast, at n<=12/day, is not worth degrading the plate
 * on 87% of the drawable pool. The manipulable lever the data actually supports is
 * question TYPE, and that is now tested directly (dimensions.ts, `opening-question-type`).
 *
 * A SECOND, INDEPENDENT REASON. The bank's own generators were never updated to the
 * shortened forms. content/gen-rounds.mjs still emits "WHICH NUMBER FITS?\n..." and
 * content/verbal-bank.mjs still emits "WHICH ONE DOES NOT BELONG?", so every future
 * authored round would have re-introduced the long wording alongside the shortened
 * entries and split each type across two phrasings for no reason. Restoring re-aligns the
 * bank with the code that fills it.
 *
 * EXACTNESS, AND HOW IT IS PROVEN. Each rule below is the precise inverse of the rule it
 * withdraws, matching only the exact shortened shape and returning null otherwise — so a
 * second run is a no-op and an unrecognised prompt is left alone rather than half-written.
 * On top of that the script REFUSES TO APPLY unless every restored prompt round-trips to
 * the entry's own `promptNorm`. That field was deliberately never updated by the
 * shortening, so it still holds the ORIGINAL wording: the bank carries its own oracle, and
 * this restoration is checked against it rather than against my reading of a regex.
 *
 * NOT TOUCHED, ON PURPOSE:
 *   - `promptNorm` / `payloadNorm` / `sig` / `hash` — lossy dedup keys, never rewritten.
 *     Dedup keys on the stored sig and on a fuzzy sig that ignores prompt wording, so
 *     restoring wording can neither resurrect a used question nor collide two fresh ones.
 *   - the lead_* stamps on published posts. They record what a post ACTUALLY shipped with
 *     and stay frozen; ops/freeze_lead_words.mjs stamped the back catalogue before the
 *     shortening and cycle.ts has stamped every post written since. Evidence is immune to
 *     bank edits in both directions, which is what makes this restoration safe to run.
 *   - VERBAL ANALOGY, already restored by 339b6a4.
 *
 *   node content/restore-prompts.mjs            # dry run: the full before/after table
 *   node content/restore-prompts.mjs --apply    # rewrite content/master-question-bank.json
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BANK = join(HERE, "master-question-bank.json");
const APPLY = process.argv.includes("--apply");

const words = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
/** The bank's own normaliser (content/validate.mjs), reproduced so this stays standalone. */
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/**
 * One inverse rule per type the shortening touched. Each returns the restored prompt, or
 * null to leave the entry alone. The shapes are the exact `to` outputs of the withdrawn
 * rules, so nothing else in the bank can match by accident.
 */
const RULES = {
  // was: "WHICH ONE DOES NOT BELONG?" -> "WHICH DOES NOT BELONG?"
  "ODD ONE OUT": (p) => (p === "WHICH DOES NOT BELONG?" ? "WHICH ONE DOES NOT BELONG?" : null),

  // was: the "WHICH NUMBER FITS?" line dropped, leaving a bare mapping table. The line is
  // the only thing on the plate that says the answer is a NUMBER; without it a viewer has
  // to infer the task from the options, which is exactly the parsing cost this was
  // supposed to be reducing.
  "NUMBER ANALOGY": (p) =>
    /^WHICH NUMBER FITS\?/.test(p) ? null : `WHICH NUMBER FITS?\n${p}`,

  // was: "WHICH WORD MEANS THE\nOPPOSITE OF X?" -> "OPPOSITE OF X?"
  ANTONYM: (p) => {
    const m = /^OPPOSITE OF (.+)\?$/.exec(p);
    return m ? `WHICH WORD MEANS THE\nOPPOSITE OF ${m[1]}?` : null;
  },

  // was: "WHICH WORD MEANS THE\nSAME AS X?" -> "ANOTHER WORD FOR X?"
  SYNONYM: (p) => {
    const m = /^ANOTHER WORD FOR (.+)\?$/.exec(p);
    return m ? `WHICH WORD MEANS THE\nSAME AS ${m[1]}?` : null;
  },

  // was: the article dropped before the superlative — and the LINE BREAK went with it,
  // because the forward rule's `\s+` swallowed it: "WHICH FRACTION IS\nTHE LARGEST?"
  // collapsed to "WHICH FRACTION IS LARGEST?". The break is not cosmetic, it is where the
  // plate wraps, and it is recoverable without guessing: all four authored forms with a
  // noun between WHICH and IS wrapped there, and the one without a noun ("WHICH IS THE
  // GREATEST?") stayed on a single line. Verified against all five entries.
  COMPARE: (p) => {
    const m = /^WHICH( \S+)? IS (LARGEST|SMALLEST|GREATEST|LEAST)\?$/.exec(p);
    if (!m) return null;
    return m[1] ? `WHICH${m[1]} IS\nTHE ${m[2]}?` : `WHICH IS THE ${m[2]}?`;
  },
};

const bank = JSON.parse(readFileSync(BANK, "utf8"));
const entries = Array.isArray(bank.entries) ? bank.entries : [];
const LIVE_KINDS = new Set(["text", "numseries"]);

const changed = [];
const samples = new Map();
const untouched = new Map();

for (const e of entries) {
  if (!LIVE_KINDS.has(e.kind)) continue;
  const tier = String(e.tier ?? "").trim().toUpperCase();
  const rule = RULES[tier];
  if (!rule) continue;
  const before = String(e.prompt ?? "");
  if (!before) continue;
  const after = rule(before);
  if (after === null || after === before) {
    untouched.set(tier, (untouched.get(tier) ?? 0) + 1);
    continue;
  }
  if (!samples.has(tier)) samples.set(tier, { before, after });
  changed.push({ e, after, tier });
}

const counts = new Map();
for (const c of changed) counts.set(c.tier, (counts.get(c.tier) ?? 0) + 1);

console.log(`bank entries: ${entries.length}  live (text|numseries): ${entries.filter((e) => LIVE_KINDS.has(e.kind)).length}`);
console.log(`entries to restore: ${changed.length}\n`);

console.log("RESTORED");
for (const [tier, { before, after }] of samples) {
  console.log(`\n  ${tier}  (n=${counts.get(tier)})  ${words(before)}w -> ${words(after)}w`);
  console.log(`    now    : ${JSON.stringify(before)}`);
  console.log(`    back to: ${JSON.stringify(after)}`);
}

// ── the oracle: promptNorm still holds the ORIGINAL wording ───────────────────
const failures = [];
for (const { e, after, tier } of changed) {
  if (typeof e.promptNorm !== "string") continue; // nothing to check against
  if (norm(after) !== e.promptNorm) failures.push({ tier, sig: e.sig, want: e.promptNorm, got: norm(after) });
}
console.log(`\nORACLE — restored prompt vs the untouched promptNorm: ${changed.length - failures.length}/${changed.length} agree`);
if (failures.length) {
  console.log("MISMATCHES (nothing will be written):");
  for (const f of failures.slice(0, 10)) console.log(`  ${f.tier} ${f.sig}\n    want ${JSON.stringify(f.want)}\n    got  ${JSON.stringify(f.got)}`);
  process.exit(1);
}

if (untouched.size) {
  console.log("\nRULE DID NOT FIRE (already restored, or never shortened)");
  for (const [t, n] of untouched) console.log(`  ${t}: ${n}`);
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

for (const { e, after } of changed) e.prompt = after;
bank.updated = new Date().toISOString().slice(0, 10);
const tmp = `${BANK}.restore.tmp`;
writeFileSync(tmp, `${JSON.stringify(bank, null, 2)}\n`);
renameSync(tmp, BANK);
console.log(`\nwrote ${BANK} (${changed.length} prompts restored)`);
