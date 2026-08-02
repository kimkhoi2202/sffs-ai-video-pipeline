/**
 * dimensions.ts — the A/B DIMENSION catalog + its resolution against the current
 * content defaults. Split out of design.ts on purpose so it is DEPENDENCY-FREE
 * (node builtins only, via defaults.ts/state.ts/config.ts): design.ts also pulls in
 * the LLM/gates/brand chain (needs `openai` etc.), which the hermetic build has no
 * node_modules for. Keeping the catalog here means `sffs_design catalog` and the
 * introspection probe can run OFFLINE, and the promotion engine's arm labels line
 * up with what the designer actually renders.
 *
 * The baseline (control) = the current defaults (full narration + cliffhanger).
 * Each arm deviates AT MOST ONE axis from those defaults. The narration + ending
 * test arms are GENERATED from the arm universe minus the current default, so:
 *   - the arm that currently IS the default is never re-listed (it's the control), and
 *   - after a human-approved promotion flips a default, the OLD default automatically
 *     becomes a testable challenger again (governed, never stuck).
 * See defaults.ts.
 */
import { type NarrationMode } from "./narration.ts";
import { hookArms } from "./hooks.ts";
import type { HermesQ, ShapeKind } from "./state.ts";
import { bandOf, promptWords, type LeadBand } from "./leadPolicy.ts";
import {
  contentDefaults,
  narrationModeForArm,
  revealForEnding,
  mascotModeForArm,
  NARRATION_ARMS,
  ENDING_ARMS,
  MASCOT_ARMS,
  type ContentDefaults,
  type RevealMode,
  type NarrationArm,
  type EndingArm,
  type MascotArm,
} from "./defaults.ts";

export interface DimSpec {
  dimension: string;
  arm: string; // canonical rollup label (shared with the Python promotion engine)
  rationale: string;
  numQ: number;
  category: "verbal" | "quantitative" | "mixed" | "nonverbal";
  kinds?: Array<"text" | "numseries" | ShapeKind>;
  showProgress: boolean;
  progressStyle: "short" | "full";
  countdownSec: number;
  /** OPENING arms only. "motion-hook" prepends the 2.2s wordless animation. */
  opening?: "cold-plate" | "motion-hook";
  /** SPOKEN-hook arms only: which ab-testing/hook-bank.json mechanism this arm
   *  exercises. design.ts resolves it to a concrete line per video (pickHook), which
   *  is then spoken OVER the animation rather than in front of it. */
  hookMechanism?: string;
  // At most ONE of these is set per spec — the single axis this arm deviates from
  // the current defaults. Unset => inherit the current default for that axis.
  narrationArm?: NarrationArm; // set only on NARRATION test arms
  endingArm?: EndingArm; // set only on ENDING test arms
  mascotArm?: MascotArm; // set only on MASCOT test arms
}

export const BASE = {
  numQ: 3,
  category: "mixed" as const,
  showProgress: true,
  progressStyle: "short" as const,
  countdownSec: 5,
};

/** Per-arm copy for the generated NARRATION test arms (verbal/text so options exist). */
const NARRATION_ARM_META: Record<NarrationArm, string> = {
  "full": "full cloned-voice narration (host reads the stem + options aloud)",
  "no-narration": "music-only, no voiceover",
  "no-question-vo": "voice the OPTIONS only; the question shows but is not read",
  "no-options-vo": "voice the QUESTION only; the options show but are not read",
};

/** Per-arm copy for the generated ENDING test arms. */
const ENDING_ARM_META: Record<EndingArm, string> = {
  "cliffhanger": "reveal the early questions, withhold the LAST + comment-CTA (no score screen)",
  "full-reveal": "reveal EVERY answer (full-reveal / score-screen style)",
  "no-answer": "never reveal any answer; comment-for-answer on every question",
};

/** Per-arm copy for the generated MASCOT test arms (the brand brain on the intro
 *  cover + outro). "mascot-standard" is the always-on baseline (never re-listed). */
