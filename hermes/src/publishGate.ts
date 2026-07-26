/**
 * publishGate.ts — the LAST deterministic gate before anything is scheduled.
 *
 * Why it exists. On 2026-07-25 the Opus budget 429'd on the very first rubric call of
 * the day, gates.ts fell back to its structural check, and every text video drafted
 * after that passed — because a structural check cannot see that "2/3" has become
 * "2 3". Green tests and a passing gate shipped mangled text three passes running.
 *
 * Every defect that was actually found is checkable WITHOUT a model, so this gate is
 * pure and deterministic and runs on every video regardless of whether the LLM rubric
 * was reachable:
 *
 *   1. PUNCTUATION PRESERVED. The bank's dedup normalizer is
 *      `.toLowerCase().replace(/[^a-z0-9]+/g," ")`, so its output is always lowercase
 *      and contains nothing but [a-z0-9 ]. Authored prompts are uppercase and carry
 *      "?", "/", "'", "$", "_" or newlines. A string that could be normalizer output
 *      and contains no authored punctuation at all is treated as mangled. This is the
 *      exact fingerprint of the incident and it is cheap to detect.
 *   2. EXPLANATION QUALITY. Non-empty, references its own answer, and not byte-equal
 *      to any explanation used in the last N posts — the template used to emit
 *      "spot the pattern to crack the sequence" for every non-arithmetic series, so
 *      two questions answering 53 and K shipped identical reveal copy.
 *   3. OPTIONS DISTINCT. No duplicate option text, and exactly one matches the answer.
 *   4. CAPTION + HASHTAG NOVELTY. Neither the caption nor the hashtag set may repeat
 *      against the last N posts. Four of four exact-duplicate captions were throttled
 *      on TikTok, so this one is load-bearing rather than cosmetic.
 *
 * It fails CLOSED: anything it cannot verify is a failure, because the cost of holding
 * a video back is one slot and the cost of shipping a broken one is the account.
 */
import type { GateResult, HermesQ } from "./state.ts";
// The pipeline's canonical number speller, the same one the reveal VO uses.
import { n2w } from "../../content/gen-narration-scripts.mjs";

/** How far back caption/hashtag/explanation novelty is enforced. */
export const NOVELTY_WINDOW = 30;

export interface RecentPost {
  caption?: string;
  hashtag_set?: string;
  explanations?: string[];
}

export interface PublishCandidate {
  id: string;
  caption: string;
  hashtag_set?: string;
  questions: HermesQ[];
  /** Per-question explanation as it will actually render (post render.ts fallback). */
  explanations?: string[];
  /**
   * Per-question answer AS DISPLAYED (render.ts `ansLabel`). For shape kinds `q.answer`
   * is an internal code — "tr", "filled-circle" — that no explanation would ever
   * contain, so the answer-reference check needs the human-readable label instead.
   */
  answerLabels?: string[];
}

