#!/usr/bin/env node
/**
 * backfill-explanations.mjs — put the AUTHORED explanation on every bank entry.
 *
 * Narrow on purpose. The full raw-text re-import is parked on
 * wip/bank-raw-text-reimport because the campaign is running on shape questions, which
 * were never corrupted. But shape questions have a different problem, and it blocks
 * posting today: the bank carries no explanation at all for them, so render.ts falls
 * back to the per-kind template synthesized in legacyShapes.ts. That template emits
 * the SAME sentence for every question of a kind — "each shape gets filled in" on all
 * 100 shaded questions — so any two shaded questions in one video ship byte-identical
 * reveal copy, and the publish gate (correctly) refuses them.
 *
 * The authored explanations were always there: all 1,500 questions in
 * content/rounds/*.json and all 44 in content/staging-new-types-*.json have one. This
 * copies that single field across and nothing else.
 *
 * `sig` and `hash` are NOT touched, and neither are the `*Norm` dedup keys — the
 * never-repeat guarantee in hermes-used-sigs.json and ab-test-usage.json is keyed off
 * them, so this asserts they are byte-identical before it writes. Adding a field is
 * safe; changing a key would either resurrect a used question or strand a fresh one.
 *
 *   node content/backfill-explanations.mjs            # dry-run report
 *   node content/backfill-explanations.mjs --write     # apply
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(HERE, "master-question-bank.json");
const ROUNDS_DIR = path.join(HERE, "rounds");
const WRITE = process.argv.includes("--write");

/** Source questions keyed by the (slug, id) the emitters banked them under. */
function sources() {
  const out = [];
  for (const f of fs.readdirSync(ROUNDS_DIR).filter((f) => /^round-\d{3}\.json$/.test(f)).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(ROUNDS_DIR, f), "utf8"));
    for (const q of r.questions ?? []) out.push({ slug: r.slug, id: q.id, q });
  }
  const text = path.join(HERE, "staging-new-types-text.json");
  if (fs.existsSync(text)) {
    const j = JSON.parse(fs.readFileSync(text, "utf8"));
    for (const [k, v] of Object.entries(j.types ?? {})) {
      (Array.isArray(v) ? v : v.questions ?? []).forEach((q, i) => out.push({ slug: `staging-text-${k}`, id: q.id ?? i + 1, q }));
    }
  }
  const fold = path.join(HERE, "staging-new-types-paperfold.json");
  if (fs.existsSync(fold)) {
    const j = JSON.parse(fs.readFileSync(fold, "utf8"));
    (Array.isArray(j) ? j : j.questions ?? []).forEach((q, i) => out.push({ slug: "staging-fold", id: q.id ?? i + 1, q }));
  }
  const matrix = path.join(HERE, "staging-new-types-matrix.json");
  if (fs.existsSync(matrix)) {
    const j = JSON.parse(fs.readFileSync(matrix, "utf8"));
    for (const [k, v] of Object.entries(j.types ?? {})) {
      (Array.isArray(v) ? v : v.questions ?? []).forEach((q, i) => out.push({ slug: `staging-matrix-${k}`, id: q.idx ?? q.id ?? i + 1, q }));
    }
  }
  return out;
}

const bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
const before = bank.entries.map((e) => `${e.sig}\u0000${e.hash}\u0000${e.promptNorm}\u0000${e.payloadNorm}\u0000${e.answerNorm}`);
const byKey = new Map(bank.entries.map((e) => [`${e.slug}\u0000${e.id}`, e]));

let updated = 0, unchanged = 0, unmatched = 0, noExplanation = 0;
for (const { slug, id, q } of sources()) {
  const entry = byKey.get(`${slug}\u0000${id}`);
  if (!entry) { unmatched++; continue; }
  const expl = String(q.explanation ?? "").trim();
  if (!expl) { noExplanation++; continue; }
  if (entry.explanation === expl) { unchanged++; continue; }
  entry.explanation = expl;
  updated++;
}

const after = bank.entries.map((e) => `${e.sig}\u0000${e.hash}\u0000${e.promptNorm}\u0000${e.payloadNorm}\u0000${e.answerNorm}`);
const stable = before.length === after.length && before.every((s, i) => s === after[i]);

const withExpl = bank.entries.filter((e) => e.explanation);
const distinct = new Set(withExpl.map((e) => e.explanation));
console.log("=== backfill-explanations ===");
console.log(`entries              : ${bank.entries.length}`);
console.log(`updated              : ${updated}`);
console.log(`already current      : ${unchanged}`);
console.log(`source had none      : ${noExplanation}`);
console.log(`unmatched sources    : ${unmatched}`);
console.log(`now carrying one     : ${withExpl.length}  (${distinct.size} distinct)`);
console.log(`sig/hash/*Norm stable: ${stable ? "YES" : "NO"}`);

if (!stable) { console.error("\nABORT: a dedup key changed. Nothing written."); process.exit(2); }

if (WRITE && updated) {
  bank.count = bank.entries.length;
  bank.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + "\n");
  console.log(`\nWROTE ${updated} entries`);
} else if (WRITE) {
  console.log("\nnothing to write");
} else {
  console.log("\n(dry-run; pass --write to apply)");
}
