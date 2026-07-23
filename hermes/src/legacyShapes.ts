/**
 * legacyShapes.ts — unlock the LEGACY nonverbal bank (dot / shaded / polygon).
 *
 * These ~300 bank entries are compact HermesQuiz-era codes with NO render payload
 * and NO A-D options:
 *   dot     payloadNorm "bl~tl~tr=>br"            (a dot stepping around a square)
 *   polygon payloadNorm "6~5~4=>3"               (a side-count series)
 *   shaded  payloadNorm "circle>triangle=>triangle:true"  (empty->filled analogy)
 *
 * This module is the CONVERTER + DETERMINISTIC DISTRACTOR GENERATOR the exclusion
 * note in questions.ts asked for: it parses each code into a structured, render-
 * ready `Figure` (the SAME payload shape fold/matrix carry, so it flows through
 * render.ts mapShapeQuestion unchanged) and synthesizes SENSIBLE, deterministic
 * A-D options (one correct + three plausible distractors). Deterministic == seeded
 * by the entry's stable `sig`, so a resumed run + the fuzzy `${kind}|${sig}` dedup
 * key both reselect/collapse identically.
 *
 * Dependency-free (node builtins only) + React-free — it mirrors the remotion
 * enums (DotPos ring, PolyShape 3-8, GlyphKind) WITHOUT importing remotion, so
 * questions.ts (imported everywhere) stays light. Every parser is fully guarded
 * and returns null on any malformed/out-of-range code (a validity guard), so a bad
 * entry is simply dropped from the candidate pool rather than rendered wrong.
 */
import type { Figure, FigureOption } from "./state.ts";

// --- Mirrored remotion enums (kept in sync with remotion/src/components/*) -----
/** The 8 perimeter dot positions, clockwise (DotSquare DOT_RING; center excluded
 *  from the legacy bank). */
const DOT_RING = ["tl", "tm", "tr", "rm", "br", "bm", "bl", "lm"] as const;
const DOT_SET = new Set<string>(DOT_RING);
const POS_LABEL: Record<string, string> = {
  tl: "TOP-LEFT", tm: "TOP", tr: "TOP-RIGHT", rm: "RIGHT",
  br: "BOTTOM-RIGHT", bm: "BOTTOM", bl: "BOTTOM-LEFT", lm: "LEFT", center: "CENTER",
};
/** Polygon side counts the renderer supports (Polygon.tsx POLY_ROT: 3..8). */
const POLY_MIN = 3;
const POLY_MAX = 8;
const POLY_NAME: Record<number, string> = {
  3: "TRIANGLE", 4: "SQUARE", 5: "PENTAGON", 6: "HEXAGON", 7: "HEPTAGON", 8: "OCTAGON",
};
/** The 11 figure glyphs (ShapeGlyph GLYPH_KINDS). */
const GLYPH_KINDS = [
  "circle", "square", "triangle", "diamond", "star", "heart",
  "cross", "arrow", "crescent", "lightning", "teardrop",
] as const;
const GLYPH_SET = new Set<string>(GLYPH_KINDS);

const LETTERS = ["A", "B", "C", "D"] as const;

// --- deterministic RNG (LCG; identical style to questions.ts) ------------------
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Assemble 4 options from the correct one + distractors, assign A-D in a seeded
 *  order, and return {options, ansLetter}. Pads defensively (should not fire once
 *  the parser guards ran). */
function assignLetters(
  correct: Omit<FigureOption, "letter">,
  distractors: Array<Omit<FigureOption, "letter">>,
  rng: () => number,
): { options: FigureOption[]; ansLetter: string } | null {
  const all = shuffle([correct, ...distractors.slice(0, 3)], rng);
  if (all.length !== 4) return null;
  let ansLetter = "";
  const options = all.map((o, i) => {
    const letter = LETTERS[i];
    if (o === correct) ansLetter = letter;
    return { letter, ...o } as FigureOption;
  });
  return ansLetter ? { options, ansLetter } : null;
}

