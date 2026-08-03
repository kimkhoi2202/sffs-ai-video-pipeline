/**
 * generate.ts — refill the question bank when it runs low, in the shape that retains.
 *
 * WHY THIS EXISTS. The bank is a fixed resource being consumed daily and the runway is
 * shorter than it looks. `bankStats()` reports 1,200 fresh entries, but the pool the
 * designer can actually DRAW is 660: every number series is removed by the fuzzy
 * near-duplicate guard (263 of them collapse to ~20 distinct step patterns, all
 * published), and the figure kinds are outside the pinned format's kind filter. At 36
 * questions a day that is eighteen days; at the 72 a day that per-platform TikTok
 * content costs, it is nine. Rationing the bank was the alternative and it is worse:
 * fewer videos to preserve a stock we never use is a stock we wasted.
 *
 * WHAT IT GENERATES, and why not just "more questions". Two properties, together:
 *
 *   HARD. The bank has no hard content and this is structural rather than accidental —
 *   `content/schema/round.schema.json` requires `"grade": {"const": 5}` and
 *   `"cogatLevel": {"const": 11}`, so all 1,544 entries were authored to one level by
 *   design. The judge agrees: of the 41 bank items it has rated, 37 came back "easy"
 *   and 4 "medium", none hard. So "draw from the hard end of the bank" is not a thing
 *   that can be done, and difficulty has to be manufactured.
 *
 *   SHORT. Prompt length is the one property of the opening question that measurably
 *   tracks the 3-second skip rate (leadPolicy.ts): <=5 words medians 64.3% skip against
 *   71.7% for >=10, and skip rate is what predicts reach on this account. Difficult
 *   questions are usually LONGER ones, so generating for difficulty alone would buy
 *   interest and pay for it in retention — and we would lose the audience before it
 *   got to be intrigued. The target is difficulty up, reading load flat.
 *
 * The shape to aim at, which is neither of those things by accident:
 *
 *     WHICH DOES NOT BELONG?   2   3   5   9
 *
 * Four words. Every option is one character. And 9 is the only composite, which is
 * genuinely not obvious at a glance. That is grade-12 reasoning at grade-1 reading load.
 *
 * NOTHING SKIPS THE QUEUE. A generated question goes through the SAME structural check,
 * the SAME exact-sig and fuzzy near-duplicate guards and the SAME LLM validity rubric as
 * an authored one, before it is written to the bank — and then again, from scratch, when
 * a video tries to use it. The judge is the same gate that rejected 8 of 16 videos on
 * 2026-08-01, so it is not a formality.
 */
import { readJSON, writeJSONAtomic, type HermesQ } from "./state.ts";
import { CONFIG } from "./config.ts";
import { info, warn, decision } from "./log.ts";
import { chatJSON } from "./llm.ts";
import { candidateQuestions, toHermesQ, textStructuralIssue, fuzzySig, loadBank, LIMITS } from "./questions.ts";
import { validateQuestions } from "./gates.ts";
import { promptWords } from "./leadPolicy.ts";

/**
 * The grade level an item was written for. THE NEW FIELD, and deliberately not called
 * anything near `tier`.
 *
 * `tier` in this bank holds the question TYPE ("ODD ONE OUT", "VERBAL ANALOGY"), which
 * reads like a difficulty and is not one — that collision cost a whole design pass, so
 * this one is named for exactly what it is and is an integer rather than a label.
 *
 * It is a genuine VARIABLE from the first write: ops/backfill_grade_level.mjs stamps
 * every existing entry with 5, which is not a guess but what round.schema.json already
 * asserts, and generated hard items carry 12. A field that is the same on every row
 * cannot be measured against anything, which is the trap the schema's own `grade`
 * constant fell into.
 */
export const GRADE_AUTHORED = 5;
export const GRADE_HARD = 12;

