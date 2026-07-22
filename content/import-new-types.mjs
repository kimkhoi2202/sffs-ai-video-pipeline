#!/usr/bin/env node
/**
 * import-new-types.mjs — move the three staging question-type JSONs into the
 * master bank (content/master-question-bank.json), using the SAME canonical
 * signature/hash as validate.mjs so dedup + the loop's questions.ts agree.
 *
 *   TEXT family  (staging-new-types-text.json)  -> standard text/numseries bank
 *                entries (render via the existing plates; immediately eligible in
 *                the loop's candidate pool).
 *   FOLD         (staging-new-types-paperfold.json) -> kind:"fold"  structured
 *   MATRIX family(staging-new-types-matrix.json)    -> kind:"matrix"|"analogy2"|
 *                "figure-odd" structured entries carrying a `figure` payload (the
 *                render-ready object) so toHermesQ / render.ts mapProps can
 *                reconstruct them for FullVideo (the loop's renderer).
 *
 * Idempotent: an entry whose sig/hash already exists is skipped. Text/numseries
 * entries are validated against the loop's render guards (prompt<=92, option<=24,
 * 3-4 options, seq 3-6, exactly one correct) and any that would overflow are
 * skipped + reported (quality > volume).
 *
 * Usage:  node content/import-new-types.mjs            # dry-run report
 *         node content/import-new-types.mjs --write     # append to the master bank
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sigOf, hashOf, payloadOf, answerNormOf } from "./validate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANK_PATH = path.join(HERE, "master-question-bank.json");
const WRITE = process.argv.includes("--write");
const today = () => new Date().toISOString().slice(0, 10);
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const slugify = (s) => norm(s).replace(/ /g, "-");

// ---- loop render guards (mirror hermes/src/questions.ts toHermesQ LIMITS) ----
const LIMITS = { maxPrompt: 92, maxOption: 24, maxOptions: 4, minOptions: 3, maxSeq: 6, minSeq: 3 };
function textOk(q) {
  const prompt = String(q.question ?? q.prompt ?? "").trim();
  const opts = (q.options ?? []).map((o) => String(o.text ?? "").trim()).filter(Boolean);
  if (!prompt || prompt.length > LIMITS.maxPrompt) return `prompt len ${prompt.length}>${LIMITS.maxPrompt}`;
  if (opts.length < LIMITS.minOptions || opts.length > LIMITS.maxOptions) return `options ${opts.length}`;
  if (opts.some((o) => o.length > LIMITS.maxOption)) return `an option > ${LIMITS.maxOption}`;
  const matches = opts.filter((o) => norm(o) === norm(q.ansLabel)).length;
  if (matches !== 1) return `${matches} options == answer (need 1)`;
  return null;
}
function numOk(q) {
  const seq = (q.seq ?? []).map((t) => String(t).trim()).filter((t) => t && t !== "?");
  if (seq.length < LIMITS.minSeq || seq.length > LIMITS.maxSeq) return `seq len ${seq.length}`;
  if (seq.some((n) => n.length > 8)) return `seq token > 8`;
  const prompt = String(q.prompt ?? q.question ?? "what comes next?").trim();
  if (prompt.length > LIMITS.maxPrompt) return `prompt len ${prompt.length}`;
  if (String(q.ansLabel ?? "").trim().length > 8) return `answer > 8`;
  return null;
}

// ---- entry builders --------------------------------------------------------
function textEntry(q, slug, round, id) {
  // Reuse the canonical validate.mjs signature so dedup lines up with the bank.
  const sig = sigOf(q);
  return {
    sig, hash: hashOf(sig), kind: q.kind, category: q.category, tier: q.tier,
    promptNorm: norm(q.question || q.prompt || ""), payloadNorm: payloadOf(q), answerNorm: answerNormOf(q),
    round, slug, id, addedAt: today(),
  };
}
/** A structured (figure) entry: carries the render-ready object in `figure` so the
 *  loop's toHermesQ / render.ts mapProps can rebuild it for FullVideo. */
