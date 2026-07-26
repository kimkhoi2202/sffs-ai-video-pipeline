#!/usr/bin/env node
/**
 * reimport-raw.mjs — backfill RAW authored text onto master-question-bank.json.
 *
 * WHY THIS EXISTS
 * The bank never stored the questions, only their dedup keys. `norm()` (identical in
 * validate.mjs and import-new-types.mjs) lowercases and collapses every run of
 * non-alphanumerics to one space, so it deletes / . ' $ % ? _ -> and newlines. The
 * renderer then displayed those keys, which is why "2/3" shipped as "2 3", "$1.00" as
 * "1 00", "CAN'T TELL" as "can t tell", and the three-line syllogisms arrived as one
 * run-on line. Every text/numseries entry in the bank is affected.
 *
 * The sources were never damaged: content/rounds/*.json and content/staging-new-
 * types-*.json still hold the authored punctuation, line breaks and a human-written
 * explanation for every question. This is therefore a MECHANICAL re-import — it
 * regenerates nothing and authors nothing, it only copies text that already exists.
 *
 * THE HARD CONSTRAINT
 * `sig` and `hash` must stay BYTE-IDENTICAL: hermes-used-sigs.json and
 * content/ab-test-usage.json key the campaign's never-repeat guarantee off them, so
 * changing one would either resurrect a used question or strand a fresh one. This
 * script therefore only ever ADDS keys. It re-derives sigOf(q)/hashOf(sig) from the
 * source and refuses to touch any entry whose signature does not already match, and
 * it diffs the complete (sig, hash) list before and after as a final assertion.
 *
 * Usage:  node content/reimport-raw.mjs            # dry-run report
 *         node content/reimport-raw.mjs --write     # apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sigOf, hashOf, rawFieldsOf } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(HERE, "master-question-bank.json");
const ROUNDS_DIR = path.join(HERE, "rounds");
const WRITE = process.argv.includes("--write");

const RAW_KEYS = ["prompt", "options", "seq", "answer", "explanation"];

/**
 * Every source question paired with the (slug, id) the emitters banked it under.
 * The slug/id derivations MIRROR validate.mjs entryOf and import-new-types.mjs — if
 * either changes, this walk has to change with it or entries simply go unmatched
 * (reported, never silently skipped).
 */
function sourceQuestions() {
  const out = [];
  for (const f of fs.readdirSync(ROUNDS_DIR).filter((f) => /^round-\d{3}\.json$/.test(f)).sort()) {
    const round = JSON.parse(fs.readFileSync(path.join(ROUNDS_DIR, f), "utf8"));
    for (const q of round.questions ?? []) out.push({ slug: round.slug, id: q.id, q, src: f });
  }

  const textFile = path.join(HERE, "staging-new-types-text.json");
  if (fs.existsSync(textFile)) {
    const j = JSON.parse(fs.readFileSync(textFile, "utf8"));
    for (const [k, v] of Object.entries(j.types ?? {})) {
      const arr = Array.isArray(v) ? v : v.questions ?? [];
      arr.forEach((q, i) => out.push({ slug: `staging-text-${k}`, id: q.id ?? i + 1, q, src: "staging-new-types-text.json" }));
    }
  }

  const foldFile = path.join(HERE, "staging-new-types-paperfold.json");
  if (fs.existsSync(foldFile)) {
    const j = JSON.parse(fs.readFileSync(foldFile, "utf8"));
    const arr = Array.isArray(j) ? j : j.questions ?? [];
    arr.forEach((q, i) => out.push({ slug: "staging-fold", id: q.id ?? i + 1, q, src: "staging-new-types-paperfold.json" }));
  }

  const matrixFile = path.join(HERE, "staging-new-types-matrix.json");
  if (fs.existsSync(matrixFile)) {
    const j = JSON.parse(fs.readFileSync(matrixFile, "utf8"));
    for (const [k, v] of Object.entries(j.types ?? {})) {
      const arr = Array.isArray(v) ? v : v.questions ?? [];
      arr.forEach((q, i) => out.push({ slug: `staging-matrix-${k}`, id: q.idx ?? q.id ?? i + 1, q, src: "staging-new-types-matrix.json" }));
    }
  }
  return out;
}

const bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
const before = bank.entries.map((e) => `${e.sig}\u0000${e.hash}`);
const byKey = new Map(bank.entries.map((e) => [`${e.slug}\u0000${e.id}`, e]));

const sources = sourceQuestions();
const stats = { sources: sources.length, matched: 0, updated: 0, unchanged: 0, noRaw: 0 };
const unmatched = [];
const sigMismatch = [];

for (const { slug, id, q, src } of sources) {
  const entry = byKey.get(`${slug}\u0000${id}`);
  if (!entry) {
    unmatched.push(`${src} ${slug} #${id} (${q.kind ?? "figure"}) — no bank entry`);
    continue;
  }
  stats.matched++;

  // Signature assertion. Only text/numseries/legacy-nonverbal go through sigOf(); the
  // structured figure kinds build their sig inside figureEntry() from a hash of the
  // figure, which is not reproducible here — those are matched on (slug, id) alone and
  // only ever receive `explanation`, which cannot affect any signature.
  const sigComparable = ["text", "numseries", "shaded", "polygon", "dot"].includes(q.kind);
  if (sigComparable) {
    const sig = sigOf(q);
    if (sig !== entry.sig || hashOf(sig) !== entry.hash) {
      sigMismatch.push(`${src} ${slug} #${id}: source sig !== bank sig — REFUSING to touch this entry`);
      continue;
    }
  }

  const raw = rawFieldsOf(q);
  if (!Object.keys(raw).length) { stats.noRaw++; continue; }
  const changed = RAW_KEYS.some((k) => k in raw && JSON.stringify(entry[k]) !== JSON.stringify(raw[k]));
  if (!changed) { stats.unchanged++; continue; }
  Object.assign(entry, raw);
  stats.updated++;
}

// Final assertion: the dedup universe is untouched, entry for entry, in order.
const after = bank.entries.map((e) => `${e.sig}\u0000${e.hash}`);
const sigStable = before.length === after.length && before.every((s, i) => s === after[i]);

const withRawText = bank.entries.filter((e) => typeof e.prompt === "string" && e.prompt);
const withExplanation = bank.entries.filter((e) => typeof e.explanation === "string" && e.explanation);
const textish = bank.entries.filter((e) => e.kind === "text" || e.kind === "numseries");
const textishRaw = textish.filter((e) => typeof e.prompt === "string" && e.prompt);

console.log("=== reimport-raw ===");
console.log(`sources walked   : ${stats.sources}`);
console.log(`matched to bank  : ${stats.matched}`);
console.log(`entries updated  : ${stats.updated}`);
console.log(`already current  : ${stats.unchanged}`);
console.log(`no raw to add    : ${stats.noRaw}`);
console.log(`unmatched sources: ${unmatched.length}`);
for (const u of unmatched.slice(0, 20)) console.log("   -", u);
console.log(`sig mismatches   : ${sigMismatch.length}`);
for (const m of sigMismatch.slice(0, 20)) console.log("   x", m);
console.log("");
console.log(`bank entries              : ${bank.entries.length}`);
console.log(`  text/numseries          : ${textish.length}`);
console.log(`  ...carrying raw prompt  : ${textishRaw.length}`);
console.log(`  any kind w/ raw prompt  : ${withRawText.length}`);
console.log(`  any kind w/ explanation : ${withExplanation.length}`);
console.log(`sig+hash byte-identical   : ${sigStable ? "YES" : "NO"}`);

if (!sigStable) { console.error("\nABORT: sig/hash changed. Nothing written."); process.exit(2); }
if (sigMismatch.length) { console.error("\nABORT: source/bank signature mismatch. Nothing written."); process.exit(2); }

if (WRITE) {
  if (!stats.updated) { console.log("\nnothing to write (bank already current)"); process.exit(0); }
  bank.count = bank.entries.length;
  bank.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + "\n");
  console.log(`\nWROTE ${stats.updated} entries -> ${BANK_PATH}`);
} else {
  console.log("\n(dry-run; pass --write to apply)");
}