/** Prompt words a generated item may use. The whole point is that hard stays short. */
export const MAX_GEN_PROMPT_WORDS = 6;

/**
 * Top up when the drawable pool would not survive this many more days at the current
 * burn. Runway rather than a schedule: generating questions nobody needs burns tokens,
 * and generating them the day they run out is too late for a gate that rejects some.
 */
export const TOPUP_RUNWAY_DAYS = 6;

/** Never write more than this in one cycle, whatever the runway says. */
export const MAX_PER_CYCLE = 60;

export interface BankEntryOut {
  sig: string;
  hash: string;
  kind: string;
  category: string;
  tier: string;
  promptNorm: string;
  payloadNorm: string;
  answerNorm: string;
  round: number;
  slug: string;
  id: number;
  addedAt: string;
  prompt: string;
  options: string[];
  answer: string;
  explanation: string;
  /** See GRADE_AUTHORED. The measurable difficulty variable. */
  gradeLevel: number;
  /** Provenance, so a generated item is never mistaken for an authored one. */
  source: string;
  /** The judge's own rating at admission: easy | medium | hard. */
  ratedDifficulty?: string;
}

/**
 * validate.mjs owns the signature algorithm and says so ("single source of truth" —
 * hermes-used-sigs.json and ab-test-usage.json key the never-repeat guarantee off these
 * bytes). Reimplementing `norm`/`slugify`/`payloadOf` here would work right up until one
 * of them changed, and the failure mode is a silent duplicate rather than an error.
 *
 * Imported LAZILY, and only inside the top-up path. It is a CLI module (guarded, so
 * importing does not run it) that lives outside hermes/, and a static import would put
 * the whole daily cycle's module graph at the mercy of a file the cycle otherwise never
 * touches.
 */
async function sigTools(): Promise<{ sigOf: (q: any) => string; hashOf: (s: string) => string }> {
  const mod: any = await import(new URL("../../content/validate.mjs", import.meta.url).href);
  if (typeof mod.sigOf !== "function" || typeof mod.hashOf !== "function") {
    throw new Error("content/validate.mjs did not export sigOf/hashOf");
  }
  return { sigOf: mod.sigOf, hashOf: mod.hashOf };
}

const norm = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

/** How many questions the designer can actually draw right now. */
export function drawableCount(kinds?: string[]): number {
  return candidateQuestions(kinds ? ({ category: "mixed", seed: "runway", kinds } as any) : { category: "mixed", seed: "runway" }).length;
}

export interface Runway {
  drawable: number;
  perDay: number;
  days: number;
  needsTopUp: boolean;
  shortfall: number;
}

/**
 * Runway in days, and how many questions we would have to add to reach the threshold.
 * `perDay` is questions, not videos — a video is 3, and a REJECTED video spends them
 * too, which is why the observed burn runs ahead of videos x 3.
 */
export function runway(perDay: number, targetDays = TOPUP_RUNWAY_DAYS): Runway {
  const drawable = drawableCount();
  const days = perDay > 0 ? drawable / perDay : Infinity;
  const want = Math.ceil(targetDays * perDay);
  return {
    drawable,
    perDay,
    days,
    needsTopUp: drawable < want,
    shortfall: Math.max(0, want - drawable),
  };
}

interface RawGen {
  prompt?: string;
  options?: string[];
  answer?: string;
  explanation?: string;
  tier?: string;
  category?: string;
}

/** Types a generated item may claim. Kept to the existing vocabulary so the rollups,
 *  the prompt-length table and the retention weighting all keep working unchanged. */
const ALLOWED_TIERS = new Set(["ODD ONE OUT", "COMPARE", "VERBAL ANALOGY", "NUMBER PUZZLE", "LOGIC", "ANTONYM", "SYNONYM"]);

