#!/usr/bin/env node
/**
 * backfill_grade_level.mjs — stamp every existing bank entry with gradeLevel 5.
 *
 * ONE-TIME, IDEMPOTENT. This is what turns `gradeLevel` from a field only generated
 * items carry into a genuine variable with two values in it. Five is not an estimate:
 * content/schema/round.schema.json REQUIRES `"grade": {"const": 5}` and
 * `"cogatLevel": {"const": 11}` on every round the bank was built from, so the whole
 * authored bank is grade 5 by construction. The judge agrees independently — of the 41
 * bank items it has rated, 37 came back "easy" and 4 "medium", none hard.
 *
 * Touches ONLY the new field. sig/hash/prompt/options/answer are the never-repeat
 * guarantee and are not read or written here.
 *
 *   node ops/backfill_grade_level.mjs --dry
 *   node ops/backfill_grade_level.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANK = path.resolve(HERE, "..", "content", "master-question-bank.json");
const APPLY = process.argv.includes("--apply");
const GRADE_AUTHORED = 5;

const bank = JSON.parse(fs.readFileSync(BANK, "utf8"));
const rows = bank.entries ?? [];

let already = 0;
let toStamp = 0;
const byExisting = {};
for (const e of rows) {
  if (typeof e.gradeLevel === "number") {
    already++;
    byExisting[e.gradeLevel] = (byExisting[e.gradeLevel] ?? 0) + 1;
    continue;
  }
  toStamp++;
}

console.log(`bank entries      : ${rows.length}`);
console.log(`already stamped   : ${already} ${JSON.stringify(byExisting)}`);
console.log(`to stamp with ${GRADE_AUTHORED}   : ${toStamp}`);

if (!toStamp) {
  console.log("nothing to do (idempotent).");
  process.exit(0);
}
if (!APPLY) {
  console.log("\nDRY RUN. Re-run with --apply to write.");
  process.exit(0);
}

// Snapshot the identity fields so we can prove nothing else moved.
const before = rows.map((e) => `${e.sig}|${e.hash}`).join("\n");
for (const e of rows) if (typeof e.gradeLevel !== "number") e.gradeLevel = GRADE_AUTHORED;
const after = rows.map((e) => `${e.sig}|${e.hash}`).join("\n");
if (before !== after) {
  console.error("REFUSING TO WRITE: a sig or hash changed. The never-repeat guarantee keys off these.");
  process.exit(1);
}

bank.entries = rows;
bank.updated = new Date().toISOString().slice(0, 10);
const tmp = BANK + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(bank, null, 2) + "\n");
fs.renameSync(tmp, BANK);
console.log(`\nstamped ${toStamp} entries with gradeLevel ${GRADE_AUTHORED}; sig/hash unchanged.`);
