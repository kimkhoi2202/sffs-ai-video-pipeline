/**
 * arithmetic.ts — DETERMINISTIC validity for the two mechanical quantitative
 * tiers, so the LLM rubric never has to do arithmetic search.
 *
 * WHY THIS EXISTS. Between 2026-07-30 and 2026-08-02 the question-validity gate
 * rejected 35 questions and 29 of them were NUMBER PUZZLE or NUMBER ANALOGY items.
 * Re-deciding all 100 NUMBER PUZZLE entries in the bank against the rule family
 * below found 94 with a single consistent rule and 6 genuinely broken; of the 20
 * flagged ones that could be parsed, 18 were well-determined. The judge was wrong
 * about the format roughly nine times in ten, and its own rationales said so —
 * "Pattern (a+b)*2: 5+5=20, 1+3=8, 8+4=24, so 9+6=30 correct", marked invalid.
 *
 * These items are decidable by enumeration, so they are decided by enumeration.
 * The rubric keeps the judgements it is actually good at (verbal ambiguity,
 * factual correctness, tone, grade-appropriateness) and loses the one it is bad at.
 *
 * FAIL-OPEN BY CONSTRUCTION. Three outcomes only:
 *   - exactly one value survives  -> decided VALID here, no LLM call;
 *   - the item is self-referential or genuinely under-determined -> decided INVALID
 *     here (these are real generator defects and must not be re-proposed);
 *   - anything unparseable, or an item whose rule is outside the family below
 *     -> NOT HANDLED, and it falls through to the rubric exactly as before.
 * So a rule this module has never seen costs a question nothing: the worst case is
 * the behaviour that already existed.
 */
import type { HermesQ } from "./state.ts";

/** What this module decided about a question. `handled:false` => ask the rubric. */
export type QuantVerdict =
  | { handled: true; valid: boolean; reason: string; rule?: string }
  | { handled: false };

const NOT_HANDLED: QuantVerdict = { handled: false };

/** Worked example "8+5=32" / "3 -> 7", plus the trailing "9+6 = ?" / "7 -> ?". */
const BINARY_EXAMPLE = /(-?\d+)\s*\+\s*(-?\d+)\s*=\s*(-?\d+)/g;
const BINARY_QUERY = /(-?\d+)\s*\+\s*(-?\d+)\s*=\s*\?/;
const UNARY_EXAMPLE = /(-?\d+)\s*(?:->|→)\s*(-?\d+)(?!\s*\?)/g;
const UNARY_QUERY = /(-?\d+)\s*(?:->|→)\s*\?/;

/** Digit concatenation ("8+5=53" is 8-5 then 8+5). Null when it isn't well defined. */
function concat(x: number, y: number): number | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0) return null; // a leading minus cannot be concatenated meaningfully
  const n = Number(`${x}${Math.abs(y)}`);
  return Number.isSafeInteger(n) ? n : null;
}

type Binary = (a: number, b: number) => number | null;
type Unary = (n: number) => number | null;

/**
 * The BINARY rule family for NUMBER PUZZLE ("IF 5+5=20, 1+3=8, 8+4=24 THEN 9+6=?").
 * Built once. Every rule the bank actually uses is in here — all 100 NUMBER PUZZLE
 * entries resolve to at least one member — but the module fails open when none fit,
 * so the family never has to be exhaustive to be safe.
 */