/** Characters an authored prompt/option may carry that the normalizer destroys. */
const AUTHORED_PUNCT = /[?/'’$%_.,!:;()\n\u2192-]|->/;

/**
 * Could this string be raw normalizer output? True when it is entirely lowercase
 * alphanumerics and single spaces — i.e. it shows no evidence of authored text.
 * Deliberately conservative: a genuinely lowercase, punctuation-free authored string
 * would also trip this, which is the safe direction to be wrong in.
 */
export function looksNormalized(s: string): boolean {
  const t = String(s ?? "").trim();
  if (!t) return false;
  if (AUTHORED_PUNCT.test(t)) return false; // carries punctuation -> authored
  if (/[A-Z]/.test(t)) return false; // carries case -> authored
  return /^[a-z0-9]+( [a-z0-9]+)*$/.test(t);
}

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

/** Normalised comparison key for a caption (whitespace/case insensitive). */
const captionKey = (s: unknown): string => norm(s).replace(/\s+/g, " ");

/**
 * Does `explanation` reference `answer`?
 *
 * Not a plain substring test, because the authored explanations SPELL numbers out —
 * "each number is multiplied by two then add one, so six becomes thirteen" for the
 * answer 13. That is correct authoring: the explanation is also read aloud as the
 * reveal VO. A digits-only check called 286 of 852 text questions unexplained, 279 of
 * them purely because the number was written as a word.
 *
 * So the answer is accepted in either form, and hyphenation is ignored so
 * "twenty-three" matches "twenty three".
 */
export function referencesAnswer(explanation: string, answer: string): boolean {
  const flat = (s: string) => norm(s).replace(/[-\u2011-\u2015]/g, " ").replace(/\s+/g, " ");
  const e = flat(explanation);
  const a = flat(answer);
  if (!a) return true;
  if (e.includes(a)) return true;

  // Numeric answers: also accept the spelled form ("$1.00" -> "one", "2/3" -> parts).
  const numbers = a.match(/\d+/g) ?? [];
  if (numbers.length) {
    const spelled = numbers.map((d) => flat(String(n2w(d) ?? "")));
    if (spelled.every((w) => w && e.includes(w))) return true;
  }
  // Multi-word answers ("CAN'T TELL"): accept when every significant word appears.
  const words = a.split(" ").filter((w) => w.length > 2);
  if (words.length > 1 && words.every((w) => e.includes(w))) return true;
  return false;
}

export function publishGate(v: PublishCandidate, recent: RecentPost[] = []): GateResult {
  const problems: string[] = [];
  const window = recent.slice(-NOVELTY_WINDOW);

  // ── 1 + 3: per-question text integrity ────────────────────────────────────
  v.questions.forEach((q, i) => {
    const where = `q${i + 1}`;
    const prompt = String(q.prompt ?? "").trim();
    if (!prompt) problems.push(`${where}: empty prompt`);
    else if (looksNormalized(prompt)) {
      problems.push(`${where}: prompt looks like a normalized dedup key, not authored text: "${prompt.slice(0, 60)}"`);
    }

    const options = (q.options ?? []).map((o) => String(o ?? "").trim()).filter(Boolean);
    if (options.length) {
      const mangled = options.filter((o) => looksNormalized(o) && /\d \d/.test(o));
      // "2 3" and "1 00" are what a mangled fraction/decimal looks like. A digit,
      // a single space, then a digit is not something an authored option contains.
      if (mangled.length) problems.push(`${where}: option(s) look like mangled numbers: ${JSON.stringify(mangled)}`);
      if (new Set(options.map(norm)).size !== options.length) problems.push(`${where}: duplicate option text`);
      const matches = options.filter((o) => norm(o) === norm(q.answer));
      if (matches.length !== 1) problems.push(`${where}: answer matches ${matches.length} option(s), need exactly 1`);
    }
  });

  // ── 2: explanation quality ────────────────────────────────────────────────
  const explanations = v.explanations ?? [];
  const priorExplanations = new Set(window.flatMap((p) => (p.explanations ?? []).map(norm)).filter(Boolean));
  const seenHere = new Set<string>();
  explanations.forEach((raw, i) => {
    const where = `q${i + 1}`;
    const e = String(raw ?? "").trim();
    if (!e) { problems.push(`${where}: missing explanation`); return; }
    const key = norm(e);
    if (seenHere.has(key)) problems.push(`${where}: explanation repeats another question in THIS video`);
    seenHere.add(key);
    if (priorExplanations.has(key)) problems.push(`${where}: explanation already used in the last ${NOVELTY_WINDOW} posts`);

    // The reveal should say what the answer WAS — but only where the answer is a word
    // or number the sentence could name. On a shape question the answer is a picture:
    // the reveal plate shows the winning figure, and "the dot moves two spots
    // clockwise each time" is a complete explanation that will never contain the
    // string "TOP-RIGHT". Requiring it there would reject correct copy, so the check
    // is scoped to the kinds where naming the answer is actually the job.
    const q = v.questions[i];
    const kind = String(q?.kind ?? "");
    if (kind === "text" || kind === "numseries") {
      const label = String(v.answerLabels?.[i] ?? q?.answer ?? "");
      if (label && !referencesAnswer(e, label)) {
        problems.push(`${where}: explanation never references its answer "${label}"`);
      }
    }
  });
  if (explanations.length && explanations.length !== v.questions.length) {
    problems.push(`explanations (${explanations.length}) do not cover all ${v.questions.length} questions`);
  }

  // ── 4: caption + hashtag novelty ──────────────────────────────────────────
  const cap = captionKey(v.caption);
  if (!cap) problems.push("empty caption");
  if (cap && window.some((p) => captionKey(p.caption) === cap)) {
    problems.push(`caption is an exact duplicate of one in the last ${NOVELTY_WINDOW} posts`);
  }
  if (v.hashtag_set) {
    const recentTagSets = window.map((p) => norm(p.hashtag_set)).filter(Boolean);
    const lastFew = recentTagSets.slice(-3);
    // A rotation is fine and intended; the same set three posts running is not.
    if (lastFew.length === 3 && lastFew.every((t) => t === norm(v.hashtag_set))) {
      problems.push(`hashtag set "${v.hashtag_set}" used on the last 3 posts running`);
    }
  }

  const pass = problems.length === 0;
  return {
    pass,
    reason: pass ? "publish-gate: text, explanations, options and caption all clean" : problems.join("; "),
    detail: { problems, checked: v.questions.length, window: window.length },
  };
}
