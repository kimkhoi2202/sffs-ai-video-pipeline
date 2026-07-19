#!/usr/bin/env node
/**
 * gen-rounds.mjs — the mass-gen CONTENT generator for SFFS quiz rounds.
 *
 * Produces schema-valid, deterministically-solvable, GLOBALLY-DEDUPED rounds that
 * pass content/validate.mjs, following the exact pilot structure (round-001):
 * a fixed 15-slot template that already satisfies the 6/6/3 battery mix, the
 * 6/6/3 difficulty mix, and a hard finale, plus per-round answer-letter balancing.
 *
 *   quantitative  — number series / number analogy / number puzzle, each built
 *                   then RE-SOLVED with the same solvers validate.mjs uses, so a
 *                   distractor can never equal the answer and the rule is unique.
 *   nonverbal     — shaded (figure analogy) / polygon (figure series) / dot
 *                   (position), drawn from the ENUMERATED unique-signature pool
 *                   (portrait-safe sequence lengths) minus whatever the master
 *                   bank already uses, so every figure item is globally unique.
 *   verbal        — odd-one-out / verbal analogy / sentence completion, drawn
 *                   from large CURATED banks (single unambiguous Grade-5 answer,
 *                   no dashes); the AI-judge pass (see CONTENT_PIPELINE.md) is the
 *                   safety net on top of the curation.
 *
 * Signatures + solvers are mirrored EXACTLY from validate.mjs, so the generator
 * self-checks every item before writing and skips any that collide with the bank.
 *
 * Usage:
 *   node gen-rounds.mjs [--from 6] [--count 13] [--seed 42]
 *     writes content/rounds/round-006.json .. as far as the unique nonverbal
 *     signature pool allows (it stops early and reports if the pool is exhausted).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { VERBAL } from "./verbal-bank.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUNDS_DIR = path.join(HERE, "rounds");
const BANK_PATH = path.join(HERE, "master-question-bank.json");

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const FROM = Number(argVal("--from", "6"));
const COUNT = Number(argVal("--count", "13"));
let SEED = Number(argVal("--seed", "1729"));

// ---- seeded RNG (mulberry32) ----------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);
const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---- signature helpers (EXACT mirror of validate.mjs) ----------------------
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const slugify = (s) => norm(s).replace(/ /g, "-");
const POLY_NAME = { 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon", circle: "circle" };
const POS_NAME = { tl: "top-left", tr: "top-right", br: "bottom-right", bl: "bottom-left", center: "center" };
const CW = ["tl", "tr", "br", "bl"];

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

// ---- near-dup guard for TEXT items (mirrors validate.mjs nearDup for kind text) ----
// The exact-signature check is not enough for text: the validator also fails a
// text item that shares an option-set+answer OR has >= 0.9 token overlap with
// another. Number analogies/puzzles can collide that way (similar digits), so
// the generator screens every text item against a running pool (seeded from the
// bank) before accepting it.
function tokens(s) { return new Set(norm(s).split(" ").filter(Boolean)); }
function jaccard(a, b) { const A = tokens(a), B = tokens(b); if (!A.size && !B.size) return 1; let i = 0; for (const t of A) if (B.has(t)) i++; return i / (A.size + B.size - i); }
const ACCEPTED_TEXT = [];
const textKey = (q) => norm(q.tier) + " " + payloadOf(q);
const optKeyOf = (q) => q.options.map((o) => norm(o.text)).sort().join("~");
function textOK(q) {
  const k = textKey(q);
  const ok = optKeyOf(q);
  const ans = answerNormOf(q);
  for (const e of ACCEPTED_TEXT) {
    if (e.optKey === ok && e.ans === ans) return false;
    if (jaccard(k, e.key) >= 0.85) return false;
  }
  return true;
}
function acceptText(q) { ACCEPTED_TEXT.push({ key: textKey(q), optKey: optKeyOf(q), ans: answerNormOf(q) }); }

// ---- solvers (EXACT mirror of validate.mjs) --------------------------------
function solveSeries(nums) {
  const n = nums.length;
  if (n < 3) return null;
  const d = nums.slice(1).map((v, i) => v - nums[i]);
  if (d.every((x) => x === d[0])) return { next: nums[n - 1] + d[0] };
  const r = nums[1] / nums[0];
  if (nums.every((v, i) => i === 0 || Math.abs(nums[i - 1] * r - v) < 1e-9)) {
    const nx = nums[n - 1] * r;
    if (Number.isInteger(nx)) return { next: nx };
  }
  if (nums.every((v, i) => i < 2 || v === nums[i - 1] + nums[i - 2])) return { next: nums[n - 1] + nums[n - 2] };
  const dd = d.slice(1).map((v, i) => v - d[i]);
  if (dd.length >= 1 && dd.every((x) => x === dd[0])) return { next: nums[n - 1] + (d[d.length - 1] + dd[0]) };
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
  return { next: val };
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
  return { next: finals.length === 1 ? finals[0] : null, ambiguous: finals.length > 1 };
}
function solvePolygon(seq) {
  if (seq.length < 2) return null;
  const d = seq.slice(1).map((v, i) => v - seq[i]);
  if (d.every((x) => x === d[0])) return { next: seq[seq.length - 1] + d[0] };
  return null;
}
function solveDot(seq) {
  if (seq.includes("center")) return null;
  const idx = seq.map((p) => CW.indexOf(p));
  if (idx.some((i) => i < 0)) return null;
  const steps = idx.slice(1).map((v, i) => (((v - idx[i]) % 4) + 4) % 4);
  if (steps.every((s) => s === 1)) return { next: CW[(idx[idx.length - 1] + 1) % 4] };
  if (steps.every((s) => s === 3)) return { next: CW[(idx[idx.length - 1] + 3) % 4] };
  return null;
}

// ---- number helpers --------------------------------------------------------
const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
function n2w(n) {
  n = Number(n);
  if (n < 0) return "minus " + n2w(-n);
  if (n < 20) return ONES[n];
  if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return TENS[t] + (o ? "-" + ONES[o] : ""); }
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return ONES[h] + " hundred" + (r ? " " + n2w(r) : ""); }
  const th = Math.floor(n / 1000), r = n % 1000; return n2w(th) + " thousand" + (r ? " " + n2w(r) : "");
}

// distinct integer distractors around a target (never equal to it)
function numDistractors(answer, wants, extra = []) {
  const cands = [answer + 1, answer - 1, answer + 2, answer - 2, answer + 3, answer - 3, answer + 5, answer - 5, answer + 10, answer - 10, ...extra];
  const out = [];
  for (const c of shuffle(cands)) {
    if (c === answer) continue;
    if (c < 0) continue;
    if (out.includes(c)) continue;
    out.push(c);
    if (out.length === wants) break;
  }
  let bump = answer + 4;
  while (out.length < wants) { if (bump !== answer && bump >= 0 && !out.includes(bump)) out.push(bump); bump++; }
  return out;
}

// ---- option assembly (place correct at a target letter, distractors fill) ---
const LETTERS = ["A", "B", "C", "D"];
function placeText(correct, distractors, targetLetter) {
  const ti = LETTERS.indexOf(targetLetter);
  const others = shuffle(distractors);
  const slots = [];
  let di = 0;
  for (let i = 0; i < 4; i++) slots.push(i === ti ? correct : others[di++]);
  return slots.map((text, i) => ({ letter: LETTERS[i], text: String(text) }));
}
function placeObj(correctObj, distractorObjs, targetLetter, key) {
  const ti = LETTERS.indexOf(targetLetter);
  const others = shuffle(distractorObjs);
  const slots = [];
  let di = 0;
  for (let i = 0; i < 4; i++) slots.push(i === ti ? correctObj : others[di++]);
  return slots.map((o, i) => ({ letter: LETTERS[i], ...o }));
}

// ---- QUANTITATIVE generators ----------------------------------------------
function genSeries(difficulty, targetLetter, usedSig) {
  for (let attempt = 0; attempt < 800; attempt++) {
    let nums;
    if (difficulty === "easy") {
      const type = pick(["arith", "arith", "geo"]);
      if (type === "arith") { const s = randInt(1, 15), d = pick([2, 3, 4, 5, 6]); nums = [s, s + d, s + 2 * d, s + 3 * d]; }
      else { const s = pick([1, 2, 3]), r = pick([2, 3]); nums = [s, s * r, s * r * r, s * r * r * r]; }
    } else if (difficulty === "medium") {
      const type = pick(["arith", "fib", "geo"]);
      if (type === "arith") { const s = randInt(2, 12), d = pick([6, 7, 8, 9, 11]); nums = [s, s + d, s + 2 * d, s + 3 * d]; }
      else if (type === "geo") { const s = pick([2, 3, 4]), r = 2; nums = [s, s * r, s * r * r, s * r * r * r]; }
      else { let a = randInt(1, 3), b = randInt(2, 4); nums = [a, b, a + b, a + 2 * b, 2 * a + 3 * b]; }
    } else {
      const type = pick(["fib", "sqdiff"]);
      if (type === "fib") { let a = randInt(2, 4), b = randInt(3, 6); const s = [a, b]; while (s.length < 5) s.push(s[s.length - 1] + s[s.length - 2]); nums = s; }
      else { const s = randInt(1, 4), d0 = pick([1, 2, 3]), dd = pick([1, 2, 3]); const out = [s]; let d = d0; for (let i = 0; i < 4; i++) { out.push(out[out.length - 1] + d); d += dd; } nums = out; }
    }
    if (nums.some((x) => !Number.isInteger(x) || x < 0 || x > 999)) continue;
    const solved = solveSeries(nums);
    if (!solved) continue;
    const next = solved.next;
    if (!Number.isInteger(next) || next < 0 || next > 999) continue;
    const seq = [...nums.map(String), "?"];
    const distr = numDistractors(next, 3);
    if (distr.includes(next) || new Set(distr).size !== 3) continue;
    const options = placeText(next, distr, targetLetter);
    if (options.filter((o) => Number(o.text) === next).length !== 1) continue;
    const q = { kind: "numseries", category: "quantitative", tier: "NUMBER SERIES", prompt: "WHAT COMES NEXT?", seq, options, ansLetter: targetLetter, ansLabel: String(next), explanation: seriesExplain(nums, next) };
    const sig = sigOf(q);
    if (usedSig.has(sig)) continue;
    usedSig.add(sig);
    return q;
  }
  return null;
}
function seriesExplain(nums, next) {
  const d = nums.slice(1).map((v, i) => v - nums[i]);
  if (d.every((x) => x === d[0])) return `Each number goes up by ${n2w(d[0])}, so the next one is ${n2w(nums[nums.length - 1])} plus ${n2w(d[0])} is ${n2w(next)}.`;
  const r = nums[1] / nums[0];
  if (nums.every((v, i) => i === 0 || nums[i - 1] * r === v)) return `Each number is multiplied by ${n2w(r)}, so the next one is ${n2w(nums[nums.length - 1])} times ${n2w(r)} is ${n2w(next)}.`;
  if (nums.every((v, i) => i < 2 || v === nums[i - 1] + nums[i - 2])) return `Add the two numbers before it: ${n2w(nums[nums.length - 1])} plus ${n2w(nums[nums.length - 2])} is ${n2w(next)}.`;
  return `The gaps grow by the same amount each step, so the next number is ${n2w(next)}.`;
}

function genAnalogyNum(difficulty, targetLetter, usedSig) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const m = pick(difficulty === "easy" ? [2, 3] : [2, 3, 4]);
    const c = pick(difficulty === "hard" ? [-3, -2, -1, 1, 2, 3, 4, 5] : [1, 2, 3, -1, -2]);
    const xs = shuffle([2, 3, 4, 5, 6, 7]).slice(0, 3).sort((a, b) => a - b);
    const qx = pick([5, 6, 7, 8, 9].filter((v) => !xs.includes(v)));
    const f = (x) => m * x + c;
    const ys = xs.map(f);
    const ans = f(qx);
    if (ys.some((y) => y < 0) || ans < 0 || ans > 99) continue;
    const question = `WHICH NUMBER FITS?\n${xs.map((x, i) => `${x} -> ${ys[i]}`).join(",   ")},   ${qx} -> ?`;
    if (!solveMapping(question) || solveMapping(question).next !== ans) continue;
    const distr = numDistractors(ans, 3, [ans + m, ans - m, m * qx]);
    if (distr.includes(ans) || new Set(distr).size !== 3) continue;
    const options = placeText(ans, distr, targetLetter);
    if (options.filter((o) => Number(o.text) === ans).length !== 1) continue;
    const opWord = c === 0 ? "" : c > 0 ? ` then add ${n2w(c)}` : ` then take away ${n2w(-c)}`;
    const q = { kind: "text", category: "quantitative", tier: "NUMBER ANALOGY", question, questionFontSize: 80, options, ansLetter: targetLetter, ansLabel: String(ans), explanation: `Each number is multiplied by ${n2w(m)}${opWord}, so ${n2w(qx)} becomes ${n2w(ans)}.` };
    const sig = sigOf(q);
    if (usedSig.has(sig) || !textOK(q)) continue;
    usedSig.add(sig);
    acceptText(q);
    return q;
  }
  return null;
}

function genPuzzle(targetLetter, usedSig) {
  for (let attempt = 0; attempt < 900; attempt++) {
    const [name, f] = pick(PUZZLE_FORMULAS.filter(([n]) => n !== "a+b" && n !== "a*b"));
    const pairs = [];
    const seen = new Set();
    while (pairs.length < 3) {
      const a = randInt(1, 6), b = randInt(1, 6);
      const key = `${a},${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push([a, b]);
    }
    const qa = randInt(2, 6), qb = randInt(2, 6);
    const ans = f(qa, qb);
    if (ans < 0 || ans > 99) continue;
    const question = `IF  ${pairs.map(([a, b]) => `${a}+${b}=${f(a, b)}`).join(",  ")}\nTHEN  ${qa}+${qb} = ?`;
    const solved = solvePuzzle(question);
    if (!solved || solved.ambiguous || solved.next !== ans) continue;
    const distr = numDistractors(ans, 3, [qa + qb, qa * qb, (qa + qb) * 2]);
    if (distr.includes(ans) || new Set(distr).size !== 3) continue;
    const options = placeText(ans, distr, targetLetter);
    if (options.filter((o) => Number(o.text) === ans).length !== 1) continue;
    const q = { kind: "text", category: "quantitative", tier: "NUMBER PUZZLE", question, questionFontSize: 84, options, ansLetter: targetLetter, ansLabel: String(ans), explanation: puzzleExplain(name, qa, qb, ans) };
    const sig = sigOf(q);
    if (usedSig.has(sig) || !textOK(q)) continue;
    usedSig.add(sig);
    acceptText(q);
    return q;
  }
  return null;
}
function puzzleExplain(name, a, b, ans) {
  const map = {
    "(a+b)*2": `add the two numbers, then double: ${n2w(a)} plus ${n2w(b)} is ${n2w(a + b)}, and ${n2w(a + b)} times two is ${n2w(ans)}`,
    "(a+b)*3": `add the two numbers, then triple: ${n2w(a)} plus ${n2w(b)} is ${n2w(a + b)}, times three is ${n2w(ans)}`,
    "(a+b)*4": `add the two numbers, then times four: ${n2w(a + b)} times four is ${n2w(ans)}`,
    "(a+b)*5": `add the two numbers, then times five: ${n2w(a + b)} times five is ${n2w(ans)}`,
    "a*b+a+b": `multiply them, then add both back: ${n2w(a)} times ${n2w(b)} is ${n2w(a * b)}, plus ${n2w(a)} plus ${n2w(b)} is ${n2w(ans)}`,
    "a*b-(a+b)": `multiply them, then take away their sum: ${n2w(a * b)} minus ${n2w(a + b)} is ${n2w(ans)}`,
    "a*b+a": `multiply them, then add the first: ${n2w(a * b)} plus ${n2w(a)} is ${n2w(ans)}`,
    "a*b+b": `multiply them, then add the second: ${n2w(a * b)} plus ${n2w(b)} is ${n2w(ans)}`,
    "a*b-a": `multiply them, then take away the first: ${n2w(a * b)} minus ${n2w(a)} is ${n2w(ans)}`,
    "a*b-b": `multiply them, then take away the second: ${n2w(a * b)} minus ${n2w(b)} is ${n2w(ans)}`,
    "a*b*2": `multiply them, then double: ${n2w(a * b)} times two is ${n2w(ans)}`,
  };
  return `The trick is to ${map[name] || `use the hidden rule to get ${n2w(ans)}`}.`;
}

// ---- NONVERBAL generators (from the enumerated unique-signature pool) -------
const GLYPHS = ["circle", "square", "triangle"];
function enumShaded() {
  const out = [];
  for (const L of GLYPHS) for (const R of GLYPHS) out.push({ leftShape: L, rightShape: R, ansShape: R, ansFilled: true });
  return out;
}
function enumPolygon() {
  const out = [];
  for (let len = 2; len <= 4; len++) for (const step of [-2, -1, 1, 2]) for (let s = 3; s <= 8; s++) {
    const seq = []; let ok = true;
    for (let i = 0; i < len; i++) { const v = s + i * step; if (v < 3 || v > 8) { ok = false; break; } seq.push(v); }
    if (!ok) continue;
    const next = seq[seq.length - 1] + step;
    if (next < 3 || next > 8) continue;
    out.push({ seq, ansShape: next });
  }
  return out;
}
function enumDot() {
  const out = [];
  for (let len = 2; len <= 4; len++) for (const dir of [1, 3]) for (let st = 0; st < 4; st++) {
    const seq = []; for (let i = 0; i < len; i++) seq.push(CW[(st + i * dir) % 4]);
    const next = CW[(st + len * dir) % 4];
    out.push({ seq, ansPos: next, dir });
  }
  return out;
}
function buildShaded(base, targetLetter) {
  const correct = { shape: base.rightShape, filled: true };
  const pool = [];
  for (const g of GLYPHS) for (const f of [true, false]) if (!(g === correct.shape && f === true)) pool.push({ shape: g, filled: f });
  const distr = shuffle(pool).slice(0, 3);
  const options = placeObj(correct, distr, targetLetter, "shape");
  return { kind: "shaded", category: "nonverbal", tier: "FIGURE ANALOGY", difficulty: "easy", prompt: "WHICH SHAPE COMPLETES THE PATTERN?", leftShape: base.leftShape, rightShape: base.rightShape, options, ansLetter: targetLetter, ansShape: base.ansShape, ansFilled: true, ansLabel: `FILLED ${base.rightShape.toUpperCase()}`, explanation: `The rule is the shape gets filled in but stays the same shape, so the empty ${base.rightShape} becomes a filled ${base.rightShape}.` };
}
function buildPolygon(base, difficulty, targetLetter) {
  const correct = { poly: base.ansShape };
  const others = [3, 4, 5, 6, 7, 8, "circle"].filter((p) => p !== base.ansShape);
  const distr = shuffle(others).slice(0, 3).map((p) => ({ poly: p }));
  const options = placeObj(correct, distr, targetLetter, "poly");
  const step = base.seq[1] - base.seq[0];
  const dir = step > 0 ? "up" : "down";
  return { kind: "polygon", category: "nonverbal", tier: "FIGURE SERIES", difficulty, prompt: "WHICH SHAPE COMES NEXT?", seq: base.seq, options, ansLetter: targetLetter, ansShape: base.ansShape, ansLabel: POLY_NAME[base.ansShape].toUpperCase(), explanation: `The number of sides goes ${dir} by ${n2w(Math.abs(step))} each step, so the next shape is the ${POLY_NAME[base.ansShape]}.` };
}
function buildDot(base, difficulty, targetLetter) {
  const correct = { pos: base.ansPos };
  const others = ["tl", "tr", "br", "bl", "center"].filter((p) => p !== base.ansPos);
  const distr = shuffle(others).slice(0, 3).map((p) => ({ pos: p }));
  const options = placeObj(correct, distr, targetLetter, "pos");
  const dirName = base.dir === 1 ? "clockwise" : "counter-clockwise";
  return { kind: "dot", category: "nonverbal", tier: "POSITION", difficulty, prompt: "WHERE DOES THE DOT MOVE NEXT?", seq: base.seq, options, ansLetter: targetLetter, ansPos: base.ansPos, ansLabel: POS_NAME[base.ansPos].toUpperCase(), explanation: `The dot steps ${dirName} around the corners, so the next spot is ${POS_NAME[base.ansPos]}.` };
}

// ---- VERBAL builders (from curated bank) -----------------------------------
function buildVerbal(item, tier, difficulty, targetLetter) {
  // item: { q, correct, distractors[3], explanation, [fontSize] }
  const options = placeText(item.correct, item.distractors, targetLetter);
  const fontSize = item.fontSize || (tier === "SENTENCE COMPLETION" ? 58 : tier === "ODD ONE OUT" ? 96 : 88);
  return { kind: "text", category: "verbal", tier, question: item.q, questionFontSize: fontSize, options, ansLetter: targetLetter, ansLabel: String(item.correct), explanation: item.explanation };
}

// ---- round template (mirrors pilot round-001; 6/6/3 battery + difficulty) ---
// slot: [category-tier-key, difficulty]; nonverbal slots are resolved to the
// available pool at build time (shaded first, then flexible polygon/dot).
const TEMPLATE = [
  ["oddoneout", "easy"],    // 1 verbal
  ["series", "easy"],       // 2 quant
  ["nv1", "easy"],          // 3 nonverbal (shaded if available, else polygon/dot)
  ["analogy", "easy"],      // 4 verbal
  ["series", "easy"],       // 5 quant
  ["analogy", "medium"],    // 6 verbal
  ["series", "hard"],       // 7 quant
  ["analogy", "easy"],      // 8 verbal
  ["series", "medium"],     // 9 quant
  ["oddoneout", "medium"],  // 10 verbal
  ["nv2", "medium"],        // 11 nonverbal (polygon)
  ["sentence", "hard"],     // 12 verbal
  ["nv3", "medium"],        // 13 nonverbal (dot)
  ["numanalogy", "medium"], // 14 quant
  ["puzzle", "hard"],       // 15 quant
];

// balanced answer letters across 15 (max 5, min 2): 4/4/4/3
function letterPlan() {
  return shuffle(["A", "A", "A", "A", "B", "B", "B", "B", "C", "C", "C", "C", "D", "D", "D"]);
}

// ---- main ------------------------------------------------------------------
function loadBank() {
  return JSON.parse(fs.readFileSync(BANK_PATH, "utf8"));
}
function main() {
  const bank = loadBank();
  const usedSig = new Set(bank.entries.map((e) => e.sig));
  const usedNVpayload = new Set(bank.entries.filter((e) => ["shaded", "polygon", "dot"].includes(e.kind)).map((e) => e.kind + "|" + e.payloadNorm));
  // seed the text near-dup pool with the bank's existing text items
  for (const e of bank.entries) if (e.kind === "text") ACCEPTED_TEXT.push({ key: norm(e.tier) + " " + e.payloadNorm, optKey: (e.payloadNorm.split(" || ")[1] || ""), ans: e.answerNorm });

  // available nonverbal pools (minus bank)
  const shadedPool = shuffle(enumShaded().filter((b) => !usedNVpayload.has("shaded|" + `${b.leftShape}>${b.rightShape}=>${b.ansShape}:${b.ansFilled}`)));
  const polyPool = shuffle(enumPolygon().filter((b) => !usedNVpayload.has("polygon|" + b.seq.join("~") + "=>" + b.ansShape)));
  const dotPool = shuffle(enumDot().filter((b) => !usedNVpayload.has("dot|" + b.seq.join("~") + "=>" + b.ansPos)));

  // verbal pools (curated), filter out anything whose signature already exists
  const vpool = {
    oddoneout: shuffle(VERBAL.oddoneout.filter((it) => !usedSig.has(sigOf(buildVerbal(it, "ODD ONE OUT", "easy", "A"))))),
    analogy: shuffle(VERBAL.analogy.filter((it) => !usedSig.has(sigOf(buildVerbal(it, "VERBAL ANALOGY", "easy", "A"))))),
    sentence: shuffle(VERBAL.sentence.filter((it) => !usedSig.has(sigOf(buildVerbal(it, "SENTENCE COMPLETION", "hard", "A"))))),
  };

  const takeNV = (difficulty, targetLetter, kindPref) => {
    // kindPref: "shaded" | "flexible". Returns a built nonverbal q with a fresh signature.
    const tryBuild = (builder, pool) => {
      while (pool.length) {
        const base = pool.pop();
        const q = builder(base);
        if (!usedSig.has(sigOf(q))) { usedSig.add(sigOf(q)); return q; }
      }
      return null;
    };
    if (kindPref === "shaded" && shadedPool.length) {
      const q = tryBuild((b) => buildShaded(b, targetLetter), shadedPool);
      if (q) return q;
    }
    // flexible: prefer whichever pool is largest to spread usage
    const order = [
      ["polygon", polyPool, (b) => buildPolygon(b, difficulty, targetLetter)],
      ["dot", dotPool, (b) => buildDot(b, difficulty, targetLetter)],
      ["shaded", shadedPool, (b) => buildShaded(b, targetLetter)],
    ].sort((x, y) => y[1].length - x[1].length);
    for (const [, pool, builder] of order) {
      const q = tryBuild(builder, pool);
      if (q) return q;
    }
    return null;
  };

  const takeVerbal = (key, tier, difficulty, targetLetter) => {
    const pool = vpool[key];
    while (pool.length) {
      const it = pool.pop();
      const q = buildVerbal(it, tier, difficulty, targetLetter);
      if (!usedSig.has(sigOf(q))) { usedSig.add(sigOf(q)); acceptText(q); return q; }
    }
    return null;
  };

  const madeRounds = [];
  let insufficient = null;
  for (let k = 0; k < COUNT; k++) {
    const roundNum = FROM + k;
    const slug = `round-${String(roundNum).padStart(3, "0")}`;
    const letters = letterPlan();
    const questions = [];
    let failed = false;

    for (let i = 0; i < TEMPLATE.length; i++) {
      const [key, difficulty] = TEMPLATE[i];
      const tl = letters[i];
      let q = null;
      if (key === "series") q = genSeries(difficulty, tl, usedSig);
      else if (key === "numanalogy") q = genAnalogyNum(difficulty, tl, usedSig);
      else if (key === "puzzle") q = genPuzzle(tl, usedSig);
      else if (key === "oddoneout") q = takeVerbal("oddoneout", "ODD ONE OUT", difficulty, tl);
      else if (key === "analogy") q = takeVerbal("analogy", "VERBAL ANALOGY", difficulty, tl);
      else if (key === "sentence") q = takeVerbal("sentence", "SENTENCE COMPLETION", difficulty, tl);
      else if (key === "nv1") q = takeNV(difficulty, tl, "shaded");
      else if (key === "nv2") q = takeNV(difficulty, tl, "flexible");
      else if (key === "nv3") q = takeNV(difficulty, tl, "flexible");

      if (!q) { failed = true; insufficient = `${slug} slot ${i + 1} (${key}/${difficulty}) exhausted its pool`; break; }
      q.difficulty = difficulty;
      q.countdown = 5;
      q.id = i + 1;
      questions.push(orderFields(q));
    }
    if (failed) break;

    const round = {
      round: roundNum,
      slug,
      title: titleFor(roundNum),
      grade: 5,
      cogatLevel: 11,
      batteryMix: { verbal: 6, quantitative: 6, nonverbal: 3 },
      questions,
    };
    fs.writeFileSync(path.join(ROUNDS_DIR, `${slug}.json`), JSON.stringify(round, null, 2) + "\n");
    madeRounds.push(slug);
  }

  console.log(`generated ${madeRounds.length} round(s): ${madeRounds.join(", ") || "(none)"}`);
  if (insufficient) console.log(`stopped early: ${insufficient}`);
  console.log(`remaining pools -> shaded ${shadedPool.length}, polygon ${polyPool.length}, dot ${dotPool.length}, oddoneout ${vpool.oddoneout.length}, analogy ${vpool.analogy.length}, sentence ${vpool.sentence.length}`);
}

function titleFor(n) {
  const themes = ["Words, Numbers and Shapes", "Puzzles, Patterns and Brain Teasers", "Think Fast, Think Smart", "Riddles, Series and Shapes", "Clever Clues and Number Tricks", "Analogies, Sums and Figures", "Brainy Bunch Challenge", "Smart Start Quiz", "Mix It Up Round", "Logic and Language", "Shapes, Sums and Sayings", "Quick Wits Workout", "The Whole Brain Round"];
  return `Round ${n}: ${themes[(n - 6 + themes.length) % themes.length]}`;
}
function orderFields(q) {
  // stable key order matching the pilot round JSONs
  const base = { id: q.id, kind: q.kind, category: q.category, tier: q.tier, difficulty: q.difficulty, countdown: q.countdown };
  if (q.kind === "text") return { ...base, question: q.question, questionFontSize: q.questionFontSize, options: q.options, ansLetter: q.ansLetter, ansLabel: q.ansLabel, explanation: q.explanation };
  if (q.kind === "numseries") return { ...base, prompt: q.prompt, seq: q.seq, options: q.options, ansLetter: q.ansLetter, ansLabel: q.ansLabel, explanation: q.explanation };
  if (q.kind === "shaded") return { ...base, prompt: q.prompt, leftShape: q.leftShape, rightShape: q.rightShape, options: q.options, ansLetter: q.ansLetter, ansShape: q.ansShape, ansFilled: q.ansFilled, ansLabel: q.ansLabel, explanation: q.explanation };
  if (q.kind === "polygon") return { ...base, prompt: q.prompt, seq: q.seq, options: q.options, ansLetter: q.ansLetter, ansShape: q.ansShape, ansLabel: q.ansLabel, explanation: q.explanation };
  if (q.kind === "dot") return { ...base, prompt: q.prompt, seq: q.seq, options: q.options, ansLetter: q.ansLetter, ansPos: q.ansPos, ansLabel: q.ansLabel, explanation: q.explanation };
  return q;
}

main();
