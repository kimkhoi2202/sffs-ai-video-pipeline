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
import { readJSON, writeJSONAtomic, type HermesQ } from "./state.ts";
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
  round?: number;
  slug?: string;
  id?: number;
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
    return { sig: e.sig, hash: e.hash, kind: "text", category: e.category, tier: e.tier, prompt, options, answer };
  }

  if (e.kind === "numseries") {
    const payload = e.payloadNorm ?? "";
    const seq = payload.split("~").map((n) => n.trim()).filter(Boolean);
    if (seq.length < LIMITS.minSeq || seq.length > LIMITS.maxSeq) return null;
    if (seq.some((n) => n.length > 8)) return null;
    const prompt = (e.promptNorm || "what comes next?").trim();
    if (prompt.length > LIMITS.maxPrompt) return null;
    if (answer.length > 8) return null;
    return { sig: e.sig, hash: e.hash, kind: "numseries", category: e.category, tier: e.tier, prompt, seq, answer };
  }

  return null; // shaded/polygon/dot need shape components — not headless-safe here
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
  kinds?: Array<"text" | "numseries">;
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