const MASCOT_ARM_META: Record<MascotArm, string> = {
  "mascot-standard": "the brand brain mascot as today (intro cover + outro sticker)",
  "mascot-absent": "HIDE the brand brain mascot (no brain on the intro cover or outro) — the clean no-mascot control",
  "mascot-prominent": "ENLARGE the brand brain mascot (bigger on the intro cover + outro) — the more-mascot arm",
};

/** The mascot dimension label (shared with promote.py). */
export const MASCOT_DIMENSION = "mascot";
/** Canonical preference order for the mascot challenger arms when weighting the
 *  batch: prominent FIRST (the user wants MORE mascot), absent kept every cycle as
 *  the no-mascot control. Only arms actually generated (universe minus the current
 *  default) are used. */
const MASCOT_ARM_PRIORITY: readonly MascotArm[] = ["mascot-prominent", "mascot-absent", "mascot-standard"];

/** The control/baseline spec (= the current defaults; deviates nothing). */
const CONTROL: DimSpec = {
  ...BASE,
  dimension: "control",
  arm: "control",
  rationale: "baseline: the current defaults (full narration + cliffhanger ending), short counter, 5s, mixed 3Q",
};

// ---------------------------------------------------------------------------
// THE PINNED FORMAT — exploitation, not exploration (2026-08-02)
//
// Testing is over. Every slot now runs ONE format, chosen from what the live
// Instagram numbers actually say rather than from the rollups.
//
// WHAT THE DATA SAID. Across all 114 published reels the account's median is 187
// views and the best is 1,825. Sorting by every axis the rotation was varying —
// opening, narration, ending, mascot, tempo, hashtag set, caption wording — moved
// the median by tens of views on single-digit samples, and the same caption line
// appears at 1,028 views and at 98. One axis was not like the others:
//
//     3-second skip rate     median views
//     under 50%                    1,556   (n=2)
//     50-55%                       1,310   (n=10)
//     55-60%                       1,028   (n=9)
//     60-65%                         337   (n=16)
//     65-70%                         165   (n=17)
//     70-75%                         172   (n=16)
//     75-80%                         160   (n=24)
//     80%+                           141   (n=20)
//
// Monotonic over eight buckets and a 10x spread, with average watch time tracking
// it exactly. The top five posts sit at 48.6-55% skip against an account median of
// 71%. Views on this account are a retention story, and every top performer is the
// SAME shape: three questions, cold plate, narrated, cliffhanger, branded cover.
//
// So the pinned format IS that shape. Two things it deliberately is NOT:
//
//   - It is not the rotation's winner. The arms the batch was concentrated on
//     (motion-hook and the spoken-hook family) are the WORST measured openings —
//     the wordless motion arm spends 2.2 seconds before question one and medians
//     137 views against the cold plate's 159. Those are removed.
//   - It is not a fixed VIDEO. The structure is held; the questions inside it are
//     freshly generated and still pass dedup, near-duplicate and quality gates
//     every cycle. A straight repost earned 6 views once, and near-duplicates are
//     what unoriginal-content detection is built to catch.
//
// Anything below that a future measurement contradicts is one edit here.
// ---------------------------------------------------------------------------

/** The single rollup label every pinned post carries. There is nothing to rotate. */
export const PINNED_ARM = "pinned-format";

/**
 * The format every slot runs. Inherits the current content defaults for narration,
 * ending and mascot (full / cliffhanger / prominent) by setting none of those axes,
 * so the human promotion CLI remains the one way any of them ever changes.
 *
 * `opening` is pinned EXPLICITLY to cold-plate rather than left undefined, because
 * undefined is what the hook arms were injected into.
 */
export const PINNED: DimSpec = {
  ...BASE, // 3 questions, mixed, progress on + short, 5s countdown
  dimension: "pinned",
  arm: PINNED_ARM,
  opening: "cold-plate",
  rationale:
    "PINNED production format: 3 mixed questions, cold-plate open (no pre-roll animation), full narration, " +
    "cliffhanger ending, short progress counter, 5s per question, branded cover. The shape every top-performing " +
    "reel shares; fresh questions inside it every time.",
};

