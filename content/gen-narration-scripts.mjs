#!/usr/bin/env node
/**
 * gen-narration-scripts.mjs — turn a round JSON into per-beat game-show VO scripts
 * for the cloned "Booming Ringmaster" host, following CONTENT_PIPELINE.md section 7
 * and the wording style of voice/narration/narration_index.json (spelled-out
 * numbers, options listed A..D, uniform "Five seconds"). Pure + deterministic
 * (no API). Produces the 30 per-round beats q1..q15 + r1..r15; the meta beats
 * (intro/timesup/score/outro) are round-agnostic and reused as committed.
 *
 * CLI: node gen-narration-scripts.mjs rounds/round-001.json [out-beats.json]
 *   -> writes [{ beat, text }] for the 30 q/r beats (used by voice/tts_batch.py).
 * Also exported as roundScripts(round) for the batch renderer.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
export function n2w(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return "minus " + n2w(-n);
  if (n < 20) return ONES[n];
  if (n < 100) { const t = Math.floor(n / 10), o = n % 10; return TENS[t] + (o ? "-" + ONES[o] : ""); }
  if (n < 1000) { const h = Math.floor(n / 100), r = n % 100; return ONES[h] + " hundred" + (r ? " " + n2w(r) : ""); }
  const th = Math.floor(n / 1000), r = n % 1000; return n2w(th) + " thousand" + (r ? " " + n2w(r) : "");
}
const spellNums = (s) => String(s).replace(/\b\d+\b/g, (m) => n2w(m));
const isNum = (s) => /^-?\d+$/.test(String(s).trim());
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const POLY_NAME = { 3: "triangle", 4: "square", 5: "pentagon", 6: "hexagon", 7: "heptagon", 8: "octagon", circle: "circle" };
const POS_SPEAK = { tl: "top-left", tm: "top", tr: "top-right", rm: "right", br: "bottom-right", bm: "bottom", bl: "bottom-left", lm: "left", center: "center" };
// Spoken names for glyphs whose raw kind reads awkwardly aloud.
const GLYPH_SPEAK = { lightning: "lightning bolt", crescent: "crescent moon" };
const gSpeak = (shape) => GLYPH_SPEAK[shape] || shape;

const TYPE_PHRASE = {
  "ODD ONE OUT": "",
  "NUMBER SERIES": "a number series",
  "FIGURE ANALOGY": "a picture puzzle",
  "VERBAL ANALOGY": "a word analogy",
  "NUMBER ANALOGY": "a number analogy",
  "FIGURE SERIES": "a shape puzzle",
  "SENTENCE COMPLETION": "fill in the blank",
  "POSITION": "a picture puzzle",
  "NUMBER PUZZLE": "a number puzzle, and it's sneaky",
};

const art = (w) => (/^[aeiou]/i.test(String(w)) ? "an" : "a");
const withArt = (phrase) => `${art(phrase)} ${phrase}`;
/** Spoken form of one option. */
function optionSpeak(q, o) {
  if (q.kind === "shaded") return withArt(`${o.filled ? "filled" : "empty"} ${gSpeak(o.shape)}`);
  if (q.kind === "polygon") return withArt(o.poly === "circle" ? "circle" : POLY_NAME[o.poly]);
  if (q.kind === "dot") return POS_SPEAK[o.pos];
  return isNum(o.text) ? n2w(o.text) : o.text.toLowerCase();
}
/** Spoken form of the correct answer. */
function answerSpeak(q) {
  if (q.kind === "shaded") return withArt(`filled ${gSpeak(q.ansShape)}`);
  if (q.kind === "polygon") return withArt(q.ansLabel.toLowerCase());
  if (q.kind === "dot") return POS_SPEAK[q.ansPos];
  return isNum(q.ansLabel) ? n2w(q.ansLabel) : q.ansLabel.toLowerCase();
}
// Options are read exactly ONCE, as "A. Neptune, B. Hockey, C. Soccer, or D. Boxing?"
// (letter + option, comma-separated, "or" before the last). No separate letter recital.
const optionsListOr = (q) => {
  const parts = q.options.map((o) => `${o.letter}. ${cap(optionSpeak(q, o))}`);
  return parts.slice(0, -1).join(", ") + ", or " + parts[parts.length - 1] + "?";
};