const SYSTEM =
  "You write brain-quiz questions for 'Smart Fella or Fart Smella', a Gen-Z short-video quiz brand. " +
  "You are writing the HARD end of the bank: items an adult finds genuinely non-obvious, in the fewest " +
  "possible words. Difficulty must come from the REASONING, never from long wording, obscure vocabulary, " +
  "or specialist knowledge. A smart person should be able to see the answer is findable, and still not see " +
  "it immediately. Kid-safe. No em dashes, no en dashes.";

function userPrompt(n: number, avoid: string[]): string {
  return (
    `Write ${n} quiz questions as JSON.\n\n` +
    `HARD RULES, all of them:\n` +
    `- The PROMPT must be at most ${MAX_GEN_PROMPT_WORDS} words. This is the most important rule. ` +
    `"WHICH DOES NOT BELONG?" is 4 words and is ideal.\n` +
    `- Exactly 4 options. Each option at most ${LIMITS.maxOption} characters. Short options are better; ` +
    `single numbers or single words are ideal.\n` +
    `- Exactly ONE option is correct. No option may be arguably correct on a second reading.\n` +
    `- Difficulty: roughly grade 12. The RULE should be non-obvious, not the words.\n` +
    `- Give a one-sentence explanation naming the rule.\n` +
    `- tier must be one of: ${[...ALLOWED_TIERS].join(", ")}\n` +
    `- category must be "verbal" or "quantitative".\n\n` +
    `THE TARGET SHAPE, to imitate:\n` +
    `  prompt "WHICH DOES NOT BELONG?", options ["2","3","5","9"], answer "9", ` +
    `explanation "2, 3 and 5 are prime; 9 is the only composite number."\n` +
    `Four words on screen, one character per option, and the rule is not visible at a glance.\n\n` +
    `Vary the underlying rule across the set: primes, perfect squares, powers, factors, letter position, ` +
    `hidden words, anagram structure, roman numerals, units, parity of digit sums. Do NOT make them all ` +
    `about primes.\n\n` +
    (avoid.length ? `Do NOT reuse these answers or option sets: ${avoid.slice(0, 40).join(" | ")}\n\n` : "") +
    `Return JSON {"questions":[{"prompt":"...","options":["..."],"answer":"...","explanation":"...",` +
    `"tier":"...","category":"..."}]}`
  );
}

/**
 * Questions per model call, and the token budget for one.
 *
 * SIX, measured rather than chosen. The reasoning model spends most of its budget
 * thinking before it emits anything, so a big ask does not fail loudly — it returns
 * TRUNCATED JSON, or an empty string, and the parse error that follows looks like a
 * gateway fault. Measured on the live gateway: 6 questions at 4,000 tokens returns 6
 * (49s), 12 at 8,000 truncates and parses to nothing, 12 at 16,000 returns 12 (74s).
 * Small batches at a generous budget are the reliable corner, and chunking also means
 * one bad batch costs six candidates instead of the whole top-up.
 */
export const GEN_BATCH = 6;
const GEN_MAX_TOKENS = 8000;

/**
 * Ask the model for `n` candidates, in batches. Returns whatever parsed; admission is
 * separate and refuses most of what needs refusing.
 *
 * A batch that fails is WARNED AND SKIPPED rather than thrown, so a single truncated
 * response cannot cost the cycle its whole top-up.
 */
export async function generateCandidates(n: number, avoid: string[] = []): Promise<RawGen[]> {
  const out: RawGen[] = [];
  const batches = Math.ceil(n / GEN_BATCH);
  for (let i = 0; i < batches; i++) {
    const want = Math.min(GEN_BATCH, n - out.length);
    if (want <= 0) break;
    try {
      const resp = await chatJSON<{ questions?: RawGen[] }>(SYSTEM, userPrompt(want, avoid), {
        model: CONFIG.MODEL,
        fallbackModel: CONFIG.JUDGE_FALLBACK_MODEL,
        maxTokens: GEN_MAX_TOKENS,
        temperature: 0.9,
      });
      const got = Array.isArray(resp.questions) ? resp.questions : [];
      out.push(...got);
      // Feed this batch's answers back in, so batch two does not re-propose batch one.
      // The fuzzy guard would catch the repeats anyway; not generating them is cheaper.
      for (const q of got) if (q?.answer) avoid = [...avoid, String(q.answer)];
    } catch (e) {
      warn("generate: a batch failed (continuing with the rest)", {
        batch: i + 1, of: batches, err: e instanceof Error ? e.message.slice(0, 140) : String(e),
      });
    }
  }
  return out;
}