function figureEntry(kind, tier, q, slug, round, id) {
  const figure = { ...q, kind, tier, category: "nonverbal" };
  const figKey = hashOf(JSON.stringify(figure.cells ?? figure.folds ?? figure.options ?? figure));
  const answerNorm = norm(q.ansLabel ?? q.ansLetter ?? "");
  const payloadNorm = `${kind}:${figKey}`;
  const sig = [kind, "nonverbal", slugify(tier), payloadNorm, answerNorm].join("|");
  return {
    sig, hash: hashOf(sig), kind, category: "nonverbal", tier,
    promptNorm: norm(q.prompt || ""), payloadNorm, answerNorm,
    round, slug, id, addedAt: today(), figure,
  };
}

function loadArr(typesObj) {
  // types is an object keyed "0".."n" (each an array) OR {questions:[...]}
  if (Array.isArray(typesObj)) return typesObj;
  if (typesObj.questions) return typesObj.questions;
  return Object.values(typesObj).flatMap((v) => (Array.isArray(v) ? v : v.questions ?? []));
}

// ---- run -------------------------------------------------------------------
const bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
const haveSig = new Set(bank.entries.map((e) => e.sig));
const haveHash = new Set(bank.entries.map((e) => e.hash));
const added = [];
const skipped = [];
let roundBase = 900;

function tryAdd(entry, label) {
  if (haveSig.has(entry.sig) || haveHash.has(entry.hash)) { skipped.push(`${label}: dup`); return; }
  haveSig.add(entry.sig); haveHash.add(entry.hash);
  added.push(entry);
}

// --- TEXT family (standard entries; validate against loop guards) ---
{
  const j = JSON.parse(fs.readFileSync(path.join(HERE, "staging-new-types-text.json"), "utf8"));
  for (const [k, v] of Object.entries(j.types)) {
    const arr = Array.isArray(v) ? v : v.questions ?? [];
    const slug = `staging-text-${k}`;
    arr.forEach((q, i) => {
      const err = q.kind === "numseries" ? numOk(q) : textOk(q);
      if (err) { skipped.push(`text ${q.tier} #${q.id}: ${err}`); return; }
      tryAdd(textEntry(q, slug, roundBase + Number(k), q.id ?? i + 1), `text ${q.tier} #${q.id}`);
    });
  }
}

// --- FOLD (structured) ---
{
  const j = JSON.parse(fs.readFileSync(path.join(HERE, "staging-new-types-paperfold.json"), "utf8"));
  const arr = loadArr(j);
  arr.forEach((q, i) => tryAdd(figureEntry("fold", q.tier || "PAPER FOLDING", q, "staging-fold", 910, q.id ?? i + 1), `fold #${q.id}`));
}

// --- MATRIX family (structured; infer kind + tier from shape) ---
{
  const j = JSON.parse(fs.readFileSync(path.join(HERE, "staging-new-types-matrix.json"), "utf8"));
  const kindOf = (q) => (q.cells ? "matrix" : q.a && q.b && q.c ? "analogy2" : "figure-odd");
  const tierOf = { matrix: "FIGURE MATRIX", analogy2: "FIGURE ANALOGY", "figure-odd": "VISUAL ODD ONE OUT" };
  for (const [k, v] of Object.entries(j.types)) {
    const arr = Array.isArray(v) ? v : v.questions ?? [];
    arr.forEach((q, i) => {
      const kind = kindOf(q);
      tryAdd(figureEntry(kind, q.tier || tierOf[kind], q, `staging-matrix-${k}`, 920 + Number(k), q.idx ?? q.id ?? i + 1), `${kind} #${q.idx ?? q.id}`);
    });
  }
}

// ---- report / write --------------------------------------------------------
const byKind = {};
for (const e of added) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
console.log(`ADD ${added.length} entries:`, JSON.stringify(byKind));
console.log(`SKIP ${skipped.length}:`);
for (const s of skipped) console.log("  -", s);

if (WRITE && added.length) {
  bank.entries.push(...added);
  bank.count = bank.entries.length;
  bank.updated = today();
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + "\n");
  console.log(`\nWROTE ${added.length} -> bank count = ${bank.count}`);
} else {
  console.log(`\n(dry-run; pass --write to append. bank count would be ${bank.count + added.length})`);
}