/** The spoken question stem (prompt + content), before the A..D options. */
function questionStem(q) {
  const tier = q.tier.toUpperCase();
  if (tier === "ODD ONE OUT") {
    // Options are read once by optionsListOr; do NOT list the members here too
    // (that made odd-one-out read every option TWICE).
    return "Which one does NOT belong?";
  }
  if (tier === "VERBAL ANALOGY") {
    const parts = q.question.split(/ AS\n/);
    const left = parts[0].toLowerCase();
    const right = (parts[1] || "").toLowerCase().replace(/\s*\?\s*$/, "... what?");
    return `${cap(left)}, as ${right}`;
  }
  if (tier === "SENTENCE COMPLETION") {
    const s = q.question.replace(/\n/g, " ").replace(/_+/g, "blank").replace(/\s+/g, " ").trim().toLowerCase();
    return cap(s);
  }
  if (tier === "NUMBER ANALOGY") {
    const pairs = [...q.question.matchAll(/(-?\d+)\s*->\s*(-?\d+)/g)].map((m) => [m[1], m[2]]);
    const qm = q.question.match(/(-?\d+)\s*->\s*\?/);
    const body = pairs.map(([a, b]) => `${n2w(a)} makes ${n2w(b)}`).join(", ");
    return `${cap(body)}, so ${n2w(qm[1])} makes... what?`;
  }
  if (tier === "NUMBER PUZZLE") {
    const eqs = [...q.question.matchAll(/(-?\d+)\s*[+\-x×*]\s*(-?\d+)\s*=\s*(-?\d+)/g)].map((m) => [m[1], m[2], m[3]]);
    const qm = q.question.match(/(-?\d+)\s*[+\-x×*]\s*(-?\d+)\s*=\s*\?/);
    const body = eqs.map(([a, b, c]) => `${n2w(a)} plus ${n2w(b)} makes ${n2w(c)}`).join(", ");
    return `If ${body}, then ${n2w(qm[1])} plus ${n2w(qm[2])} makes... what?`;
  }
  if (q.kind === "numseries") {
    const nums = q.seq.filter((t) => t !== "?").map((t) => n2w(t)).join(", ");
    return `${cap(nums)}, and then... what comes next?`;
  }
  // Figure/shape questions (shaded / polygon / dot): read the on-screen PROMPT
  // only, then the options. Do NOT narrate the fill transformation, the
  // side-count rule, or the dot path -- those give the answer away. The figures
  // are shown on screen, so the VO stays neutral like any other question.
  if (q.kind === "shaded" || q.kind === "polygon" || q.kind === "dot") {
    return cap(q.prompt.toLowerCase());
  }
  return q.question.replace(/\n/g, " ");
}

// POSITION-NEUTRAL energizers: NO sequence words (no next/first/last/finally/go).
// Every q/r clip must be reusable in ANY slot -- q1 of a short OR q7 of the full
// round -- so the opener must never imply order. Varied but deterministic per id
// (same clip regardless of the cut it lands in). Count/position is shown only by
// the on-screen "QUESTION X OF Y" pill.
const ENERGIZERS = ["Okay", "Alright", "Here's one", "Check this out"];

function qBeat(q) {
  const tp = TYPE_PHRASE[q.tier.toUpperCase()] ?? "";
  const e = ENERGIZERS[(q.id - 1) % ENERGIZERS.length];
  const opener = tp ? `${e}, ${tp}!` : `${e}!`;
  return `[excited] ${opener} ${questionStem(q)} ${optionsListOr(q)} Five seconds!`;
}

function rBeat(q) {
  const lead = q.id % 2 === 1 ? "The answer is..." : "It's...";
  return `[excited] ${lead} ${q.ansLetter}, ${answerSpeak(q)}! ${spellNums(q.explanation)}`;
}

/** { q1..q15, r1..r15 } spoken scripts for a round. */
export function roundScripts(round) {
  const out = {};
  for (const q of round.questions) {
    out[`q${q.id}`] = qBeat(q).replace(/\s+/g, " ").trim();
    out[`r${q.id}`] = rBeat(q).replace(/\s+/g, " ").trim();
  }
  return out;
}

/** Ordered [{beat,text}] for the 30 q/r beats (TTS input). */
export function roundBeats(round) {
  const s = roundScripts(round);
  const beats = [];
  for (let i = 1; i <= round.questions.length; i++) beats.push({ beat: `q${i}`, text: s[`q${i}`] });
  for (let i = 1; i <= round.questions.length; i++) beats.push({ beat: `r${i}`, text: s[`r${i}`] });
  return beats;
}

// ---- CLI -------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node gen-narration-scripts.mjs <round.json> [out.json]"); process.exit(2); }
  const round = JSON.parse(fs.readFileSync(file, "utf8"));
  const beats = roundBeats(round);
  const out = process.argv[3];
  if (out) { fs.writeFileSync(out, JSON.stringify(beats, null, 2)); console.log(`wrote ${beats.length} beats -> ${out}`); }
  else for (const b of beats) console.log(`${b.beat}: ${b.text}`);
}