/** `target` slots of the pinned format. The whole batch designer, now. */
export function pinnedSpecs(target: number): DimSpec[] {
  return target <= 0 ? [] : Array.from({ length: target }, () => ({ ...PINNED }));
}

/** Dimensions that inherit BOTH defaults and deviate only their own axis. */
const OTHER_DIMENSIONS: DimSpec[] = [
  {
    ...BASE,
    dimension: "progress-counter",
    arm: "progress-hidden",
    rationale: "retention test: hide the QUESTION x/N pill (defaults: full narration + cliffhanger)",
    showProgress: false,
  },
  {
    ...BASE,
    dimension: "progress-counter",
    arm: "progress-verbose",
    rationale: "retention test: full 'QUESTION 1 OF 3' vs short 'Q1'",
    progressStyle: "full",
  },
  { ...BASE, dimension: "tempo", arm: "tempo-fast", rationale: "speed test: 3s countdown (faster pace)", countdownSec: 3 },
  { ...BASE, dimension: "tempo", arm: "tempo-slow", rationale: "patience test: 7s countdown (more solve time)", countdownSec: 7 },
  {
    ...BASE,
    dimension: "length",
    arm: "one-question",
    rationale: "single-question payoff vs three (the cliffhanger default collapses to withholding the one verdict + comment-CTA)",
    numQ: 1,
  },
  {
    ...BASE,
    dimension: "category-mix",
    arm: "verbal-only",
    rationale: "verbal-only (odd-one-out / analogy)",
    category: "verbal",
    kinds: ["text"],
  },
  {
    ...BASE,
    dimension: "category-mix",
    arm: "quant-only",
    rationale: "quantitative-only (number series)",
    category: "quantitative",
    kinds: ["numseries"],
  },
];

/**
 * The OPENING dimension: what a short shows before question one.
 *
 * The campaign measured the first two arms over 41 matured posts and the wordless
 * motion opening LOST to the cold plate by 5.6 percentage points of skip rate. The
 * likely reason is arithmetic rather than aesthetic: it spends 2.2 seconds on
 * animation that carries no information, and the median viewer leaves at three.
 *
 * So the third family of arms does not add time, it makes the existing time work. The
 * SAME 2.2s animation now carries a spoken hook and a title in place of its wordless
 * "?", so question one arrives at exactly the moment it already does on the motion arm.
 * Everything sits on ONE axis on purpose:
 *
 *   cold-plate                control, question one at 0.00s
 *   motion-hook               today's wordless arm, question one at 2.20s
 *   motion-hook-<mechanism>   same 2.2s, now carrying a payload, question one at 2.20s
 *
 * motion-hook vs motion-hook-<mechanism> isolates the PAYLOAD with the animation held
 * constant; either against cold-plate isolates the whole opening. A hook can only ever
 * ride the motion arm: on cold-plate it would have to be serial, which is the delay we
 * are removing, so render.ts makes that combination unrepresentable rather than merely
 * discouraged.
 *
 * Replaces the old `hook` dimension, whose single "ONLY 1% PASS" arm never rendered
 * anything (shortProps dropped title/subtitle and shorts were unconditionally
 * cold-open), so there is no rollup history to preserve.
 */
function openingDimensions(): DimSpec[] {
  const wordless: DimSpec = {
    ...BASE,
    dimension: "opening",
    arm: "motion-hook",
    opening: "motion-hook",
    rationale: "2.2s wordless motion opening before question one (vs the cold-plate control)",
  };
  const spoken: DimSpec[] = hookArms().map(({ mechanism, arm }) => ({
    ...BASE,
    dimension: "opening",
    arm,
    opening: "motion-hook",
    hookMechanism: mechanism,
    rationale: `the same 2.2s motion opening, now carrying a spoken '${mechanism}' hook (question one does not move)`,
  }));
  return [wordless, ...spoken];
}

