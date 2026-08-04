/**
 * backfill_opening_type_arm.mjs — give the opening-question-type rollup its history.
 *
 * The experiment's arm is derived from the question that opened each video, and cycle.ts
 * stamps it going forward (leadStamp). Every post already published also HAS an opening
 * type — `variant.lead_type`, frozen onto 204 of 206 records by ops/freeze_lead_words.mjs
 * and by the publish-time stamp since — so its arm is already determined and merely
 * unwritten.
 *
 * Backfilling it is what makes BOTH ARMS PRESENT ON DAY ONE instead of in three weeks.
 * That is not a convenience: the failure this experiment is designed against is an
 * experiment whose store only ever held one side, and a rollup that starts empty is one
 * unlucky week away from being exactly that again.
 *
 * PURELY DERIVED, so it cannot invent evidence. The arm is a pure function of a field
 * already on the record; nothing else is read and nothing else is written. Posts whose
 * opener belongs to neither arm get an explicit null rather than being left absent, so a
 * later reader can tell "not in the experiment" from "not yet processed". Idempotent.
 *
 *   node ops/backfill_opening_type_arm.mjs            # dry run
 *   node ops/backfill_opening_type_arm.mjs --apply
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openingTypeArm } from "../hermes/src/openingType.ts";

const APPLY = process.argv.includes("--apply");
const REPO = process.env.HERMES_REPO_DIR || process.cwd();
const DB = join(REPO, "ab-testing", "ab-database.json");

const db = JSON.parse(readFileSync(DB, "utf8"));
const posts = Array.isArray(db.posts) ? db.posts : [];

let set = 0, already = 0, nullArm = 0, noType = 0;
const byArm = {};
const byPlatform = {};

for (const p of posts) {
  const v = p.variant;
  if (!v || typeof v !== "object") continue;
  const lead = v.lead_type ?? (Array.isArray(v.question_types) ? v.question_types[0] : null);
  if (!lead) { noType++; continue; }
  const arm = openingTypeArm(lead);
  if (Object.prototype.hasOwnProperty.call(v, "opening_type_arm") && v.opening_type_arm === arm) { already++; continue; }
  if (APPLY) v.opening_type_arm = arm;
  set++;
  if (arm === null) nullArm++;
  byArm[String(arm)] = (byArm[String(arm)] ?? 0) + 1;
  if (arm) byPlatform[`${p.platform}:${arm}`] = (byPlatform[`${p.platform}:${arm}`] ?? 0) + 1;
}

console.log(`posts: ${posts.length}`);
console.log(`  would stamp : ${set}`);
console.log(`  already set : ${already}`);
console.log(`  no lead type: ${noType}`);
console.log(`  by arm      : ${JSON.stringify(byArm)}`);
console.log(`  (neither arm: ${nullArm} — number puzzle / series / sentence completion openers)`);
console.log(`  by platform : ${JSON.stringify(byPlatform)}`);

// The count that decides whether the rollup can be read at all.
const withSkip = { };
for (const p of posts) {
  const v = p.variant ?? {};
  const lead = v.lead_type ?? (Array.isArray(v.question_types) ? v.question_types[0] : null);
  const arm = openingTypeArm(lead);
  if (!arm) continue;
  if (p.metrics && p.metrics.source !== "pending" && p.metrics.skip_rate != null) withSkip[arm] = (withSkip[arm] ?? 0) + 1;
}
console.log(`  WITH a matured skip rate (what the rollup can actually read): ${JSON.stringify(withSkip)}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  process.exit(0);
}

db.updated_at = new Date().toISOString();
const tmp = `${DB}.armfill.tmp`;
writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`);
renameSync(tmp, DB);
console.log(`\nwrote ${DB} (${set} records stamped)`);
