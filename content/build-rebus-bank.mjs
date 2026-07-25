#!/usr/bin/env node
/**
 * build-rebus-bank.mjs — builds the persistent REBUS bank from the authored source.
 *
 * Same job as validate.mjs does for the quiz videos: turn authored content into a
 * canonical, de-duplicated bank with a type-aware signature per item, so nothing
 * ever ships twice. Rebus carousels (content/carousels/*.json) cite the entries
 * they use via `sourceIds` (see content/schema/carousel.schema.json).
 *
 *   content/rebus-source.json  ──build──►  content/rebus-bank.json
 *
 * Bank format mirrors content/master-question-bank.json (plus `seed`, see below):
 *   { version, updated, seed, count, entries: [ { sig, hash, kind, category, tier,
 *     promptNorm, payloadNorm, answerNorm, ruleTag, ...provenance, addedAt } ] }
 *
 * Rebus-specific reading of the shared fields (playbook Section 4.2):
 *   kind        always "rebus" (one render family, like `text`/`numseries`).
 *   category    coarse group of the mechanic (layout|letters|style|count|wordplay).
 *   tier        the mechanic itself, uppercase display label (e.g. COUNT, ENCLOSURE).
 *   payloadNorm the normalized CARD TEXT (what is actually printed on the card,
 *               parenthesized layout notes stripped) — the puzzle's identity.
 *   promptNorm  the normalized FULL puzzle spec (card text + layout note), which is
 *               what a fuzzy near-dup check should compare.
 *   answerNorm  the solved phrase, normalized: parenthesized hints dropped and only
 *               the first of any "a or b" / "a/b" alternatives kept, so two puzzles
 *               that solve to the same phrase collide on purpose.
 *
 * Two extra fields the quiz bank does not need, because the round JSONs hold the
 * source there and here the bank IS the source:
 *   puzzle/answer/explanation  the authored content, verbatim.
 *   art        "text" = today's RebusCarousel renders it from stacked rows;
 *              "needs-art" = wants a component feature or a graphic first.
 *   variantOf  set when an earlier entry already solves to the same answerNorm.
 *              Kept (the card is a genuinely different picture) but flagged so a
 *              carousel never ships two puzzles with the same answer.
 *
 * Entry ORDER is shuffled with a seeded RNG (mulberry32, same as gen-rounds.mjs) so
 * that walking the bank top to bottom gives a varied mix of mechanics instead of
 * all 43 COUNT puzzles in a row. Same seed = same order, so a rebuild is still
 * byte-identical. `id` stays tied to the item's position in the source file, so an
 * id keeps pointing at the same puzzle no matter how the bank is ordered.
 *
 * Usage:
 *   node build-rebus-bank.mjs             # write content/rebus-bank.json
 *   node build-rebus-bank.mjs --check     # report only, write nothing
 *   node build-rebus-bank.mjs --seed 42   # reshuffle with a different seed
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(HERE, "rebus-source.json");
const BANK_PATH = path.join(HERE, "rebus-bank.json");
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes("--check");
const SEED = Number(argv[argv.indexOf("--seed") + 1]) || 1729;

// ---- helpers (mirrored from validate.mjs so signatures never diverge) -------
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const slugify = (s) => norm(s).replace(/ /g, "-");
const hashOf = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);
const today = () => new Date().toISOString().slice(0, 10);

// seeded RNG (mulberry32, mirrored from gen-rounds.mjs) so the shuffle is reproducible
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// mechanic -> coarse category
const TIER_CATEGORY = {
  POSITION: "layout",
  DIRECTION: "layout",
  ARRANGEMENT: "layout",
  SIZE: "layout",
  ENCLOSURE: "letters",
  INSERTION: "letters",
  "MISSING LETTERS": "letters",
  SCRAMBLE: "letters",
  "BROKEN TEXT": "style",
  TEXTURE: "style",
  COUNT: "count",
  "SOUND OUT": "wordplay",
  "CATEGORY LIST": "wordplay",
  MATH: "wordplay",
};
const ART = ["text", "needs-art"];

/** The card text alone: drop every parenthesized layout note, flatten the row
 *  breaks. (A handful of items describe their layout in plain prose instead of
 *  parentheses; that prose stays in the payload, which is harmless — it only
 *  makes the identity slightly more specific.) */
