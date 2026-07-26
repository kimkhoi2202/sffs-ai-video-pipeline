/**
 * questions.ts — pull FRESH, never-before-used questions from the master bank,
 * structurally validate them, and (idempotently) mark them used so a question is
 * NEVER repeated across the whole campaign.
 *
 * Dedup universe = content/ab-test-usage.json (the pipeline's consumed-questions
 * ledger) UNION DATA_DIR/hermes-used-sigs.json (this loop's own ledger). We only
 * cover the two headless-safe kinds the self-contained composition can render:
 * "text" (verbal odd-one-out / analogy) and "numseries" (number series).
 *
 * Length guards here PREVENT on-screen overflow BY CONSTRUCTION (reject anything
 * that would clip), which is far more reliable than pixel-diffing a render.
 */
import { readJSON, writeJSONAtomic, isShapeKind, type HermesQ, type Figure, type ShapeKind } from "./state.ts";
import { parseLegacyFigure } from "./legacyShapes.ts";
import { CONFIG } from "./config.ts";
import { info } from "./log.ts";

interface BankEntry {
  sig: string;
  hash: string;
  kind: string;
  category: string;
  tier: string;
  promptNorm?: string;
  payloadNorm?: string;
  answerNorm?: string;
  /** AUTHORED explanation, added by content/backfill-explanations.mjs. Preferred by
   *  render.ts over the per-kind template legacyShapes.ts synthesizes, which emits one
   *  identical sentence for every question of a kind. */
  explanation?: string;
  round?: number;
  slug?: string;
  id?: number;
  /** Render-ready payload for the nonverbal shape/figure kinds (fold + matrix
   *  family). Absent for text/numseries. */
  figure?: Figure;
}

export const LIMITS = {
  maxPrompt: 92,
  maxOption: 24,
  maxOptions: 4,
  minOptions: 3,
  maxSeq: 6,
  minSeq: 3,
} as const;

let bankCache: BankEntry[] | null = null;
export function loadBank(): BankEntry[] {
  if (bankCache) return bankCache;
  const raw = readJSON<{ entries?: BankEntry[] }>(CONFIG.BANK, {});
  bankCache = Array.isArray(raw.entries) ? raw.entries : [];
  return bankCache;
}

export function loadUsedSigs(): Set<string> {
  const used = new Set<string>();
  const usage = readJSON<{ videos?: Array<{ questions?: Array<{ sig?: string }> }> }>(CONFIG.USAGE, {});
  for (const v of usage.videos ?? []) for (const q of v.questions ?? []) if (q.sig) used.add(q.sig);
  const hermes = readJSON<{ sigs?: string[] }>(CONFIG.HERMES_USED, {});
  for (const s of hermes.sigs ?? []) used.add(s);
  return used;
}

const norm = (s: string) => s.trim().toLowerCase();

// ── Fuzzy near-duplicate signature (computed at LOAD-TIME; NEVER persisted) ───
// A SECOND, conservative dedup key that catches what the exact `sig` is blind to:
// paraphrases, reordered options, and structurally-identical number series
// (e.g. "5 10 15 20 -> ?" vs "10 20 30 40 -> ?"). It is deliberately narrow: it
// only collides on genuine structural identity so it excludes real near-dups
// WITHOUT over-rejecting genuinely different questions. Computed on the in-memory
// HermesQ only — it is never written into the bank file or config.

// A number series is only folded into a scale-invariant "shape" when it has at
// least this many terms; anything shorter falls back to a literal key so we never
// collapse too aggressively. (LIMITS.minSeq already guarantees >= 3, so this is a
// belt-and-suspenders floor rather than a real gate — the one conservatism knob.)
const MIN_SERIES_TERMS_FOR_PATTERN = 3;

/** Aggressive text normalizer for fuzzy matching: fold case, punctuation, and
 * runs of whitespace so "New-York!", "new  york", and "New York" all collapse. */
