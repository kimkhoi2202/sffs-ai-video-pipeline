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
  exclude?: Set<string>; // additional sigs to skip (in-batch claims)
}

/** Return validated, fresh (never-used) candidate questions in a stable order. */
export function candidateQuestions(filter: CandidateFilter = {}): HermesQ[] {
  const used = loadUsedSigs();
  const extra = filter.exclude ?? new Set<string>();
  const kinds = filter.kinds ?? ["text", "numseries"];
  const pool: HermesQ[] = [];
  for (const e of loadBank()) {
    if (!kinds.includes(e.kind as any)) continue;
    if (filter.category && filter.category !== "mixed" && e.category !== filter.category) continue;
    if (used.has(e.sig) || extra.has(e.sig)) continue;
    const q = toHermesQ(e);
    if (q) pool.push(q);
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