const cardTextOf = (puzzle) => String(puzzle).replace(/\([\s\S]*?\)/g, " ").replace(/\s+/g, " ").trim();

/** The solved phrase: hints in parentheses dropped, only the first of any
 *  "a or b" / "a/b" alternatives kept. */
function answerCoreOf(answer) {
  const bare = String(answer).replace(/\([\s\S]*?\)/g, " ");
  const first = bare.split("/")[0].split(/\bor\b/i)[0];
  return norm(first);
}

const sigOf = (e) => ["rebus", e.category, slugify(e.tier), e.payloadNorm, e.answerNorm].join("|");

// ---- build -----------------------------------------------------------------
const src = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8"));
const batch = src.batch ?? 1;
const slug = src.slug ?? `rebus-batch-${String(batch).padStart(3, "0")}`;
const stamp = today();

const problems = [];
const entries = [];
const bySig = new Map();
const byAnswer = new Map();

src.puzzles.forEach((p, i) => {
  const n = i + 1;
  const id = `rebus-${String(n).padStart(3, "0")}`;
  const category = TIER_CATEGORY[p.tier];
  if (!category) problems.push(`${id}: unknown tier "${p.tier}"`);
  if (!ART.includes(p.art)) problems.push(`${id}: art must be one of ${ART.join("|")}, got "${p.art}"`);
  if (!p.puzzle || !p.answer || !p.explanation) problems.push(`${id}: puzzle, answer and explanation are all required`);
  if (/[\u2013\u2014]|--/.test(p.explanation || "")) problems.push(`${id}: explanation contains an em/en dash or --`);

  const entry = {
    sig: "",
    hash: "",
    kind: "rebus",
    category: category || "unknown",
    tier: p.tier,
    promptNorm: norm(p.puzzle),
    payloadNorm: norm(cardTextOf(p.puzzle)),
    answerNorm: answerCoreOf(p.answer),
    ruleTag: p.ruleTag,
    art: p.art,
    puzzle: p.puzzle,
    answer: p.answer,
    explanation: p.explanation,
    batch,
    slug,
    id,
    addedAt: stamp,
  };
  entry.sig = sigOf(entry);
  entry.hash = hashOf(entry.sig);

  const clash = bySig.get(entry.sig);
  if (clash) {
    problems.push(`${id}: exact duplicate of ${clash} (same card text and answer) — dropped`);
    return;
  }
  bySig.set(entry.sig, id);

  const twin = byAnswer.get(entry.answerNorm);
  if (twin) entry.variantOf = twin;
  else byAnswer.set(entry.answerNorm, id);

  entries.push(entry);
});

// Dedupe ran in source order (so `variantOf` always points at the earlier twin);
// only the emitted order is shuffled.
const ordered = shuffle(entries, mulberry32(SEED));
const bank = { version: 1, updated: stamp, seed: SEED, count: ordered.length, entries: ordered };

// ---- report ----------------------------------------------------------------
const tally = (key) =>
  entries.reduce((acc, e) => {
    acc[e[key]] = (acc[e[key]] || 0) + 1;
    return acc;
  }, {});
const variants = entries.filter((e) => e.variantOf);

console.log(`source: ${src.puzzles.length} puzzles -> bank: ${entries.length} entries (shuffled, seed ${SEED})`);
console.log(`  art:       ${JSON.stringify(tally("art"))}`);
console.log(`  category:  ${JSON.stringify(tally("category"))}`);
console.log(
  `  tier:      ${Object.entries(tally("tier"))
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`
);
if (variants.length) {
  console.log(`  same-answer variants (${variants.length}) — never ship two of these in one post:`);
  for (const v of variants) console.log(`    ${v.id} "${v.answerNorm}" shares its answer with ${v.variantOf}`);
}
if (problems.length) {
  console.log("  problems:");
  for (const p of problems) console.log(`   x ${p}`);
}

if (CHECK_ONLY) {
  console.log("--check: nothing written");
} else {
  fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + "\n");
  console.log(`wrote ${path.relative(HERE, BANK_PATH)} (${entries.length} entries, updated ${stamp})`);
}
process.exit(problems.some((p) => !p.includes("dropped")) ? 1 : 0);