function buildBinaryRules(): Map<string, Binary> {
  const R = new Map<string, Binary>();
  R.set("a+b", (a, b) => a + b);
  R.set("a-b", (a, b) => a - b);
  R.set("a*b", (a, b) => a * b);
  R.set("a*b+a", (a, b) => a * b + a);
  R.set("a*b+b", (a, b) => a * b + b);
  R.set("a*b-a", (a, b) => a * b - a);
  R.set("a*b-b", (a, b) => a * b - b);
  R.set("a*b+a+b", (a, b) => a * b + a + b);
  R.set("a*b-a-b", (a, b) => a * b - a - b);
  R.set("a*b+a-b", (a, b) => a * b + a - b);
  R.set("a*b-a+b", (a, b) => a * b - a + b);
  R.set("(a+b)*a", (a, b) => (a + b) * a);
  R.set("(a+b)*b", (a, b) => (a + b) * b);
  R.set("(a-b)*a", (a, b) => (a - b) * a);
  R.set("(a-b)*b", (a, b) => (a - b) * b);
  R.set("(a+b)*(a-b)", (a, b) => (a + b) * (a - b));
  R.set("(a+b)*(a+1)", (a, b) => (a + b) * (a + 1));
  R.set("(a+b)*(b+1)", (a, b) => (a + b) * (b + 1));
  R.set("(a+1)*b", (a, b) => (a + 1) * b);
  R.set("(a-1)*b", (a, b) => (a - 1) * b);
  R.set("a*(b+1)", (a, b) => a * (b + 1));
  R.set("a*(b-1)", (a, b) => a * (b - 1));
  R.set("a^2+b", (a, b) => a * a + b);
  R.set("a+b^2", (a, b) => a + b * b);
  R.set("a^2+b^2", (a, b) => a * a + b * b);
  R.set("a^2-b^2", (a, b) => a * a - b * b);
  R.set("(a+b)^2", (a, b) => (a + b) * (a + b));
  R.set("(a-b)^2", (a, b) => (a - b) * (a - b));
  R.set("concat(a,b)", (a, b) => concat(a, b));
  R.set("concat(a+b,a-b)", (a, b) => concat(a + b, a - b));
  R.set("concat(a-b,a+b)", (a, b) => concat(a - b, a + b));
  R.set("concat(a+b,a*b)", (a, b) => concat(a + b, a * b));
  R.set("concat(a*b,a+b)", (a, b) => concat(a * b, a + b));
  for (let k = 2; k <= 10; k++) {
    R.set(`(a+b)*${k}`, (a, b) => (a + b) * k);
    R.set(`(a*b)*${k}`, (a, b) => a * b * k);
    R.set(`(a+b)+${k}`, (a, b) => a + b + k);
    R.set(`(a*b)+${k}`, (a, b) => a * b + k);
    R.set(`(a*b)-${k}`, (a, b) => a * b - k);
    R.set(`(a+b)*${k}+a`, (a, b) => (a + b) * k + a);
    R.set(`(a+b)*${k}+b`, (a, b) => (a + b) * k + b);
  }
  return R;
}

/**
 * The UNARY rule family for NUMBER ANALOGY ("3 -> 7, 5 -> 13, 6 -> 16, 7 -> ?").
 * Dominated by k*n+c, which is what the bank authors; the shaped rules cover the
 * square/triangular items that a linear fit would miss.
 */
function buildUnaryRules(): Map<string, Unary> {
  const R = new Map<string, Unary>();
  for (let k = -5; k <= 12; k++) {
    for (let c = -30; c <= 30; c++) {
      R.set(`${k}n${c >= 0 ? "+" : ""}${c}`, (n) => k * n + c);
    }
  }
  R.set("n^2", (n) => n * n);
  R.set("n^2+n", (n) => n * n + n);
  R.set("n^2-n", (n) => n * n - n);
  R.set("n^2+1", (n) => n * n + 1);
  R.set("n^2-1", (n) => n * n - 1);
  R.set("n*(n+2)", (n) => n * (n + 2));
  R.set("n*(n+1)/2", (n) => (n * (n + 1)) % 2 === 0 ? (n * (n + 1)) / 2 : null);
  R.set("n^3", (n) => n * n * n);
  return R;
}

const BINARY_RULES = buildBinaryRules();
const UNARY_RULES = buildUnaryRules();

/** Every integer option, or null when the option list isn't purely numeric. */
function numericOptions(options: readonly string[] | undefined): number[] | null {
  if (!options || options.length < 2) return null;
  const out: number[] = [];
  for (const o of options) {
    const n = Number(String(o ?? "").trim());
    if (!Number.isInteger(n)) return null;
    out.push(n);
  }
  return out;
}

/**
 * Shared decision, given the values every surviving rule predicts for the query.
 * A rule predicting something that is NOT on the option list cannot mislead a
 * viewer who can only choose from the options, so only ON-OPTION predictions can
 * make an item ambiguous.
 */
function decide(
  predictions: Map<number, string[]>,
  options: number[],
  answer: number,
  label: string,
): QuantVerdict {
  if (predictions.size === 0) return NOT_HANDLED; // rule outside the family — ask the rubric
  const onOption = [...predictions.keys()].filter((v) => options.includes(v));
  if (onOption.length > 1) {
    return {
      handled: true,
      valid: false,
      reason:
        `${label}: under-determined — ${onOption.length} of the offered options are each reachable ` +
        `by a consistent rule (${onOption.map((v) => `${v} via ${predictions.get(v)![0]}`).join("; ")})`,
    };
  }
  if (!predictions.has(answer)) {
    return {
      handled: true,
      valid: false,
      reason:
        `${label}: the stated answer ${answer} is not produced by any rule consistent with the worked ` +
        `examples (consistent rules give ${[...predictions.keys()].slice(0, 4).join(", ")})`,
    };
  }
  if (!options.includes(answer)) {
    return { handled: true, valid: false, reason: `${label}: the stated answer ${answer} is not one of the options` };
  }
  return {
    handled: true,
    valid: true,
    reason: `${label}: single consistent rule ${predictions.get(answer)![0]} gives ${answer}`,
    rule: predictions.get(answer)![0],
  };
}

