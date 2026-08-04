/**
 * openingType.ts — the OPENING QUESTION TYPE experiment.
 *
 * THE LEVER, AND WHY IT IS THIS ONE. The account's reach is a retention story: 3-second
 * skip rate against reach is Spearman -0.71 across 126 live reels, monotonic over eight
 * buckets with a 10x spread. So the question is what holds the screen through those three
 * seconds, and the only thing on screen then is question one.
 *
 * The previous answer was its prompt LENGTH, and that finding was withdrawn (see
 * content/restore-prompts.mjs) because in this bank length is a deterministic function of
 * question TYPE: eight of twelve types ship exactly one prompt length and no type contains
 * both a short and a long opener, so "short opener" and "the odd-one-out family" were the
 * same set of posts. Rewording a prompt cannot change its type, so the intervention could
 * not act on whatever the gap was measuring.
 *
 * TYPE is the same signal with the confound removed from the DECISION rather than from the
 * data: you cannot make a verbal analogy short without turning it into notation an
 * eight-year-old has to learn first (339b6a4), but you can absolutely choose which type
 * opens the video. That choice is manipulable, supplied on both sides, and — because
 * cycle.ts already stamps the opening question's type on every record — labellable on
 * every post that has ever shipped.
 *
 * WHAT IT CANNOT SETTLE, stated here so nobody reads more out of the result than is in it.
 * Within the drawable pool the arms differ in length as well as in kind: odd-one-out opens
 * at 5 words, verbal analogy at 9, number analogy at 15. This experiment can establish
 * that opening TYPE moves skip rate; it cannot decompose that into "because it is an
 * analogy" and "because analogies take longer to read". That is a limit on the MECHANISM,
 * not on the decision, because the type is the thing a batch can actually choose. The
 * decomposition becomes available if the figure kinds ever enter the pinned format's kind
 * filter: FIGURE ANALOGY is an analogy at 5 words, and 95 of them are fresh.
 *
 * WHY BOTH ARMS ARE DERIVED, NOT DECLARED. The `opening` hook experiment failed as an
 * experiment because its labels went to hermes-data/metricool-scheduled.json while
 * ab-database.json — the store the rollups and the promotion path read — only ever saw one
 * side, and two analyses of the same experiment reached opposite conclusions. Here the arm
 * is a pure function of the question that actually shipped, computed in leadStamp()
 * alongside lead_type, so it is written to ab-database on EVERY record and cannot disagree
 * with the video it describes. There is no second store to fall out of sync.
 */

/** The dimension label, shared with the rollups and the Python promotion engine. */
export const OPENING_TYPE_DIMENSION = "opening-question-type";

export const OPEN_CONCRETE = "open-odd-one-out";
export const OPEN_ANALOGY = "open-analogy";

export type OpeningTypeArm = typeof OPEN_CONCRETE | typeof OPEN_ANALOGY;

/**
 * Which question types belong to which arm.
 *
 * ODD ONE OUT is alone on the concrete side and that is a supply fact, not a design
 * choice: the pinned format draws `text` and `numseries` kinds only, and of the four types
 * with fresh stock left (verbal analogy 308, number analogy 144, odd-one-out 140, number
 * puzzle 68) it is the only non-analogy that is neither a series nor a puzzle. The figure
 * types the brief also wanted on this side — visual odd-one-out, figure series, paper
 * folding — are outside that kind filter and cannot be rendered in the pinned format
 * today, so naming them here would produce an arm that silently never fills.
 *
 * NUMBER PUZZLE is deliberately in NEITHER arm. It is a third thing (a false-arithmetic
 * IF/THEN rule), and folding it into either side would make the contrast "analogy vs
 * everything else" rather than a comparison of two named kinds of opener. It stays fully
 * available as question two or three.
 */
export const OPENING_TYPE_TIERS: Record<OpeningTypeArm, readonly string[]> = {
  [OPEN_CONCRETE]: ["ODD ONE OUT", "VISUAL ODD ONE OUT", "FIGURE ODD"],
  [OPEN_ANALOGY]: ["VERBAL ANALOGY", "NUMBER ANALOGY", "FIGURE ANALOGY"],
};

export const OPENING_TYPE_ARMS: readonly OpeningTypeArm[] = [OPEN_CONCRETE, OPEN_ANALOGY];

/** Bank tiers arrive as "ODD ONE OUT", "odd-one-out" and "FIGURE-ANALOGY" all at once. */
function normTier(t: unknown): string {
  return String(t ?? "").trim().toUpperCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/**
 * The arm a shipped question belongs to, or null when it belongs to neither.
 *
 * Null is a real answer and is stored as one. A batch slot that fell back to NUMBER PUZZLE
 * because the arm's stock ran dry must not be silently counted into either side — that is
 * precisely how an arm ends up "winning" on posts it never ran.
 */
export function openingTypeArm(tier: unknown): OpeningTypeArm | null {
  const t = normTier(tier);
  if (!t) return null;
  for (const arm of OPENING_TYPE_ARMS) {
    if (OPENING_TYPE_TIERS[arm].some((x) => normTier(x) === t)) return arm;
  }
  return null;
}

/**
 * Assign an arm to each of `n` slots in a day's batch.
 *
 * BALANCED WITHIN THE DAY, not merely overall. This is the specific control that made the
 * underlying finding survive date confounding — skip rate on this account is 78% within-day
 * variance and only 22% between-day, and a design balanced only in aggregate can still hand
 * one arm the good days. Equal counts every single day is what removes date as an
 * explanation without needing to model it.
 *
 * INTERLEAVED, not blocked. Slots are consumed in order by planBatch, and slot index
 * decides both the posting time and the hashtag set (HASHTAG_ROTATION[i % 3]). Assigning
 * A,A,A,B,B,B would hand one arm the morning and one the evening, and — because 3 divides
 * the hashtag rotation — could hand one arm a single hashtag set outright. That is not
 * hypothetical: in the observational data the concrete arm already sits 8 of 10 in set A.
 * Alternating spreads both arms across every slot, time and tag set.
 *
 * `rotate` flips which arm takes slot 0, derived by the caller from the calendar day. With
 * an odd `n` the spare slot would otherwise go to the same arm every day, which is both an
 * imbalance and a standing correlation between that arm and the first slot of the morning.
 */
export function allocateOpeningTypes(n: number, rotate = 0): OpeningTypeArm[] {
  if (n <= 0) return [];
  const off = ((Math.trunc(rotate) % OPENING_TYPE_ARMS.length) + OPENING_TYPE_ARMS.length) % OPENING_TYPE_ARMS.length;
  return Array.from({ length: n }, (_, i) => OPENING_TYPE_ARMS[(i + off) % OPENING_TYPE_ARMS.length]);
}

/** How balanced an allocation actually is — used by the tests and the cycle's decision log. */
export function armCounts(arms: readonly (OpeningTypeArm | null)[]): Record<string, number> {
  const out: Record<string, number> = { [OPEN_CONCRETE]: 0, [OPEN_ANALOGY]: 0, unassigned: 0 };
  for (const a of arms) out[a ?? "unassigned"]++;
  return out;
}
