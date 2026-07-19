#!/usr/bin/env node
/**
 * validate.mjs — content validator for SFFS quiz rounds (mass-gen pipeline).
 *
 * Checks a round JSON against the rules in ../CONTENT_PIPELINE.md and reports
 * pass/fail per rule. Deterministic SOLVERS verify the computable kinds
 * (number series, number analogy, number puzzle, figure series, position);
 * verbal kinds (odd-one-out, verbal analogy, sentence completion) get a
 * structural check and are flagged `needs-human-check` (never hard-failed).
 *
 * De-duplication is the hard gate: every question is checked intra-round AND
 * against the persistent master bank (content/master-question-bank.json) using
 * the type-aware normalized signature from the playbook. On `--append`, a round
 * that fully passes has its 15 questions appended to the master bank.
 *
 * No external deps (Node >= 16, ESM). Usage:
 *   node validate.mjs                       # validate ALL content/rounds/*.json (read-only)
 *   node validate.mjs round-002.json        # validate one round (path or bare name)
 *   node validate.mjs --all --append        # validate all, append survivors to the bank
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUNDS_DIR = path.join(HERE, "rounds");
const SCHEMA_PATH = path.join(HERE, "schema", "round.schema.json");
const BANK_PATH = path.join(HERE, "master-question-bank.json");

const args = process.argv.slice(2);
const APPEND = args.includes("--append");
const fileArgs = args.filter((a) => !a.startsWith("--"));

// ---- helpers ---------------------------------------------------------------
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const slugify = (s) => norm(s).replace(/ /g, "-");
const DASH_RE = /[\u2013\u2014]|--/; // en dash, em dash, or double hyphen
const hasDash = (s) => DASH_RE.test(String(s));

const POLY_NAME = { 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon", circle: "circle" };
const POS_NAME = { tl: "top-left", tm: "top", tr: "top-right", rm: "right", br: "bottom-right", bm: "bottom", bl: "bottom-left", lm: "left", center: "center" };
// 8-position perimeter ring (clockwise) that dot rotations walk; center excluded.
const RING = ["tl", "tm", "tr", "rm", "br", "bm", "bl", "lm"];

const GLYPHS = ["circle", "square", "triangle", "diamond", "star", "heart", "cross", "arrow", "crescent", "lightning", "teardrop"];
const DOTPOS = ["tl", "tm", "tr", "rm", "br", "bm", "bl", "lm", "center"];
const LETTERS = ["A", "B", "C", "D"];
const CATS = ["verbal", "quantitative", "nonverbal"];
const DIFFS = ["easy", "medium", "hard"];
const KINDS = ["text", "numseries", "shaded", "polygon", "dot"];

// ---- deterministic solvers -------------------------------------------------
function solveSeries(nums) {
  const n = nums.length;
  if (n < 3) return null;
  const d = nums.slice(1).map((v, i) => v - nums[i]);
  if (d.every((x) => x === d[0])) return { next: nums[n - 1] + d[0], rule: `+${d[0]}` };
  const r = nums[1] / nums[0];
  if (nums.every((v, i) => i === 0 || Math.abs(nums[i - 1] * r - v) < 1e-9)) {
    const nx = nums[n - 1] * r;
    if (Number.isInteger(nx)) return { next: nx, rule: `x${r}` };
  }
  if (nums.every((v, i) => i < 2 || v === nums[i - 1] + nums[i - 2])) return { next: nums[n - 1] + nums[n - 2], rule: "add-last-two" };
  const dd = d.slice(1).map((v, i) => v - d[i]);
  if (dd.length >= 1 && dd.every((x) => x === dd[0])) {
    const nd = d[d.length - 1] + dd[0];
    return { next: nums[n - 1] + nd, rule: `2nd-diff ${dd[0]}` };
  }
  return null;
}

function solveMapping(question) {
  const pairs = [...question.matchAll(/(-?\d+)\s*->\s*(-?\d+)/g)].map((m) => [+m[1], +m[2]]);
  const qm = question.match(/(-?\d+)\s*->\s*\?/);
  if (!qm || pairs.length < 2) return null;
  const x = +qm[1];
  const [x1, y1] = pairs[0];
  const [x2, y2] = pairs[1];
  if (x2 === x1) return null;
  const m = (y2 - y1) / (x2 - x1);
  const c = y1 - m * x1;
  if (!pairs.every(([a, b]) => Math.abs(m * a + c - b) < 1e-9)) return null;
  const val = m * x + c;
  if (!Number.isInteger(val)) return null;
  return { next: val, rule: `f(n)=${m}n${c >= 0 ? "+" : ""}${c}` };
}

const PUZZLE_FORMULAS = [
  ["a*b", (a, b) => a * b],
  ["a+b", (a, b) => a + b],
  ["(a+b)*2", (a, b) => (a + b) * 2],
  ["(a+b)*3", (a, b) => (a + b) * 3],
  ["(a+b)*4", (a, b) => (a + b) * 4],
  ["(a+b)*5", (a, b) => (a + b) * 5],
  ["a*b+a+b", (a, b) => a * b + a + b],
  ["a*b-(a+b)", (a, b) => a * b - (a + b)],
  ["a*b+a", (a, b) => a * b + a],
  ["a*b+b", (a, b) => a * b + b],
  ["a*b-a", (a, b) => a * b - a],
  ["a*b-b", (a, b) => a * b - b],
  ["a*b*2", (a, b) => a * b * 2],
];
function solvePuzzle(question) {
  const eqs = [...question.matchAll(/(-?\d+)\s*[+\-x×*]\s*(-?\d+)\s*=\s*(-?\d+)/g)].map((m) => [+m[1], +m[2], +m[3]]);
  const qm = question.match(/(-?\d+)\s*[+\-x×*]\s*(-?\d+)\s*=\s*\?/);
  if (!qm || eqs.length < 2) return null;
  const qa = +qm[1];
  const qb = +qm[2];
  const fits = PUZZLE_FORMULAS.filter(([, f]) => eqs.every(([a, b, c]) => f(a, b) === c));
  if (!fits.length) return null;
  const finals = [...new Set(fits.map(([, f]) => f(qa, qb)))];
  return { next: finals.length === 1 ? finals[0] : null, rules: fits.map((f) => f[0]), ambiguous: finals.length > 1 };
}

function solvePolygon(seq) {
  if (seq.length < 2) return null;
  const d = seq.slice(1).map((v, i) => v - seq[i]);
  if (d.every((x) => x === d[0])) return { next: seq[seq.length - 1] + d[0], rule: `sides ${d[0] >= 0 ? "+" : ""}${d[0]}` };
  return null;
}

function solveDot(seq) {
  // constant angular step around the 8-position perimeter ring (any step 1..7,
  // excluding 0; step 4 = bounce between opposite spots is allowed but the
  // generator avoids it). The old 4-corner rotations are ring-step 2, so pilot
  // rounds still solve. Center in the sequence is not a rotation.
  if (seq.includes("center")) return null;
  const n = RING.length;
  const idx = seq.map((p) => RING.indexOf(p));
  if (idx.some((i) => i < 0) || idx.length < 2) return null;
  const steps = idx.slice(1).map((v, i) => ((v - idx[i]) % n + n) % n);
  if (steps.some((s) => s === 0) || !steps.every((s) => s === steps[0])) return null;
  const step = steps[0];
  return { next: RING[(idx[idx.length - 1] + step) % n], rule: `ring-step ${step}` };
}

// ---- signatures (playbook 4.2) --------------------------------------------
function payloadOf(q) {
  switch (q.kind) {
    case "text":
      return norm(q.question) + " || " + q.options.map((o) => norm(o.text)).sort().join("~");
    case "numseries":
      return q.seq.filter((t) => t !== "?").join("~");
    case "shaded":
      return `${q.leftShape}>${q.rightShape}=>${q.ansShape}:${q.ansFilled}`;
    case "polygon":
      return q.seq.join("~") + `=>${q.ansShape}`;
    case "dot":
      return q.seq.join("~") + `=>${q.ansPos}`;
    default:
      return "";
  }
}
function answerNormOf(q) {
  if (q.kind === "shaded") return `${q.ansFilled ? "filled" : "empty"}-${q.ansShape}`;
  if (q.kind === "polygon") return String(q.ansShape);
  if (q.kind === "dot") return q.ansPos;
  return norm(q.ansLabel);
}
const sigOf = (q) => [q.kind, q.category, slugify(q.tier), payloadOf(q), answerNormOf(q)].join("|");
const hashOf = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 12);

function tokens(s) {
  return new Set(norm(s).split(" ").filter(Boolean));
}
function jaccard(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
/** near-dup between two questions (same kind).
 *  text: reworded-prompt / same-option-set / high token overlap.
 *  numseries|shaded|polygon|dot: ORDER-sensitive payloads, and their tokens are
 *  drawn from tiny fixed alphabets (corners, digits, shapes) that collide under
 *  set-similarity, so only an EXACT payload match counts as a duplicate. */