// --- parsers ------------------------------------------------------------------
interface LegacyEntry {
  sig: string;
  kind: string;
  tier?: string;
  category?: string;
  promptNorm?: string;
  payloadNorm?: string;
  answerNorm?: string;
}

/** Constant clockwise ring-step of a dot path, or null if not constant. */
function dotStep(seq: string[], ans: string): number | null {
  const path = [...seq, ans].map((p) => DOT_RING.indexOf(p as any));
  if (path.some((i) => i < 0)) return null;
  const steps: number[] = [];
  for (let i = 1; i < path.length; i++) steps.push(((path[i] - path[i - 1]) % 8 + 8) % 8);
  return steps.every((s) => s === steps[0]) ? steps[0] : null;
}

function parseDot(e: LegacyEntry, rng: () => number): Figure | null {
  const m = /^(.*)=>(.*)$/.exec(e.payloadNorm ?? "");
  if (!m) return null;
  const seq = m[1].split("~").map((s) => s.trim()).filter(Boolean);
  const ans = m[2].trim();
  if (seq.length < 2 || seq.length > 6) return null;
  if (!seq.every((p) => DOT_SET.has(p)) || !DOT_SET.has(ans)) return null;

  // Distractors: prefer the "didn't move" (last shown) + the two ring-neighbours
  // of the answer, then fill with other seeded ring positions. All != ans, distinct.
  const cand: string[] = [];
  const push = (p: string) => { if (p !== ans && DOT_SET.has(p) && !cand.includes(p)) cand.push(p); };
  push(seq[seq.length - 1]);
  const ai = DOT_RING.indexOf(ans as any);
  push(DOT_RING[(ai + 1) % 8]);
  push(DOT_RING[(ai + 7) % 8]);
  for (const p of shuffle([...DOT_RING], rng)) push(p);
  const distractors = cand.slice(0, 3).map((pos) => ({ pos }));
  if (distractors.length < 3) return null;

  const asg = assignLetters({ pos: ans }, distractors, rng);
  if (!asg) return null;
  const step = dotStep(seq, ans);
  const explanation =
    step !== null && step > 0
      ? `the dot moves ${step === 1 ? "one spot" : step === 7 ? "one spot counter-clockwise" : `${step} spots`} clockwise each time`
      : "follow the dot's path around the square";
  return {
    kind: "dot",
    tier: e.tier || "POSITION",
    category: e.category || "nonverbal",
    countdown: 6,
    prompt: "WHERE DOES THE DOT MOVE NEXT?",
    ansLetter: asg.ansLetter,
    ansLabel: POS_LABEL[ans] ?? ans.toUpperCase(),
    explanation,
    options: asg.options,
    dotSeq: seq,
  };
}

function parsePolygon(e: LegacyEntry, rng: () => number): Figure | null {
  const m = /^(.*)=>(.*)$/.exec(e.payloadNorm ?? "");
  if (!m) return null;
  const seq = m[1].split("~").map((s) => Number(s.trim()));
  const ans = Number(m[2].trim());
  if (seq.length < 2 || seq.length > 6) return null;
  const inRange = (n: number) => Number.isInteger(n) && n >= POLY_MIN && n <= POLY_MAX;
  if (!seq.every(inRange) || !inRange(ans)) return null;

  // Distractors: nearest side-counts (ans +/-1, +/-2) then any other in-range,
  // seeded, distinct, != ans.
  const cand: number[] = [];
  const push = (n: number) => { if (n !== ans && inRange(n) && !cand.includes(n)) cand.push(n); };
  [ans - 1, ans + 1, ans - 2, ans + 2].forEach(push);
  for (const n of shuffle([3, 4, 5, 6, 7, 8], rng)) push(n);
  const distractors = cand.slice(0, 3).map((poly) => ({ poly }));
  if (distractors.length < 3) return null;

  const asg = assignLetters({ poly: ans }, distractors, rng);
  if (!asg) return null;
  // Honest step explanation when the side-count changes by a constant amount.
  const nums = [...seq, ans];
  const diffs: number[] = [];
  for (let i = 1; i < nums.length; i++) diffs.push(nums[i] - nums[i - 1]);
  const constStep = diffs.every((d) => d === diffs[0]) ? diffs[0] : null;
  const explanation =
    constStep === -1 ? "each shape loses a side"
      : constStep === 1 ? "each shape gains a side"
      : constStep !== null && constStep < 0 ? `each shape loses ${-constStep} sides`
      : constStep !== null && constStep > 0 ? `each shape gains ${constStep} sides`
      : "spot the pattern in the number of sides";
  return {
    kind: "polygon",
    tier: e.tier || "FIGURE SERIES",
    category: e.category || "nonverbal",
    countdown: 6,
    prompt: "WHICH SHAPE COMES NEXT?",
    ansLetter: asg.ansLetter,
    ansLabel: POLY_NAME[ans] ?? `${ans} SIDES`,
    explanation,
    options: asg.options,
    polySeq: seq,
  };
}