/**
 * The NONVERBAL SHAPE/FIGURE dimension: paper-folding + the figure-matrix family
 * (matrix / analogy2 / figure-odd). Its answer options are FIGURES, not text, so
 * the render path (render.ts mapProps) voices only the PROMPT (+ the reveal
 * ansLabel) and never the options — no per-option TTS. It inherits the current
 * narration + ending defaults (deviates only the question TYPE axis), so it stays
 * a clean single-axis "other" dimension alongside category-mix.
 */
const SHAPE_DIMENSION: DimSpec = {
  ...BASE,
  dimension: "type-nonverbal-shapes",
  arm: "shapes",
  rationale:
    "nonverbal variety: paper-folding + figure matrix/analogy/odd-one-out (options are figures; prompt-only VO)",
  category: "nonverbal",
  kinds: ["fold", "matrix", "analogy2", "figure-odd"],
};

/**
 * The CLASSIC nonverbal dimension: the legacy dot (position) / shaded (figure
 * analogy) / polygon (figure series) kinds, UNLOCKED via legacyShapes.ts (compact
 * bank codes -> structured figure + deterministic A-D options). Like the shape
 * dimension its options are figures, so the render path voices only the prompt.
 * This is the BULK of the bank (~300 fresh entries), so a distinct dimension keeps
 * it flowing into the rotation instead of being starved by the 5-each new types.
 */
const CLASSIC_SHAPE_DIMENSION: DimSpec = {
  ...BASE,
  dimension: "type-nonverbal-classic",
  arm: "classic-shapes",
  rationale:
    "classic nonverbal variety: dot position / shaded figure-analogy / polygon figure-series (options are figures; prompt-only VO)",
  category: "nonverbal",
  kinds: ["dot", "shaded", "polygon"],
};

/**
 * Whether the nonverbal shape dimension is ELIGIBLE this run. Default ON (the
 * FullVideo render path for shapes is proven). Set HERMES_ENABLE_SHAPE_QUESTIONS
 * to 0/false/off/no to force it OFF — a kill switch that leaves the loop's
 * text/numseries behavior completely unchanged.
 */