function nearDup(qa, qb) {
  if (qa.kind !== qb.kind) return false;
  const pa = payloadOf(qa);
  const pb = payloadOf(qb);
  if (pa === pb) return true; // identical sequence/figures/positions + answer
  if (qa.kind === "text") {
    const oa = qa.options.map((o) => norm(o.text)).sort().join("~");
    const ob = qb.options.map((o) => norm(o.text)).sort().join("~");
    if (oa === ob && answerNormOf(qa) === answerNormOf(qb)) return true; // reworded prompt, same choices+answer
    return jaccard(norm(qa.tier) + " " + pa, norm(qb.tier) + " " + pb) >= 0.9;
  }
  return false;
}

// Shared with the generator (gen-rounds.mjs) so it uses the SAME solvers +
// signatures + near-dup logic as this validator (single source of truth).
export { solveSeries, solveMapping, solvePuzzle, solvePolygon, solveDot, payloadOf, answerNormOf, sigOf, hashOf, nearDup };

// ---- standard countdown ----------------------------------------------------
// The render pipeline uses a uniform 5s question countdown (matches the Remotion
// masters + build-cuts metadata). 5s is the default for every generated round;
// the validator warns on any other value.
const STD_COUNTDOWN = 5;

// ---- validation ------------------------------------------------------------
function requiredFieldsOk(q, add) {
  const need = {
    text: ["question", "questionFontSize", "options"],
    numseries: ["prompt", "seq", "options"],
    shaded: ["prompt", "leftShape", "rightShape", "options", "ansShape", "ansFilled"],
    polygon: ["prompt", "seq", "options", "ansShape"],
    dot: ["prompt", "seq", "options", "ansPos"],
  }[q.kind];
  if (!need) return add("fail", `q${q.id}: unknown kind "${q.kind}"`);
  for (const f of need) if (!(f in q)) add("fail", `q${q.id} (${q.kind}): missing field "${f}"`);
}

