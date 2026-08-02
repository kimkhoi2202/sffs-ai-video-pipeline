/**
 * freeze_lead_words.mjs — stamp every already-published post's opening-prompt length
 * BEFORE the bank's prompts are rewritten, so shortening them cannot rewrite history.
 *
 * WHY THIS HAS TO EXIST. buildLeadEvidence() does not store the evidence it judges on —
 * it rebuilds it every cycle by resolving each post back to the bank entry that shipped
 * and counting the words in that entry's prompt TODAY. That is the right design while
 * the bank is append-only, and it is exactly wrong the moment a prompt is edited in
 * place: shortening VERBAL ANALOGY from nine words to six would make all 362 of its
 * already-published posts report six, the <=5 / 6-9 / >=10 bands would reshuffle around
 * counts no viewer ever saw, and the +9.5-point contrast the policy rests on would
 * dissolve into noise. Nothing would error. The ledger would just quietly say the
 * campaign had always run short openings.
 *
 * So: freeze first, edit second. Every post that can still be attributed gets its word
 * count, type and band written into variant.lead_prompt_words / lead_type / lead_band —
 * the same three fields cycle.ts stamps at publish time — which makes leadWordsFor take
 * its `stamped` branch forever after and stop consulting the bank at all.
 *
 * The recovery itself is IMPORTED, never reimplemented: a second copy of the three-way
 * lookup that drifted would mis-stamp the history it exists to protect.
 *
 * IDEMPOTENT. A post that already carries a positive lead_prompt_words is left exactly
 * as it is, so re-running this can only ever fill gaps. Run it with the loop's own
 * environment so CONFIG resolves the same paths the cycle does:
 *
 *   set -a; . /etc/hermes/hermes.env; set +a; node ops/freeze_lead_words.mjs [--apply]
 *
 * Defaults to a dry run; --apply writes ab-testing/ab-database.json.
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { buildRecoveryCtx, leadWordsFor, normType } from "../hermes/src/leadPromotion.ts";
import { bandOf } from "../hermes/src/leadPolicy.ts";
import { CONFIG } from "../hermes/src/config.ts";

const APPLY = process.argv.includes("--apply");

const db = JSON.parse(readFileSync(CONFIG.AB_DB, "utf8"));
const posts = Array.isArray(db.posts) ? db.posts : [];
const ctx = buildRecoveryCtx();

let stamped = 0;
let already = 0;
let unattributable = 0;
const byVia = {};

for (const p of posts) {
  const v = (p.variant ??= {});
  if (Number.isInteger(v.lead_prompt_words) && v.lead_prompt_words > 0) {
    already++;
    continue;
  }
  const lead = leadWordsFor(p, ctx);
  if (!lead) {
    unattributable++;
    continue;
  }
  v.lead_prompt_words = lead.words;
  v.lead_type = lead.type ?? normType(v.question_types?.[0]);
  v.lead_band = bandOf(lead.words);
  // Provenance of the FROZEN value, kept distinct from the three fields above so a
  // backfilled post can always be told from one the loop stamped as it published.
  v.lead_words_via = `frozen:${lead.via}`;
  byVia[lead.via] = (byVia[lead.via] ?? 0) + 1;
  stamped++;
}

const withSkip = posts.filter(
  (p) => p?.platform === "instagram" && typeof p?.metrics?.skip_rate === "number",
);
const covered = withSkip.filter((p) => Number.isInteger(p?.variant?.lead_prompt_words));

console.log(`posts                : ${posts.length}`);
console.log(`already stamped      : ${already}`);
console.log(`newly frozen         : ${stamped}  ${JSON.stringify(byVia)}`);
console.log(`unattributable       : ${unattributable}`);
console.log(`IG posts with a skip rate : ${withSkip.length}, of which frozen/stamped: ${covered.length}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

if (stamped === 0) {
  console.log("\nnothing to write.");
  process.exit(0);
}

db.updated_at = new Date().toISOString();
const tmp = `${CONFIG.AB_DB}.freeze.tmp`;
writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`);
renameSync(tmp, CONFIG.AB_DB);
console.log(`\nwrote ${CONFIG.AB_DB}`);