export interface AdmitResult {
  admitted: BankEntryOut[];
  rejected: Array<{ prompt: string; reason: string }>;
}

/**
 * Turn raw model output into bank entries, refusing everything the gates refuse.
 *
 * Deliberately in this order, cheapest and most certain first: shape, then the length
 * budgets the renderer needs, then the reading-load rule this whole feature exists to
 * hold, then exact-signature collision, then the fuzzy near-duplicate key, and only then
 * the LLM rubric — which is the one that costs money. A candidate that fails the free
 * checks never reaches the judge.
 */
export async function admitCandidates(raw: RawGen[], gradeLevel = GRADE_HARD): Promise<AdmitResult> {
  const { sigOf, hashOf } = await sigTools();
  const bank = loadBank();
  const existingSigs = new Set(bank.map((e) => e.sig));
  const existingFuzzy = new Set<string>();
  for (const e of bank) {
    const q = toHermesQ(e as any);
    if (q) existingFuzzy.add(fuzzySig(q));
  }

  const admitted: BankEntryOut[] = [];
  const rejected: Array<{ prompt: string; reason: string }> = [];
  const staged: Array<{ entry: BankEntryOut; q: HermesQ }> = [];
  const seenSig = new Set<string>();
  const seenFuzzy = new Set<string>();

  for (const r of raw) {
    const prompt = String(r.prompt ?? "").trim();
    const options = Array.isArray(r.options) ? r.options.map((o) => String(o ?? "").trim()).filter(Boolean) : [];
    const answer = String(r.answer ?? "").trim();
    const explanation = String(r.explanation ?? "").trim();
    const tier = String(r.tier ?? "").trim().toUpperCase();
    const category = String(r.category ?? "").trim().toLowerCase();
    const fail = (reason: string) => rejected.push({ prompt: prompt.slice(0, 60), reason });

    if (!prompt || !options.length || !answer) { fail("missing prompt/options/answer"); continue; }
    if (!ALLOWED_TIERS.has(tier)) { fail(`tier "${tier}" not in the allowed vocabulary`); continue; }
    if (category !== "verbal" && category !== "quantitative") { fail(`category "${category}" not allowed`); continue; }
    if (/[\u2013\u2014]/.test(prompt + options.join("") + explanation)) { fail("contains an em/en dash (brand rule)"); continue; }
    // THE READING-LOAD RULE. A hard question that is long is the failure mode this
    // feature exists to avoid, so it is refused here rather than trimmed silently.
    if (promptWords(prompt) > MAX_GEN_PROMPT_WORDS) { fail(`prompt is ${promptWords(prompt)} words, max ${MAX_GEN_PROMPT_WORDS}`); continue; }
    if (!explanation) { fail("no explanation"); continue; }

    const forSig = { kind: "text", category, tier, question: prompt, options: options.map((t) => ({ text: t })), ansLabel: answer };
    const sig = sigOf(forSig);
    const hash = hashOf(sig);
    const entry: BankEntryOut = {
      sig, hash, kind: "text", category, tier,
      promptNorm: norm(prompt),
      payloadNorm: `${norm(prompt)} || ${options.map(norm).sort().join("~")}`,
      answerNorm: norm(answer),
      round: 900, slug: "generated", id: 0, addedAt: new Date().toISOString().slice(0, 10),
      prompt, options, answer, explanation,
      gradeLevel, source: `hermes-generate:${CONFIG.MODEL}`,
    };

    // structural validity, via the SAME function the gates use
    const q = toHermesQ(entry as any);
    if (!q) { fail("failed toHermesQ (unusable/overflows)"); continue; }
    const issue = textStructuralIssue(q);
    if (issue) { fail(issue); continue; }

    if (existingSigs.has(sig) || seenSig.has(sig)) { fail("exact duplicate of an existing question"); continue; }
    const fz = fuzzySig(q);
    if (existingFuzzy.has(fz) || seenFuzzy.has(fz)) { fail("near-duplicate of an existing question"); continue; }
    seenSig.add(sig);
    seenFuzzy.add(fz);
    staged.push({ entry, q });
  }

  if (!staged.length) return { admitted, rejected };

  // THE JUDGE. Same rubric and same model as a video's question gate.
  //
  // VALIDATED IN CHUNKS, for the same reason generation is: the rubric asks for a
  // written analysis per question inside a 6,000-token budget, and eleven at once
  // overran it, truncated the JSON, and dropped the whole batch onto the deterministic
  // fallback. Six is what the generator produces per call anyway.
  const verdicts: Record<string, { valid: boolean; reason: string; difficulty?: string }> = {};
  for (let i = 0; i < staged.length; i += GEN_BATCH) {
    const chunk = staged.slice(i, i + GEN_BATCH);
    try {
      const res = await validateQuestions(chunk.map((s) => s.q));
      Object.assign(verdicts, res.results as any);
    } catch (e) {
      warn("generate: validity judge failed for a chunk — those candidates are dropped", {
        err: e instanceof Error ? e.message.slice(0, 140) : String(e),
      });
    }
  }

  for (const s of staged) {
    const v = verdicts[s.q.sig];
    if (!v || !v.valid) { rejected.push({ prompt: s.entry.prompt.slice(0, 60), reason: `judge: ${v?.reason ?? "no verdict"}` }); continue; }
    // FAIL CLOSED ON AN ABSENT RATING, which is the difference between this gate and
    // the video one. validateQuestions deliberately degrades to a deterministic
    // structural check when the rubric is unreachable, so that a judge outage cannot
    // stop the day's posting — the right trade for a video, because the alternative is
    // posting nothing. It is the WRONG trade here: the structural check cannot tell
    // whether an answer is actually correct, and a bad question admitted to the bank is
    // permanent and will be drawn again later.
    //
    // This was not hypothetical. On the first live run the rubric's own response
    // truncated, eleven candidates fell through to the structural check, and three
    // arrived with incoherent or plainly wrong rules — one claimed 48 has an odd digit
    // sum. Only the real rubric sets `difficulty`, so requiring it is exactly the test
    // for "a human-grade opinion actually happened", and it enforces the hard-question
    // requirement in the same expression.
    if (!v.difficulty) {
      rejected.push({ prompt: s.entry.prompt.slice(0, 60), reason: "no rubric verdict (fallback only) — failing closed" });
      continue;
    }
    if (v.difficulty === "easy") { rejected.push({ prompt: s.entry.prompt.slice(0, 60), reason: "judge rated it easy" }); continue; }
    s.entry.ratedDifficulty = v.difficulty;
    admitted.push(s.entry);
  }
  return { admitted, rejected };
}