function parseShaded(e: LegacyEntry, rng: () => number): Figure | null {
  // left>right=>ansShape:filled  (bank is uniformly ans==right, filled==true).
  const m = /^(.+)>(.+)=>(.+):(.+)$/.exec(e.payloadNorm ?? "");
  if (!m) return null;
  const left = m[1].trim();
  const right = m[2].trim();
  const ansShape = m[3].trim();
  const filled = m[4].trim().toLowerCase() === "true";
  if (!GLYPH_SET.has(left) || !GLYPH_SET.has(right) || !GLYPH_SET.has(ansShape)) return null;
  // The render is the empty->filled analogy (L:empty::L:filled = R:empty:?), so a
  // usable shaded entry must answer with the RIGHT shape, filled. Anything else is
  // not representable by ShadedQuestion -> drop it (validity guard).
  if (ansShape !== right || !filled) return null;

  const correct = { shape: right, filled: true };
  const distractors: Array<{ shape: string; filled: boolean }> = [];
  const seen = new Set([`${right}|true`]);
  const add = (shape: string, f: boolean) => {
    const k = `${shape}|${f}`;
    if (GLYPH_SET.has(shape) && !seen.has(k)) { seen.add(k); distractors.push({ shape, filled: f }); }
  };
  add(right, false);       // the "forgot to fill" distractor (strong)
  add(left, true);         // filled, but the WRONG (left) shape
  for (const g of shuffle([...GLYPH_KINDS], rng)) { add(g, true); add(g, false); }
  if (distractors.length < 3) return null;

  const asg = assignLetters(correct, distractors.slice(0, 3), rng);
  if (!asg) return null;
  return {
    kind: "shaded",
    tier: e.tier || "FIGURE ANALOGY",
    category: e.category || "nonverbal",
    countdown: 6,
    prompt: "WHICH SHAPE COMPLETES THE PATTERN?",
    ansLetter: asg.ansLetter,
    ansLabel: `FILLED ${right.toUpperCase()}`,
    explanation: "each shape gets filled in",
    options: asg.options,
    leftShape: left,
    rightShape: right,
  };
}

/**
 * Convert a LEGACY dot/shaded/polygon bank entry into a render-ready `Figure`
 * (with generated A-D options), or null if the code is malformed / out of range.
 * Deterministic: options are seeded by the entry's stable `sig`.
 */
export function parseLegacyFigure(e: LegacyEntry): Figure | null {
  if (!e || !e.payloadNorm || !e.sig) return null;
  const rng = mkRng(hashSeed(`legacy|${e.kind}|${e.sig}`));
  if (e.kind === "dot") return parseDot(e, rng);
  if (e.kind === "polygon") return parsePolygon(e, rng);
  if (e.kind === "shaded") return parseShaded(e, rng);
  return null;
}

/** The legacy kinds this converter unlocks. */
export const LEGACY_SHAPE_KINDS = ["dot", "shaded", "polygon"] as const;
