/**
 * contested.ts — label a question with whether it carries a SIGNPOSTED TRAP.
 *
 * WHY THIS EXISTS. One post has produced an outlier on this account: 1,256 views
 * against a 107-147 ceiling, and 8 comments where the median is zero. The comments
 * were an ARGUMENT — one commenter insisting "6+6 is NOT 42", another answering "he
 * didn't say I need to follow the sequence". An argument travels; a correction does
 * not.
 *
 * The mechanism is precise and it is computable from props already on disk. The post
 * was `IF 6+6=42, 4+1=5, 6+5=35 THEN 3+2=?` under the rule a*b+b, official answer 8.
 * The load-bearing line is `4+1=5`: under the hidden rule it is 4x1+1, and under plain
 * addition it is 4+1, and both give 5. One worked example is therefore SIMULTANEOUSLY
 * TRUE under both readings, which licenses plain arithmetic — and then 5, the plain sum
 * of 3+2, is on the option list. Both camps are internally consistent, so neither can
 * simply be corrected, and they argue instead.
 *
 * So the label is the conjunction of exactly those two facts:
 *   ENDORSED — some worked example where the hidden rule agrees with plain addition;
 *   OFFERED  — the plain sum of the query is one of the options, and is not the answer.
 *
 * WHAT THIS IS NOT. It is not a claim that the question is ambiguous. Ambiguity is the
 * failure mode next door and it is a genuinely bad question: if the naive answer is as
 * defensible as the official one the post earns distrust rather than argument. Whether
 * the official answer is uniquely determined is decided separately and authoritatively
 * by arithmetic.ts, which enumerates the rule family; this module only reports whether
 * a TRAP is present and signposted. A shipped contested question needs BOTH verdicts:
 * valid there, contested here.
 */
import type { HermesQ } from "./state.ts";

/** Worked example "6+6=42"; the trailing "3+2=?" deliberately does not match. */
const BINARY_EXAMPLE = /(-?\d+)\s*\+\s*(-?\d+)\s*=\s*(-?\d+)/g;
const BINARY_QUERY = /(-?\d+)\s*\+\s*(-?\d+)\s*=\s*\?/;

export interface ContestedLabel {
  /** Both conditions hold: the naive reading is endorsed by an example AND offered. */
  contested: boolean;
  /** The plain-arithmetic answer to the query, when the shape has one. */
  naiveAnswer: string | null;
  /** Is that naive answer on the option list (i.e. is the trap reachable)? */
  naiveOffered: boolean;
  /** The worked example that is true under BOTH readings, e.g. "4+1=5". */
  endorsedBy: string | null;
  reason: string;
}

const NOT_APPLICABLE = (reason: string): ContestedLabel => ({
  contested: false, naiveAnswer: null, naiveOffered: false, endorsedBy: null, reason,
});

/** Tiers whose surface arithmetic makes "the naive reading" well defined. */
const TRAPPABLE_TIERS = new Set(["NUMBER PUZZLE"]);

/**
 * Label one question. TOTAL — never throws, whatever shape the bank entry has, because
 * a labelling bug must not be able to cost a question its slot.
 */
export function contestedLabel(q: Pick<HermesQ, "kind" | "tier" | "prompt" | "options" | "answer">): ContestedLabel {
  try {
    if (!q || q.kind !== "text") return NOT_APPLICABLE("not a text question");
    const tier = String(q.tier ?? "").trim().toUpperCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    if (!TRAPPABLE_TIERS.has(tier)) return NOT_APPLICABLE(`tier "${tier}" has no plain-arithmetic reading`);

    const text = String(q.prompt ?? "");
    const query = BINARY_QUERY.exec(text);
    if (!query) return NOT_APPLICABLE("no 'a+b=?' query found");
    const naive = Number(query[1]) + Number(query[2]);

    const examples: Array<[number, number, number]> = [];
    for (const m of text.matchAll(BINARY_EXAMPLE)) examples.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    if (examples.length < 2) return NOT_APPLICABLE("fewer than two worked examples");

    // ENDORSED: an example that is true under the hidden rule AND under plain addition.
    const coincidence = examples.find(([a, b, c]) => a + b === c) ?? null;
    const endorsedBy = coincidence ? `${coincidence[0]}+${coincidence[1]}=${coincidence[2]}` : null;

    // OFFERED: the plain sum is selectable, and is not simply the right answer.
    const options = (q.options ?? []).map((o) => String(o ?? "").trim());
    const answer = String(q.answer ?? "").trim();
    const naiveOffered = options.includes(String(naive));
    const naiveIsAnswer = String(naive) === answer;

    if (naiveIsAnswer) {
      return { contested: false, naiveAnswer: String(naive), naiveOffered, endorsedBy,
        reason: `the plain sum ${naive} IS the official answer — nothing to argue about` };
    }
    const contested = naiveOffered && endorsedBy !== null;
    return {
      contested,
      naiveAnswer: String(naive),
      naiveOffered,
      endorsedBy,
      reason: contested
        ? `plain arithmetic gives ${naive}, which is offered as a distractor and endorsed by the worked example ${endorsedBy}`
        : !naiveOffered
          ? `plain arithmetic gives ${naive}, which is NOT offered — the trap is unreachable`
          : `plain arithmetic gives ${naive} and it is offered, but no worked example endorses that reading`,
    };
  } catch {
    return NOT_APPLICABLE("unparseable");
  }
}

/** The dimension + arm label, shared with the rollups and the promotion engine. */
export const CONTESTED_DIMENSION = "contested-answer";
export const CONTESTED_ARM = "contested-answer";