/** Append admitted entries to the bank, atomically, never touching an existing row. */
export function appendToBank(entries: BankEntryOut[]): number {
  if (!entries.length) return 0;
  const bank = readJSON<{ version?: number; updated?: string; count?: number; entries?: any[] }>(CONFIG.BANK, {});
  const rows = Array.isArray(bank.entries) ? bank.entries : [];
  const have = new Set(rows.map((e: any) => e.sig));
  let nextId = rows.reduce((m: number, e: any) => Math.max(m, Number(e.id) || 0), 0);
  let added = 0;
  for (const e of entries) {
    if (have.has(e.sig)) continue; // re-entrant safety: never append twice
    rows.push({ ...e, id: ++nextId });
    have.add(e.sig);
    added++;
  }
  if (!added) return 0;
  bank.entries = rows;
  bank.count = rows.length;
  bank.updated = new Date().toISOString().slice(0, 10);
  writeJSONAtomic(CONFIG.BANK, bank);
  return added;
}

export interface TopUpResult {
  ran: boolean;
  before: number;
  after: number;
  added: number;
  rejected: number;
  runway_days_before: number;
  runway_days_after: number;
  note: string;
  reject_reasons: Record<string, number>;
}

/**
 * The cycle's entry point: check the runway, and refill only if it is short.
 *
 * NEVER THROWS past its caller's try. Generation is an optimiser; a cycle that cannot
 * generate should still post today's videos from the stock it has, and then post fewer
 * tomorrow. Failing here must never cost the day its batch.
 */