const fuzzyNorm = (s: string): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function gcd2(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Scale-invariant "step pattern" of a numeric series, or null if it isn't a
 * clean integer series. We hash the first-differences reduced by their GCD, so
 * proportional series ("5 10 15 20" -> steps 5,5,5 ; "10 20 30 40" -> 10,10,10)
 * both reduce to "1,1,1" and collide, while a different shape (arithmetic vs
 * geometric, different ratio, different length) stays distinct. Non-integer or
 * unparseable series return null and fall back to a literal key (never more
 * aggressive than exact). */
function numericStepPattern(terms: string[]): string | null {
  if (terms.length < MIN_SERIES_TERMS_FOR_PATTERN) return null;
  const nums: number[] = [];
  for (const t of terms) {
    const n = Number(String(t).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null; // non-integer -> literal fallback
    nums.push(n);
  }
  const diffs: number[] = [];
  for (let i = 1; i < nums.length; i++) diffs.push(nums[i] - nums[i - 1]);
  const g = diffs.reduce((acc, d) => gcd2(acc, d), 0);
  const shape = g === 0 ? diffs.map(() => 0) : diffs.map((d) => d / g);
  return shape.join(",");
}

/** Canonical fuzzy signature for a validated question (computed in-memory only).
 * Two questions with the SAME fuzzy sig are treated as near-duplicates. */
export function fuzzySig(q: HermesQ): string {
  if (q.kind === "numseries") {
    const seq = q.seq ?? [];
    const pat = numericStepPattern(seq);
    // Key on the scale-invariant step pattern (+ term count) so the literal
    // numbers don't matter; fall back to the normalized literal series otherwise.
    return pat !== null ? `n|${seq.length}|${pat}` : `n|lit|${seq.map(fuzzyNorm).join("~")}`;
  }
  if (isShapeKind(q.kind)) {
    // Shape/figure questions are AUTHORED distinct and already guaranteed unique
    // by their exact `sig`. The text/number fuzzy keys below ignore the figure
    // and would WRONGLY collapse different figures that share an answer LABEL
    // (e.g. two folds both "2 holes"). Key on kind+sig so shapes are deduped by
    // exact sig only and never dropped as false near-duplicates.
    return `${q.kind}|${q.sig}`;
  }
  // text (verbal odd-one-out / analogy): key on the *set* of normalized options
  // plus the normalized answer, IGNORING prompt wording — so paraphrases and
  // reordered options collide, while a different option set / answer does not.
  const opts = (q.options ?? []).map(fuzzyNorm).filter(Boolean).sort();
  return `t|${fuzzyNorm(q.answer)}|${opts.join("~")}`;
}

/** Fuzzy sigs of every already-used question we can still resolve from the bank
 * (used exact-sig -> bank entry -> fuzzySig). Used questions no longer present in
 * the bank aren't covered here — the exact-sig ledger still guards those. */
export function loadUsedFuzzySigs(): Set<string> {
  const used = loadUsedSigs();
  const out = new Set<string>();
  if (used.size === 0) return out;
  for (const e of loadBank()) {
    if (!used.has(e.sig)) continue;
    const q = toHermesQ(e);
    if (q) out.add(fuzzySig(q));
  }
  return out;
}

/** Turn a bank entry into a validated HermesQ, or null if unusable/would overflow. */
export function toHermesQ(e: BankEntry): HermesQ | null {
  if (!e || !e.sig || !e.answerNorm) return null;
  const answer = String(e.answerNorm).trim();
  if (!answer) return null;
  const explanation = String(e.explanation ?? "").trim() || undefined;

  if (e.kind === "text") {
    const payload = e.payloadNorm ?? "";
    const parts = payload.split(" || ");
    if (parts.length < 2) return null;
    const prompt = (parts[0] || e.promptNorm || "").trim();
    const options = parts[1].split("~").map((o) => o.trim()).filter(Boolean);
    if (!prompt || prompt.length > LIMITS.maxPrompt) return null;
    if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) return null;
    if (options.some((o) => o.length > LIMITS.maxOption)) return null;
    // exactly one option must match the answer (structural single-answer check)
    const matches = options.filter((o) => norm(o) === norm(answer));
    if (matches.length !== 1) return null;
    return { sig: e.sig, hash: e.hash, kind: "text", category: e.category, tier: e.tier, prompt, options, answer, explanation };
  }

  if (e.kind === "numseries") {
    const payload = e.payloadNorm ?? "";
    const seq = payload.split("~").map((n) => n.trim()).filter(Boolean);
    if (seq.length < LIMITS.minSeq || seq.length > LIMITS.maxSeq) return null;
    if (seq.some((n) => n.length > 8)) return null;
    const prompt = (e.promptNorm || "what comes next?").trim();
    if (prompt.length > LIMITS.maxPrompt) return null;
    if (answer.length > 8) return null;
    return { sig: e.sig, hash: e.hash, kind: "numseries", category: e.category, tier: e.tier, prompt, seq, answer, explanation };
  }

  // Nonverbal SHAPE/FIGURE kinds — reconstruct the render-ready `figure`, then run
  // the shared structural guard. The FigState family (fold + matrix/analogy2/
  // figure-odd) carries `figure` in the bank; the LEGACY classic kinds (dot/
  // shaded/polygon) are compact codes with no options, so the converter synthesizes
  // their figure + deterministic A-D distractors from payloadNorm.
  if (isShapeKind(e.kind)) {
    const fig = e.figure ?? parseLegacyFigure(e);
    if (!fig || typeof fig !== "object") return null;
    const prompt = String(fig.prompt || e.promptNorm || "").trim();
    if (!prompt || prompt.length > LIMITS.maxPrompt) return null;
    const q: HermesQ = {
      sig: e.sig,
      hash: e.hash,
      kind: e.kind,
      category: e.category,
      tier: e.tier,
      prompt,
      answer, // normalized answer label (== figure.ansLabel, normalized)
      explanation,
      figure: fig,
    };
    if (shapeStructuralIssue(q)) return null; // malformed figure -> unusable
    return q;
  }

  // dot / shaded / polygon are UNLOCKED above: isShapeKind() now covers them and
  // legacyShapes.parseLegacyFigure() synthesizes their figure + deterministic A-D
  // options from the compact payloadNorm. Any other/unknown kind stays unusable.
  return null;
}

/**
 * Structural validity of a TEXT / NUMSERIES question. Returns null when well-formed,
 * else a short human reason. NEVER throws, so it is safe on raw bank data.
 *
 * This is the deterministic counterpart to shapeStructuralIssue: it re-asserts the
 * same invariants toHermesQ enforces at bank-load time — non-empty prompt within the
 * on-screen length budget, an option/term count the composition can lay out, and
 * (for text) EXACTLY ONE option matching the stated answer, which is the structural
 * form of the rubric's "exactly one unambiguous correct answer".
 *
 * It is NOT a replacement for the LLM rubric (it cannot judge factual correctness or
 * grade-appropriateness). gates.validateQuestions uses it only as the fail-safe when
 * the judge is unreachable, and deliberately does not cache its verdicts, so the real
 * rubric still runs on those questions on the next healthy cycle.
 */
export function textStructuralIssue(q: HermesQ): string | null {
  if (isShapeKind(q.kind)) return "not a text/numseries kind";
  const prompt = String(q.prompt ?? "").trim();
  if (!prompt) return "missing prompt";
  if (prompt.length > LIMITS.maxPrompt) return `prompt ${prompt.length} chars > ${LIMITS.maxPrompt}`;
  const answer = String(q.answer ?? "").trim();
  if (!answer) return "missing answer";

  if (q.kind === "text") {
    const options = (q.options ?? []).map((o) => String(o ?? "").trim()).filter(Boolean);
    if (options.length < LIMITS.minOptions || options.length > LIMITS.maxOptions) {
      return `needs ${LIMITS.minOptions}-${LIMITS.maxOptions} options, got ${options.length}`;
    }
    const tooLong = options.find((o) => o.length > LIMITS.maxOption);
    if (tooLong) return `option "${tooLong}" > ${LIMITS.maxOption} chars`;
    if (new Set(options.map(norm)).size !== options.length) return "duplicate option(s)";
    const matches = options.filter((o) => norm(o) === norm(answer));
    if (matches.length !== 1) return `answer matches ${matches.length} option(s), need exactly 1`;
    return null;
  }

  if (q.kind === "numseries") {
    const seq = (q.seq ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
    if (seq.length < LIMITS.minSeq || seq.length > LIMITS.maxSeq) {
      return `needs ${LIMITS.minSeq}-${LIMITS.maxSeq} terms, got ${seq.length}`;
    }
    if (seq.some((n) => n.length > 8)) return "a term is > 8 chars";
    if (answer.length > 8) return "answer is > 8 chars";
    return null;
  }

  return `unsupported kind "${q.kind}"`;
}

/**
 * Structural validity of a nonverbal shape/figure question's `figure` payload.
 * Returns null when well-formed, else a short human reason. NEVER throws — every
 * access is guarded — so it is safe to call on raw bank data. Shared by toHermesQ
 * (drop malformed entries) and gates.validateQuestions (the shape rubric).
 */
export function shapeStructuralIssue(q: HermesQ): string | null {
  if (!isShapeKind(q.kind)) return "not a shape kind";
  const f = q.figure;
  if (!f || typeof f !== "object") return "missing figure payload";
  if (f.kind !== q.kind) return `figure.kind "${f.kind}" != "${q.kind}"`;
  const opts = Array.isArray(f.options) ? f.options : [];
  if (opts.length < LIMITS.minOptions || opts.length > LIMITS.maxOptions) {
    return `needs ${LIMITS.minOptions}-${LIMITS.maxOptions} options, got ${opts.length}`;
  }
  if (opts.some((o) => !o || typeof o.letter !== "string" || !o.letter)) return "an option is missing its letter";
  const ansMatches = opts.filter((o) => o.letter === f.ansLetter);
  if (ansMatches.length !== 1) return `ansLetter "${f.ansLetter}" matches ${ansMatches.length} option(s)`;
  if (!f.ansLabel || !String(f.ansLabel).trim()) return "missing ansLabel";
  const isCell = (x: unknown): boolean => !!x && Number.isFinite((x as any).r) && Number.isFinite((x as any).c);
  const isFig = (x: unknown): boolean => !!x && typeof x === "object" && typeof (x as any).shape === "string" && !!(x as any).shape;
  if (q.kind === "fold") {
    const DIRS = new Set(["left", "right", "up", "down"]);
    const folds = Array.isArray(f.folds) ? f.folds : [];
    const punches = Array.isArray(f.punches) ? f.punches : [];
    if (folds.length < 1 || !folds.every((d) => DIRS.has(d))) return "fold needs >=1 valid fold direction";
    if (punches.length < 1 || !punches.every(isCell)) return "fold needs >=1 valid punch cell";
    const grid = f.grid ?? 4;
    if (!Number.isInteger(grid) || grid < 2 || grid % 2 !== 0) return `fold grid ${grid} must be an even int >= 2`;
    if (!opts.every((o) => Array.isArray(o.holes) && o.holes.every(isCell))) return "a fold option is missing hole cells";
    return null;
  }
  // legacy classic-nonverbal kinds (dot / shaded / polygon): validate the
  // synthesized stimulus + typed options against the mirrored render enums.
  if (q.kind === "dot") {
    const RING = new Set(["tl", "tm", "tr", "rm", "br", "bm", "bl", "lm"]);
    if (!Array.isArray(f.dotSeq) || f.dotSeq.length < 2 || !f.dotSeq.every((p) => RING.has(p))) return "dot needs a valid position sequence";
    if (!opts.every((o) => typeof o.pos === "string" && RING.has(o.pos))) return "a dot option is missing a valid position";
    return null;
  }
  if (q.kind === "polygon") {
    const side = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 3 && (n as number) <= 8;
    if (!Array.isArray(f.polySeq) || f.polySeq.length < 2 || !f.polySeq.every(side)) return "polygon needs a valid side-count sequence";
    if (!opts.every((o) => side(o.poly))) return "a polygon option is missing a valid side count";
    return null;
  }
  if (q.kind === "shaded") {
    const GL = new Set(["circle", "square", "triangle", "diamond", "star", "heart", "cross", "arrow", "crescent", "lightning", "teardrop"]);
    if (!f.leftShape || !GL.has(f.leftShape) || !f.rightShape || !GL.has(f.rightShape)) return "shaded needs valid left/right shapes";
    if (!opts.every((o) => typeof o.shape === "string" && GL.has(o.shape) && typeof o.filled === "boolean")) return "a shaded option is malformed";
    return null;
  }
  // matrix / analogy2 / figure-odd: every option is a figure
  if (!opts.every((o) => isFig(o.fig))) return "a figure option is missing a valid fig";
  if (q.kind === "matrix" && !(Array.isArray(f.cells) && f.cells.length === 3 && f.cells.every(isFig))) {
    return "matrix needs exactly 3 valid cells";
  }
  if (q.kind === "analogy2" && !([f.a, f.b, f.c].every(isFig))) return "analogy2 needs valid a/b/c figures";
  return null;
}

/** Deterministic shuffle (seeded) so resuming a run reselects the same pool. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface CandidateFilter {
  category?: string; // "verbal" | "quantitative" | "nonverbal" | "mixed"/undefined
  kinds?: Array<"text" | "numseries" | ShapeKind>;
  seed?: string; // for deterministic ordering
  exclude?: Set<string>; // additional exact sigs to skip (in-batch claims)
  excludeFuzzy?: Set<string>; // additional fuzzy sigs to skip (near-dup claims)
}

/** Return validated, fresh (never-used) candidate questions in a stable order. */
export function candidateQuestions(filter: CandidateFilter = {}): HermesQ[] {
  const used = loadUsedSigs();
  const extra = filter.exclude ?? new Set<string>();
  const kinds = filter.kinds ?? ["text", "numseries"];
  // SECOND dedup key (additive; exact-sig behavior below is unchanged): skip any
  // candidate that is a near-duplicate of an already-used question, of a caller-
  // supplied fuzzy claim, or of an earlier candidate already kept in this pool.
  const usedFuzzy = loadUsedFuzzySigs();
  const extraFuzzy = filter.excludeFuzzy ?? new Set<string>();
  const seenFuzzy = new Set<string>();
  const pool: HermesQ[] = [];
  for (const e of loadBank()) {
    if (!kinds.includes(e.kind as any)) continue;
    if (filter.category && filter.category !== "mixed" && e.category !== filter.category) continue;
    if (used.has(e.sig) || extra.has(e.sig)) continue;
    const q = toHermesQ(e);
    if (!q) continue;
    const f = fuzzySig(q);
    if (usedFuzzy.has(f) || extraFuzzy.has(f) || seenFuzzy.has(f)) continue; // near-duplicate
    seenFuzzy.add(f);
    pool.push(q);
  }
  return seededShuffle(pool, hashSeed(filter.seed ?? "hermes"));
}

/** Idempotently mark questions used in BOTH ledgers (never repeat a question). */
export function markUsed(videoSlug: string, dimension: string, arm: string, questions: HermesQ[]): void {
  // 1) content/ab-test-usage.json (pipeline ledger)
  const usage = readJSON<{ note?: string; videos?: any[] }>(CONFIG.USAGE, { videos: [] });
  usage.videos = usage.videos ?? [];
  if (!usage.videos.some((v) => v.videoSlug === videoSlug)) {
    usage.videos.push({
      videoSlug,
      test: dimension,
      variant: arm,
      round: "hermes",
      generatedBy: "hermes-loop",
      questions: questions.map((q) => ({ hash: q.hash, sig: q.sig, tier: q.tier, answerNorm: q.answer })),
    });
    writeJSONAtomic(CONFIG.USAGE, usage);
  }
  // 2) hermes-used-sigs.json (loop ledger — the strong dedup guarantee)
  const hermes = readJSON<{ sigs?: string[]; updated?: string }>(CONFIG.HERMES_USED, { sigs: [] });
  const set = new Set(hermes.sigs ?? []);
  let added = 0;
  for (const q of questions) if (!set.has(q.sig)) (set.add(q.sig), added++);
  hermes.sigs = [...set];
  hermes.updated = new Date().toISOString();
  writeJSONAtomic(CONFIG.HERMES_USED, hermes);
  info("questions marked used", { videoSlug, added, total: set.size });
}

export function bankStats(): { total: number; usable: number; fresh: number; used: number } {
  const used = loadUsedSigs();
  let usable = 0;
  let fresh = 0;
  for (const e of loadBank()) {
    const q = toHermesQ(e);
    if (!q) continue;
    usable++;
    if (!used.has(e.sig)) fresh++;
  }
  return { total: loadBank().length, usable, fresh, used: used.size };
}