/**
 * NUMBER PUZZLE — "IF 5+5=20, 1+3=8, 8+4=24 THEN 9+6 = ?", where `+` denotes a
 * hidden binary operator.
 */
export function numberPuzzleVerdict(prompt: string, options: readonly string[] | undefined, answerRaw: string): QuantVerdict {
  const text = String(prompt ?? "");
  const query = BINARY_QUERY.exec(text);
  if (!query) return NOT_HANDLED;
  const opts = numericOptions(options);
  if (!opts) return NOT_HANDLED;
  const answer = Number(String(answerRaw ?? "").trim());
  if (!Number.isInteger(answer)) return NOT_HANDLED;

  const [qa, qb] = [Number(query[1]), Number(query[2])];
  const examples: Array<[number, number, number]> = [];
  for (const m of text.matchAll(BINARY_EXAMPLE)) examples.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  if (examples.length < 2) return NOT_HANDLED;

  // SELF-REFERENTIAL: the pair being asked is already answered in the setup, so the
  // item is either trivial or contradicts itself. A real generator defect — six of
  // the bank's hundred NUMBER PUZZLE entries are like this, and two of them were
  // among the questions the judge flagged.
  if (examples.some(([a, b]) => a === qa && b === qb)) {
    return {
      handled: true,
      valid: false,
      reason: `number-puzzle: circular — the setup already states ${qa}+${qb}, so the question answers itself`,
    };
  }

  const predictions = new Map<number, string[]>();
  for (const [name, f] of BINARY_RULES) {
    let fits = true;
    for (const [a, b, c] of examples) {
      const v = f(a, b);
      if (v === null || v !== c) { fits = false; break; }
    }
    if (!fits) continue;
    const v = f(qa, qb);
    if (v === null) continue;
    const at = predictions.get(v);
    if (at) at.push(name);
    else predictions.set(v, [name]);
  }
  return decide(predictions, opts, answer, "number-puzzle");
}

/** NUMBER ANALOGY — "WHICH NUMBER FITS? 3 -> 7, 5 -> 13, 6 -> 16, 7 -> ?". */
export function numberAnalogyVerdict(prompt: string, options: readonly string[] | undefined, answerRaw: string): QuantVerdict {
  const text = String(prompt ?? "");
  const query = UNARY_QUERY.exec(text);
  if (!query) return NOT_HANDLED;
  const opts = numericOptions(options);
  if (!opts) return NOT_HANDLED;
  const answer = Number(String(answerRaw ?? "").trim());
  if (!Number.isInteger(answer)) return NOT_HANDLED;

  const qn = Number(query[1]);
  const examples: Array<[number, number]> = [];
  for (const m of text.matchAll(UNARY_EXAMPLE)) examples.push([Number(m[1]), Number(m[2])]);
  if (examples.length < 2) return NOT_HANDLED;
  if (examples.some(([n]) => n === qn)) {
    return {
      handled: true,
      valid: false,
      reason: `number-analogy: circular — the setup already maps ${qn}, so the question answers itself`,
    };
  }

  const predictions = new Map<number, string[]>();
  for (const [name, f] of UNARY_RULES) {
    let fits = true;
    for (const [n, out] of examples) {
      const v = f(n);
      if (v === null || v !== out) { fits = false; break; }
    }
    if (!fits) continue;
    const v = f(qn);
    if (v === null) continue;
    const at = predictions.get(v);
    if (at) at.push(name);
    else predictions.set(v, [name]);
  }
  return decide(predictions, opts, answer, "number-analogy");
}

/** Tier labels this module claims. Anything else falls straight through. */
const MECHANICAL_TIERS = new Set(["NUMBER PUZZLE", "NUMBER ANALOGY"]);

/**
 * Decide a question deterministically when it is one of the mechanical
 * quantitative tiers, else report `handled:false` so the LLM rubric runs.
 * Total: never throws, whatever shape the bank entry has.
 */
export function quantVerdict(q: HermesQ): QuantVerdict {
  try {
    if (!q || q.kind !== "text") return NOT_HANDLED;
    const tier = String(q.tier ?? "").trim().toUpperCase();
    if (!MECHANICAL_TIERS.has(tier)) return NOT_HANDLED;
    return tier === "NUMBER PUZZLE"
      ? numberPuzzleVerdict(q.prompt, q.options, q.answer)
      : numberAnalogyVerdict(q.prompt, q.options, q.answer);
  } catch {
    return NOT_HANDLED; // a verifier bug must never cost a question its slot
  }
}