export async function topUpBank(perDay: number, opts: { targetDays?: number; max?: number } = {}): Promise<TopUpResult> {
  const targetDays = opts.targetDays ?? TOPUP_RUNWAY_DAYS;
  const before = drawableCount();
  const r = runway(perDay, targetDays);
  const base: TopUpResult = {
    ran: false, before, after: before, added: 0, rejected: 0,
    runway_days_before: r.days, runway_days_after: r.days,
    note: "", reject_reasons: {},
  };
  if (!r.needsTopUp) {
    base.note = `${before} drawable questions is ${r.days.toFixed(1)} days at ${perDay}/day; no top-up needed above ${targetDays}.`;
    info("bank top-up: not needed", { drawable: before, days: Number(r.days.toFixed(1)), perDay });
    return base;
  }

  const want = Math.min(opts.max ?? MAX_PER_CYCLE, Math.max(12, r.shortfall));
  info("bank top-up: running", { drawable: before, days: Number(r.days.toFixed(1)), want });
  // A little context so the model does not re-propose the same handful of ideas every
  // night; the fuzzy guard would catch them, but it is cheaper not to generate them.
  const avoid = candidateQuestions({ category: "mixed", seed: "avoid" }).slice(0, 40).map((q) => q.answer);

  let raw: RawGen[] = [];
  try {
    raw = await generateCandidates(want, avoid);
  } catch (e) {
    base.note = `generation failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    warn("bank top-up: generation failed (continuing on existing stock)", { err: base.note });
    return base;
  }

  let admitted: BankEntryOut[] = [];
  let rejected: Array<{ prompt: string; reason: string }> = [];
  try {
    const res = await admitCandidates(raw, GRADE_HARD);
    admitted = res.admitted;
    rejected = res.rejected;
  } catch (e) {
    base.note = `admission failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`;
    warn("bank top-up: admission failed (continuing on existing stock)", { err: base.note });
    return base;
  }

  const added = appendToBank(admitted);
  const after = drawableCount();
  const reasons: Record<string, number> = {};
  for (const x of rejected) {
    const k = x.reason.split(":")[0].slice(0, 40);
    reasons[k] = (reasons[k] ?? 0) + 1;
  }
  const out: TopUpResult = {
    ran: true, before, after, added, rejected: rejected.length,
    runway_days_before: r.days,
    runway_days_after: perDay > 0 ? after / perDay : Infinity,
    note:
      `asked for ${want}, model returned ${raw.length}, ${added} passed every gate. ` +
      `Drawable ${before} -> ${after} (${r.days.toFixed(1)} -> ${(after / Math.max(perDay, 1)).toFixed(1)} days at ${perDay} questions/day).`,
    reject_reasons: reasons,
  };
  decision(`BANK TOP-UP: +${added} hard short-prompt questions. ${out.note}`);
  info("bank top-up: done", { added, rejected: rejected.length, reasons });
  return out;
}