function validateRound(round, dedupPool) {
  const R = []; // results: {level,msg}
  const add = (level, msg) => R.push({ level, msg });
  const humanCheck = [];

  // ---- top-level shape ----
  if (typeof round.round !== "number") add("fail", "top: `round` must be a number");
  if (!/^round-\d{3}$/.test(round.slug || "")) add("fail", "top: `slug` must match round-NNN");
  if (round.grade !== 5) add("fail", "top: `grade` must be 5");
  if (round.cogatLevel !== 11) add("fail", "top: `cogatLevel` must be 11");
  if (hasDash(round.title || "")) add("fail", "top: `title` contains an em/en dash or --");
  const qs = Array.isArray(round.questions) ? round.questions : [];
  if (qs.length !== 15) add("fail", `top: expected 15 questions, got ${qs.length}`);

  // ---- per-question ----
  const cat = { verbal: 0, quantitative: 0, nonverbal: 0 };
  const diff = { easy: 0, medium: 0, hard: 0 };
  const nonverbalKinds = { shaded: 0, polygon: 0, dot: 0 };
  const letters = { A: 0, B: 0, C: 0, D: 0 };
  const seenSig = new Map();

  qs.forEach((q, i) => {
    const id = q.id ?? `#${i + 1}`;
    if (q.id !== i + 1) add("warn", `q${id}: id should equal play position ${i + 1}`);
    if (!KINDS.includes(q.kind)) add("fail", `q${id}: invalid kind`);
    if (!CATS.includes(q.category)) add("fail", `q${id}: invalid category`);
    if (!DIFFS.includes(q.difficulty)) add("fail", `q${id}: invalid difficulty`);
    if (!(typeof q.countdown === "number" && q.countdown >= 5 && q.countdown <= 8)) add("fail", `q${id}: countdown out of 5..8`);
    if (!LETTERS.includes(q.ansLetter)) add("fail", `q${id}: invalid ansLetter`);
    if (typeof q.explanation !== "string" || !q.explanation) add("fail", `q${id}: missing explanation`);
    requiredFieldsOk(q, add);
    if (CATS.includes(q.category)) cat[q.category]++;
    if (DIFFS.includes(q.difficulty)) diff[q.difficulty]++;
    if (LETTERS.includes(q.ansLetter)) letters[q.ansLetter]++;
    if (q.category === "nonverbal" && q.kind in nonverbalKinds) nonverbalKinds[q.kind]++;

    // options shape + letters A-D
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length !== 4) add("fail", `q${id}: must have exactly 4 options`);
    const optLetters = opts.map((o) => o.letter);
    if (JSON.stringify([...optLetters].sort()) !== JSON.stringify(LETTERS)) add("fail", `q${id}: option letters must be A,B,C,D`);
    const byLetter = Object.fromEntries(opts.map((o) => [o.letter, o]));

    // enum checks per kind
    if (q.kind === "shaded") {
      if (!GLYPHS.includes(q.leftShape) || !GLYPHS.includes(q.rightShape) || !GLYPHS.includes(q.ansShape)) add("fail", `q${id}: shaded shape not a glyph`);
      opts.forEach((o) => { if (!GLYPHS.includes(o.shape) || typeof o.filled !== "boolean") add("fail", `q${id}: bad shape option ${o.letter}`); });
    }
    if (q.kind === "polygon") {
      const okPoly = (p) => p === "circle" || (Number.isInteger(p) && p >= 3 && p <= 8);
      if (!okPoly(q.ansShape)) add("fail", `q${id}: polygon ansShape invalid`);
      if (!q.seq.every((s) => Number.isInteger(s) && s >= 3 && s <= 8)) add("fail", `q${id}: polygon seq must be ints 3..8`);
      opts.forEach((o) => { if (!okPoly(o.poly)) add("fail", `q${id}: bad poly option ${o.letter}`); });
    }
    if (q.kind === "dot") {
      if (!DOTPOS.includes(q.ansPos)) add("fail", `q${id}: dot ansPos invalid`);
      if (!q.seq.every((s) => DOTPOS.includes(s))) add("fail", `q${id}: dot seq invalid`);
      opts.forEach((o) => { if (!DOTPOS.includes(o.pos)) add("fail", `q${id}: bad dot option ${o.letter}`); });
    }
    if (q.kind === "numseries" && !q.seq.includes("?")) add("fail", `q${id}: numseries seq must include "?"`);

    // no dashes in displayed strings
    const strings = [q.tier, q.question, q.prompt, q.ansLabel, q.explanation, ...opts.map((o) => o.text)].filter((s) => typeof s === "string");
    for (const s of strings) if (hasDash(s)) add("fail", `q${id}: em/en dash or -- in "${s}"`);

    // ---- structural one-correct ----
    const marked = byLetter[q.ansLetter];
    if (!marked) { add("fail", `q${id}: ansLetter ${q.ansLetter} not among options`); return; }
    if (q.kind === "text" || q.kind === "numseries") {
      if (norm(marked.text) !== norm(q.ansLabel)) add("fail", `q${id}: ansLabel "${q.ansLabel}" != option ${q.ansLetter} "${marked.text}"`);
      const hits = opts.filter((o) => norm(o.text) === norm(q.ansLabel)).length;
      if (hits !== 1) add("fail", `q${id}: ${hits} options equal the answer (need exactly 1)`);
    } else if (q.kind === "shaded") {
      if (!(marked.shape === q.ansShape && marked.filled === q.ansFilled)) add("fail", `q${id}: option ${q.ansLetter} != ansShape/ansFilled`);
      const hits = opts.filter((o) => o.shape === q.ansShape && o.filled === q.ansFilled).length;
      if (hits !== 1) add("fail", `q${id}: ${hits} options match ansShape/ansFilled (need 1)`);
      if (norm(q.ansLabel) !== norm(`${q.ansFilled ? "filled" : "empty"} ${q.ansShape}`)) add("warn", `q${id}: ansLabel should read "${q.ansFilled ? "FILLED" : "EMPTY"} ${q.ansShape.toUpperCase()}"`);
    } else if (q.kind === "polygon") {
      if (marked.poly !== q.ansShape) add("fail", `q${id}: option ${q.ansLetter} poly != ansShape`);
      const hits = opts.filter((o) => o.poly === q.ansShape).length;
      if (hits !== 1) add("fail", `q${id}: ${hits} options equal ansShape (need 1)`);
      if (norm(q.ansLabel) !== norm(POLY_NAME[q.ansShape] || "")) add("warn", `q${id}: ansLabel should read "${(POLY_NAME[q.ansShape] || "").toUpperCase()}"`);
    } else if (q.kind === "dot") {
      if (marked.pos !== q.ansPos) add("fail", `q${id}: option ${q.ansLetter} pos != ansPos`);
      const hits = opts.filter((o) => o.pos === q.ansPos).length;
      if (hits !== 1) add("fail", `q${id}: ${hits} options equal ansPos (need 1)`);
      if (norm(q.ansLabel) !== norm(POS_NAME[q.ansPos] || "")) add("warn", `q${id}: ansLabel should read "${(POS_NAME[q.ansPos] || "").toUpperCase()}"`);
    }

    // ---- semantic solvers ----
    const tier = (q.tier || "").toUpperCase();
    if (q.kind === "numseries") {
      const nums = q.seq.filter((t) => t !== "?").map(Number);
      const s = solveSeries(nums);
      if (!s) add("warn", `q${id}: series rule not auto-detected -> needs-human-check`), humanCheck.push(hcRow(q, "series rule not auto-detected"));
      else if (s.next !== Number(q.ansLabel)) add("fail", `q${id}: solver says next=${s.next} (${s.rule}) but answer=${q.ansLabel}`);
      else if (opts.filter((o) => Number(o.text) === s.next).length !== 1) add("fail", `q${id}: a distractor equals the solved next (${s.next})`);
    } else if (tier.includes("NUMBER ANALOGY")) {
      const s = solveMapping(q.question || "");
      if (!s) add("warn", `q${id}: mapping rule not auto-detected -> needs-human-check`), humanCheck.push(hcRow(q, "mapping not auto-detected"));
      else if (s.next !== Number(q.ansLabel)) add("fail", `q${id}: solver says ${s.rule}=${s.next} but answer=${q.ansLabel}`);
      else if (opts.filter((o) => Number(o.text) === s.next).length !== 1) add("fail", `q${id}: a distractor equals the solved value (${s.next})`);
    } else if (tier.includes("NUMBER PUZZLE")) {
      const s = solvePuzzle(q.question || "");
      if (!s) add("warn", `q${id}: puzzle rule not auto-detected -> needs-human-check`), humanCheck.push(hcRow(q, "puzzle not auto-detected"));
      else if (s.ambiguous) add("fail", `q${id}: puzzle ambiguous (fits ${s.rules.join(", ")})`);
      else if (s.next !== Number(q.ansLabel)) add("fail", `q${id}: puzzle rule ${s.rules[0]} -> ${s.next} but answer=${q.ansLabel}`);
      else if (opts.filter((o) => Number(o.text) === s.next).length !== 1) add("fail", `q${id}: a distractor equals the puzzle answer (${s.next})`);
    } else if (q.kind === "polygon") {
      const s = solvePolygon(q.seq);
      if (!s) add("warn", `q${id}: polygon rule not auto-detected -> needs-human-check`);
      else if (s.next !== q.ansShape) add("fail", `q${id}: side-count rule -> ${s.next} but ansShape=${q.ansShape}`);
    } else if (q.kind === "dot") {
      const s = solveDot(q.seq);
      if (!s) add("warn", `q${id}: dot rotation not auto-detected -> needs-human-check`);
      else if (s.next !== q.ansPos) add("fail", `q${id}: ${s.rule} -> ${s.next} but ansPos=${q.ansPos}`);
    } else if (q.kind === "shaded") {
      if (!(q.ansShape === q.rightShape && q.ansFilled === true)) add("fail", `q${id}: figure-analogy answer must be the RIGHT shape, filled`);
    } else {
      // odd-one-out / verbal analogy / sentence completion: no solver
      humanCheck.push(hcRow(q, "verbal item (no deterministic solver)"));
    }

    // countdown: uniform 5s standard (soft)
    if (q.countdown !== STD_COUNTDOWN) add("warn", `q${id}: countdown ${q.countdown}s (standard is ${STD_COUNTDOWN}s)`);

    // intra-round dedup
    const sig = sigOf(q);
    if (seenSig.has(sig)) add("fail", `q${id}: duplicate of q${seenSig.get(sig)} in this round`);
    else {
      for (const [osig, oid] of seenSig) {
        const other = qs[oid - 1];
        if (other && nearDup(q, other)) { add("fail", `q${id}: near-duplicate of q${oid} in this round`); break; }
      }
      seenSig.set(sig, q.id);
    }

    // master-bank dedup
    for (const e of dedupPool) {
      if (e.slug === round.slug) continue; // ignore this round's own prior entries
      if (e.hash === hashOf(sig) || e.sig === sig) { add("fail", `q${id}: exact duplicate of bank ${e.slug} q${e.id}`); break; }
      if (e._q && nearDup(q, e._q)) { add("fail", `q${id}: near-duplicate of bank ${e.slug} q${e.id}`); break; }
    }
  });

  // ---- round-level mix ----
  const mixOk = cat.verbal === 6 && cat.quantitative === 6 && cat.nonverbal === 3;
  if (!mixOk) add("fail", `battery mix must be 6/6/3, got verbal ${cat.verbal} / quant ${cat.quantitative} / nonverbal ${cat.nonverbal}`);
  // The 3 nonverbal items must be drawn from the solver-verified visual kinds
  // (shaded / polygon / dot), in ANY mix. This was "one each" for the pilot, but
  // the shaded figure-analogy has only 9 possible unique signatures (3 glyphs ×
  // 3, answer = right shape filled), so a strict one-shaded-per-round rule caps
  // the whole bank at 9 rounds. A flexible mix (each item still deterministically
  // solved + globally deduped) lets the bank scale while preserving the 6/6/3
  // battery. See CONTENT_PIPELINE.md (nonverbal signature space).
  const nvKindTotal = nonverbalKinds.shaded + nonverbalKinds.polygon + nonverbalKinds.dot;
  if (nvKindTotal !== 3) add("fail", `nonverbal must be 3 items drawn from shaded/polygon/dot, got ${JSON.stringify(nonverbalKinds)}`);
  const diffOk = diff.easy === 6 && diff.medium === 6 && diff.hard === 3;
  if (!diffOk) add("fail", `difficulty mix must be 6/6/3, got easy ${diff.easy} / medium ${diff.medium} / hard ${diff.hard}`);
  if (qs.length === 15 && qs[14] && qs[14].difficulty !== "hard") add("warn", "last question should be hard (finale)");
  const maxL = Math.max(...Object.values(letters));
  const minL = Math.min(...Object.values(letters));
  if (maxL > 5 || minL < 2) add("warn", `answer letters unbalanced: ${JSON.stringify(letters)}`);

  const fails = R.filter((r) => r.level === "fail");
  const warns = R.filter((r) => r.level === "warn");
  return { pass: fails.length === 0, results: R, fails, warns, humanCheck, letters, cat, diff };
}