export function shapeQuestionsEnabled(): boolean {
  const v = (process.env.HERMES_ENABLE_SHAPE_QUESTIONS ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * Build the rotating dimension catalog for the CURRENT defaults: control first,
 * then the narration + ending challengers (arm universe minus the current default),
 * then the other single-axis dimensions.
 */
export function buildDimensions(defaults: ContentDefaults = contentDefaults()): DimSpec[] {
  const narrationArms: DimSpec[] = NARRATION_ARMS.filter((a) => a !== defaults.narration).map((a) => ({
    ...BASE,
    dimension: "narration",
    arm: a,
    narrationArm: a,
    rationale: `TEST ARM vs the '${defaults.narration}' narration default: ${NARRATION_ARM_META[a]} (keeps the ${defaults.ending} ending)`,
    // verbal/text so every question has A–D options (clean stem-vs-options split)
    category: "verbal",
    kinds: ["text"],
  }));
  const endingArms: DimSpec[] = ENDING_ARMS.filter((a) => a !== defaults.ending).map((a) => ({
    ...BASE,
    dimension: "ending",
    arm: a,
    endingArm: a,
    rationale: `TEST ARM vs the '${defaults.ending}' ending default: ${ENDING_ARM_META[a]} (keeps ${defaults.narration} narration)`,
  }));
  // MASCOT challengers: the arm universe minus the current mascot default. Each
  // deviates ONLY the mascot axis (keeps the narration + ending defaults), so a
  // mascot video is otherwise a clean baseline. Promotable like narration/ending.
  const mascotArms: DimSpec[] = MASCOT_ARMS.filter((a) => a !== defaults.mascot).map((a) => ({
    ...BASE,
    dimension: MASCOT_DIMENSION,
    arm: a,
    mascotArm: a,
    rationale: `TEST ARM vs the '${defaults.mascot}' mascot default: ${MASCOT_ARM_META[a]} (keeps ${defaults.narration} narration + ${defaults.ending} ending)`,
  }));
  // The nonverbal shape dimensions are appended only when enabled (default ON;
  // HERMES_ENABLE_SHAPE_QUESTIONS=0 removes them and restores the exact prior list).
  // Both the FigState family (shapes) and the unlocked legacy classic kinds.
  const shapeDims: DimSpec[] = shapeQuestionsEnabled() ? [SHAPE_DIMENSION, CLASSIC_SHAPE_DIMENSION] : [];
  return [CONTROL, ...narrationArms, ...endingArms, ...mascotArms, ...OTHER_DIMENSIONS, ...openingDimensions(), ...shapeDims];
}

/**
 * Targeted / showcase batch overrides for planBatch (PURE + env-free, so it stays
 * unit-testable). BOTH options empty/undefined => the catalog is returned UNCHANGED
 * (a copy), so the default loop and its tests are byte-for-byte unaffected. Used to
 * drive a deliberate, reviewable DRAFT batch that features specific dimensions —
 * e.g. the nonverbal SHAPE types — instead of the seeded rotation.
 *
 *   only      — restrict the catalog to these dimension OR arm names, in the given
 *               order (unknown names are skipped; a name may repeat). Empty => no
 *               restriction.
 *   shapeNumQ — override the nonverbal-shape dimension's question count (e.g. 4 so a
 *               single showcase video carries all four shape kinds). Ignored unless
 *               a positive integer.
 */
export function applyBatchOverrides(
  catalog: DimSpec[],
  opts: { only?: string[]; shapeNumQ?: number } = {},
): DimSpec[] {
  const only = (opts.only ?? []).map((s) => s.trim()).filter(Boolean);
  let out = only.length
    ? only
        .map((name) => catalog.find((d) => d.dimension === name || d.arm === name))
        .filter((d): d is DimSpec => Boolean(d))
    : catalog.slice();
  const n = opts.shapeNumQ;
  if (typeof n === "number" && Number.isInteger(n) && n > 0) {
    out = out.map((d) => (d.dimension === SHAPE_DIMENSION.dimension ? { ...d, numQ: n } : d));
  }
  return out;
}

/**
 * Fill `target` slots from a RESTRICTED catalog by cycling it, balanced.
 *
 * Why this exists. `applyBatchOverrides({only})` returns one spec per named arm, and
 * planBatch then took `.slice(0, target)`. Pinning three arms therefore produced a batch
 * of THREE videos rather than twelve: the override silently cut the day's output to a
 * quarter. Worse, it did the opposite of what an operator asks it for — concentrating
 * onto three arms to reach a conclusion FASTER instead yielded one post per arm per day
 * instead of four, so the sample took longer to mature.
 *
 * Concentration must change WHICH arms run, never HOW MANY posts run. So a restricted
 * catalog is cycled round-robin up to target, which also makes the arms balanced by
 * construction: 12 slots over 3 arms is exactly 4 each, and any remainder is spread one
 * per arm rather than piled on the first. A catalog at or above target is unchanged.
 */
export function cycleToTarget(specs: DimSpec[], target: number): DimSpec[] {
  if (target <= 0 || specs.length === 0) return [];
  if (specs.length >= target) return specs.slice(0, target);
  const out: DimSpec[] = [];
  for (let i = 0; i < target; i++) out.push(specs[i % specs.length]);
  return out;
}

/** Default number of MASCOT slots forced into every batch (weight). Elevated out of
 *  the seeded random subset so the mascot dimension is measured EVERY cycle. */
export const MASCOT_WEIGHT_DEFAULT = 3;

/**
 * Bias a seeded batch toward the mascot dimension (Part B: "test MORE mascot").
 * Guarantees the mascot CHALLENGER arms run EVERY cycle (elevated out of the seeded
 * `.slice(0, target)` subset) and gives them `weight` of the batch's slots, cycling
 * the arms in MASCOT_ARM_PRIORITY order (prominent-first = more mascot, with the
 * absent control kept every cycle). Remaining slots keep the original seeded order
 * (mascot specs removed so they are not double-counted). Pure + deterministic.
 * `weight <= 0` disables the bias (returns the plain seeded slice); a batch with no
 * mascot challengers is returned unchanged. Total length is always <= target, so the
 * 12/day/platform posting cap is untouched.
 */
export function elevateMascot(seeded: DimSpec[], target: number, weight: number = MASCOT_WEIGHT_DEFAULT): DimSpec[] {
  if (target <= 0) return [];
  const mascot = seeded.filter((d) => d.dimension === MASCOT_DIMENSION);
  if (weight <= 0 || mascot.length === 0) return seeded.slice(0, target);
  const ordered = mascot.slice().sort((a, b) => {
    const ia = MASCOT_ARM_PRIORITY.indexOf(a.arm as MascotArm);
    const ib = MASCOT_ARM_PRIORITY.indexOf(b.arm as MascotArm);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const slots = Math.min(weight, target);
  const front: DimSpec[] = [];
  for (let i = 0; i < slots; i++) front.push({ ...ordered[i % ordered.length] });
  const rest = seeded.filter((d) => d.dimension !== MASCOT_DIMENSION);
  return [...front, ...rest].slice(0, target);
}

/** The effective render axes for a spec under the CURRENT defaults. */
export interface ResolvedArm {
  narrationArm: NarrationArm;
  narration: NarrationMode;
  endingArm: EndingArm;
  reveal: RevealMode;
  mascotArm: MascotArm;
  mascot: "standard" | "absent" | "prominent";
}

/**
 * Apply the current defaults, letting the spec override AT MOST ONE axis (the arm
 * under test). This is what makes every non-tested video a true baseline and the
 * arm-under-test the only deviation.
 */
export function resolveArm(spec: DimSpec, defaults: ContentDefaults): ResolvedArm {
  const narrationArm = spec.narrationArm ?? defaults.narration;
  const endingArm = spec.endingArm ?? defaults.ending;
  const mascotArm = spec.mascotArm ?? defaults.mascot;
  return {
    narrationArm,
    narration: narrationModeForArm(narrationArm),
    endingArm,
    reveal: revealForEnding(endingArm),
    mascotArm,
    mascot: mascotModeForArm(mascotArm),
  };
}

// ---------------------------------------------------------------------------
// Question TYPE variety (P1): per-video type/tier spread + per-batch
// anti-clustering. Complements the fuzzy near-dup guard in questions.ts — that
// stops duplicate/near-dup QUESTIONS; this stops a video being all one TYPE and
// the day's batch clustering the same few types.
//
// `tier` is the question TYPE (ODD ONE OUT / VERBAL ANALOGY / NUMBER SERIES /
// NUMBER ANALOGY / …), so spreading on tier maximizes on-screen variety within a
// video AND balances type coverage across the batch (the seeded pool otherwise
// over-samples the biggest bucket). Pure + deterministic — ties break on the
// candidate's position in the already-seeded pool, so a resumed run reselects
// identically.
// ---------------------------------------------------------------------------

/** Running per-batch tally of how many questions of each tier/kind were used. */
export interface SpreadTally {
  tier: Record<string, number>;
  kind: Record<string, number>;
  /** how many videos this batch have OPENED with each tier (see leadTypeCap). */
  lead?: Record<string, number>;
}

export function newSpreadTally(): SpreadTally {
  return { tier: {}, kind: {}, lead: {} };
}

/**
 * The most videos in one batch that may OPEN with the same question type.
 *
 * Retention evidence and content variety pull against each other here, and this is where
 * the trade is made explicit. The evidence (leadPolicy.ts) says short prompts retain
 * ~9 points better, but the only short-prompt type the renderable pool can currently
 * supply is odd-one-out: number series exist in the bank in quantity and are then
 * collapsed by the near-duplicate guard to ~20 distinct step patterns, all of which have
 * already been published, and the figure types are not in the pinned format's kind
 * filter. So "follow the evidence" and "open six of twelve videos with the same line"
 * are, right now, the same instruction.
 *
 * 40% rounded up — five of a twelve-video day. That is deliberately looser than today's
 * incidental four and deliberately tighter than the 55% band cap, because a question TYPE
 * is the unit a viewer actually recognises. The dedup and near-duplicate gates already
 * guarantee no two videos share a QUESTION; this guards the softer thing they cannot see,
 * which is the batch opening the same way over and over.
 */
export const LEAD_TYPE_CAP_SHARE = 0.4;

export function leadTypeCap(target: number): number {
  return Math.max(1, Math.ceil(LEAD_TYPE_CAP_SHARE * Math.max(1, target)));
}

/** Lexicographic "a < b" over equal-length numeric tuples. */
function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

/**
 * Greedily pick `numQ` questions from an ALREADY-FILTERED, seeded `pool`
 * (candidateQuestions output) to maximize per-video TYPE/tier spread and, across
 * the whole batch, avoid clustering the same types. Mutates `batch` with the picks
 * so later videos in the same batch are balanced against them.
 *
 * Each pick minimizes this lexicographic key:
 *   1. count of this tier ALREADY in THIS video  (per-video type spread)
 *   2. count of this kind  already in this video  (per-video kind spread)
 *   3. count of this tier across the batch so far (anti-clustering)
 *   4. count of this kind across the batch so far
 *   5. original pool index                         (stable, deterministic)
 *
 * Returns fewer than `numQ` only when the pool is too small (the caller drops the
 * video, exactly as before). Never repeats a pool entry.
 *
 * THE OPENING SLOT is the one place retention evidence gets to choose. `leadPrefs` is
 * a PREFERENCE ORDER of prompt-length bands, best first: the first pick is restricted
 * to the first band that can still supply a question, and everything after it is
 * unchanged. The opening question is what occupies the screen during the three seconds
 * where ~70% of viewers leave, and its prompt length is the only property of it that
 * measurably tracks skip rate (leadPolicy.ts). In-video variety is untouched.
 *
 * Two things bound the steer, and both are deliberate:
 *
 *   `cap` — the most videos in this batch that may open with the same TYPE (see
 *   leadTypeCap). A band whose supply is one type would otherwise take every slot the
 *   policy gives it, which is the variety collapse the exploration floor exists to stop.
 *   Types already at the cap are removed from the OPENING candidates only; they can
 *   still appear as question two or three.
 *
 *   Falling back. A band with nothing fresh left, or nothing under the cap, yields to
 *   the next band in `leadPrefs`, and if every band is exhausted the pick reverts to the
 *   normal ordering. The policy never costs the day a video: quality, freshness and
 *   shipping all outrank it.
 */
export function selectSpread(
  pool: HermesQ[],
  numQ: number,
  batch: SpreadTally = newSpreadTally(),
  leadPrefs?: LeadBand[],
  cap = Infinity,
): HermesQ[] {
  const chosen: HermesQ[] = [];
  const remaining = pool.map((q, i) => ({ q, i }));
  const vid = newSpreadTally();
  const leadTally = (batch.lead = batch.lead ?? {});

  while (chosen.length < numQ && remaining.length > 0) {
    let candidates = remaining;
    if (chosen.length === 0 && leadPrefs?.length) {
      const underCap = remaining.filter((r) => (leadTally[r.q.tier ?? ""] ?? 0) < cap);
      for (const band of leadPrefs) {
        const inBand = underCap.filter((r) => bandOf(promptWords(r.q.prompt)) === band);
        if (inBand.length) {
          candidates = inBand;
          break;
        }
      }
      if (candidates === remaining && underCap.length) candidates = underCap;
    }
    let best = candidates[0];
    let bestKey: number[] | null = null;
    for (const cand of candidates) {
      const { q, i } = cand;
      const t = q.tier ?? "";
      const k = q.kind ?? "";
      const key = [
        // On the OPENING pick, rotate types that have not opened a video yet before
        // anything else — so a band with several usable types spreads across them
        // instead of exhausting the first one the seeded pool happens to offer.
        ...(chosen.length === 0 && leadPrefs?.length ? [leadTally[t] ?? 0] : []),
        vid.tier[t] ?? 0,
        vid.kind[k] ?? 0,
        (batch.tier[t] ?? 0) + (vid.tier[t] ?? 0),
        (batch.kind[k] ?? 0) + (vid.kind[k] ?? 0),
        i,
      ];
      if (bestKey === null || lexLess(key, bestKey)) {
        bestKey = key;
        best = cand;
      }
    }
    remaining.splice(remaining.indexOf(best), 1);
    const q = best.q;
    if (chosen.length === 0) leadTally[q.tier] = (leadTally[q.tier] ?? 0) + 1;
    chosen.push(q);
    vid.tier[q.tier] = (vid.tier[q.tier] ?? 0) + 1;
    vid.kind[q.kind] = (vid.kind[q.kind] ?? 0) + 1;
  }
  for (const q of chosen) {
    batch.tier[q.tier] = (batch.tier[q.tier] ?? 0) + 1;
    batch.kind[q.kind] = (batch.kind[q.kind] ?? 0) + 1;
  }
  return chosen;
}

/** Which single axis an arm deviates from the defaults. */
export function deviatesAxis(spec: DimSpec): "narration" | "ending" | "mascot" | "other" | "none" {
  if (spec.dimension === "control") return "none";
  if (spec.narrationArm) return "narration";
  if (spec.endingArm) return "ending";
  if (spec.mascotArm) return "mascot";
  return "other";
}

/** A read-only entry in the A/B dimension catalog (one variable axis per entry). */
export interface DimensionInfo {
  dimension: string;
  arm: string;
  rationale: string;
  /** true for the control/baseline entry (= the current defaults). */
  baseline: boolean;
  numQ: number;
  category: string;
  /** the effective narration MODE under the current defaults. */
  narration: NarrationMode;
  /** the effective narration ARM label (equals the default unless this arm tests it). */
  narration_arm: NarrationArm;
  /** the effective ending ARM label (equals the default unless this arm tests it). */
  ending: EndingArm;
  /** the effective mascot ARM label (equals the default unless this arm tests it). */
  mascot: MascotArm;
  /** which single axis this arm deviates from the defaults. */
  deviates: "narration" | "ending" | "mascot" | "other" | "none";
  showProgress: boolean;
  progressStyle: string;
  reveal: RevealMode;
  countdownSec: number;
}

/**
 * Read-only view of the A/B dimension catalog resolved against the CURRENT content
 * defaults. Runs NO LLM and makes NO network call — it surfaces the dimension table
 * (defaults applied) so the agent can confirm the baseline = full narration +
 * cliffhanger and every arm = a single-axis deviation.
 */
export function dimensionCatalog(defaults: ContentDefaults = contentDefaults()): DimensionInfo[] {
  return buildDimensions(defaults).map((d) => {
    const resolved = resolveArm(d, defaults);
    return {
      dimension: d.dimension,
      arm: d.arm,
      rationale: d.rationale,
      baseline: d.dimension === "control",
      numQ: d.numQ,
      category: d.category,
      narration: resolved.narration,
      narration_arm: resolved.narrationArm,
      ending: resolved.endingArm,
      mascot: resolved.mascotArm,
      deviates: deviatesAxis(d),
      showProgress: d.showProgress,
      progressStyle: d.progressStyle,
      reveal: resolved.reveal,
      countdownSec: d.countdownSec,
    };
  });
}