function hcRow(q, why) {
  return { id: q.id, tier: q.tier, ansLabel: q.ansLabel, why };
}

// ---- master bank -----------------------------------------------------------
function loadBank() {
  if (!fs.existsSync(BANK_PATH)) return { version: 1, updated: today(), count: 0, entries: [] };
  return JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function entryOf(q, round) {
  const sig = sigOf(q);
  return {
    sig,
    hash: hashOf(sig),
    kind: q.kind,
    category: q.category,
    tier: q.tier,
    promptNorm: norm(q.question || q.prompt || ""),
    payloadNorm: payloadOf(q),
    answerNorm: answerNormOf(q),
    round: round.round,
    slug: round.slug,
    id: q.id,
    addedAt: today(),
  };
}

// ---- run -------------------------------------------------------------------
function resolveTargets() {
  if (fileArgs.length) return fileArgs.map((f) => (path.isAbsolute(f) ? f : fs.existsSync(f) ? f : path.join(ROUNDS_DIR, path.basename(f))));
  return fs
    .readdirSync(ROUNDS_DIR)
    .filter((f) => /^round-\d{3}\.json$/.test(f))
    .sort()
    .map((f) => path.join(ROUNDS_DIR, f));
}

function main() {
  // parse schema (existence + JSON parse) — the explicit checks above enforce its rules
  if (!fs.existsSync(SCHEMA_PATH)) { console.error("MISSING schema:", SCHEMA_PATH); process.exit(2); }
  JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

  const bank = loadBank();
  // hydrate bank entries with their source question objects for near-dup checks
  const bySlug = {};
  const pool = bank.entries.map((e) => ({ ...e }));

  const targets = resolveTargets();
  let allPass = true;
  const summaries = [];

  for (const file of targets) {
    const round = JSON.parse(fs.readFileSync(file, "utf8"));
    // load source questions for any bank entries so nearDup can compare
    for (const e of pool) {
      if (e._q) continue;
      if (!bySlug[e.slug]) {
        const p = path.join(ROUNDS_DIR, `${e.slug}.json`);
        bySlug[e.slug] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
      }
      const src = bySlug[e.slug];
      e._q = src ? src.questions.find((x) => x.id === e.id) : null;
    }

    const res = validateRound(round, pool);
    printReport(round, res);
    summaries.push({ slug: round.slug, pass: res.pass, fails: res.fails.length, warns: res.warns.length, hc: res.humanCheck.length });
    if (!res.pass) { allPass = false; continue; }

    if (APPEND) {
      if (bank.entries.some((e) => e.slug === round.slug)) {
        console.log(`  [bank] ${round.slug} already in bank — skip append`);
      } else {
        const entries = round.questions.map((q) => entryOf(q, round));
        bank.entries.push(...entries);
        bank.count = bank.entries.length;
        bank.updated = today();
        fs.writeFileSync(BANK_PATH, JSON.stringify(bank, null, 2) + "\n");
        // add to in-memory pool (with source) so later rounds dedup against it
        entries.forEach((e) => pool.push({ ...e, _q: round.questions.find((x) => x.id === e.id) }));
        console.log(`  [bank] appended ${entries.length} -> ${round.slug}; bank count = ${bank.count}`);
      }
    }
  }

  console.log("\n==================== SUMMARY ====================");
  for (const s of summaries) console.log(`  ${s.pass ? "PASS" : "FAIL"}  ${s.slug}  (${s.fails} fail, ${s.warns} warn, ${s.hc} needs-human-check)`);
  if (APPEND) console.log(`  master bank: ${loadBank().count} entries`);
  console.log(allPass ? "\nALL ROUNDS PASS" : "\nSOME ROUNDS FAILED");
  process.exit(allPass ? 0 : 1);
}

function printReport(round, res) {
  console.log(`\n### ${round.slug} — ${round.title || ""}`);
  console.log(`  mix: verbal ${res.cat.verbal} / quant ${res.cat.quantitative} / nonverbal ${res.cat.nonverbal}  |  difficulty easy ${res.diff.easy} / medium ${res.diff.medium} / hard ${res.diff.hard}  |  letters ${JSON.stringify(res.letters)}`);
  const fails = res.results.filter((r) => r.level === "fail");
  const warns = res.results.filter((r) => r.level === "warn");
  if (fails.length) { console.log("  FAILS:"); fails.forEach((f) => console.log("   x " + f.msg)); }
  if (warns.length) { console.log("  warnings:"); warns.forEach((w) => console.log("   ~ " + w.msg)); }
  console.log(`  ${res.pass ? "PASS" : "FAIL"} (${res.humanCheck.length} verbal items need human review)`);
}

// Run validation only when invoked as a CLI; importing (e.g. from gen-rounds.mjs
// to reuse the solvers) must NOT trigger a full validation pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
