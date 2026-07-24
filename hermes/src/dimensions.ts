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
import type { HermesQ, ShapeKind } from "./state.ts";
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
  hook?: { title: string; subtitle: string };
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
  {
    ...BASE,
    dimension: "hook",
    arm: "hook-challenge",
    rationale: "hard-challenge opener vs neutral opener",
    hook: { title: "ONLY 1% PASS", subtitle: "can you get all 3?" },
  },
];

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
  return [CONTROL, ...narrationArms, ...endingArms, ...mascotArms, ...OTHER_DIMENSIONS, ...shapeDims];
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
}

export function newSpreadTally(): SpreadTally {
  return { tier: {}, kind: {} };
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
 */
export function selectSpread(pool: HermesQ[], numQ: number, batch: SpreadTally = newSpreadTally()): HermesQ[] {
  const chosen: HermesQ[] = [];
  const remaining = pool.map((q, i) => ({ q, i }));
  const vid = newSpreadTally();
  while (chosen.length < numQ && remaining.length > 0) {
    let bestPos = 0;
    let bestKey: number[] | null = null;
    for (let r = 0; r < remaining.length; r++) {
      const { q, i } = remaining[r];
      const t = q.tier ?? "";
      const k = q.kind ?? "";
      const key = [
        vid.tier[t] ?? 0,
        vid.kind[k] ?? 0,
        (batch.tier[t] ?? 0) + (vid.tier[t] ?? 0),
        (batch.kind[k] ?? 0) + (vid.kind[k] ?? 0),
        i,
      ];
      if (bestKey === null || lexLess(key, bestKey)) {
        bestKey = key;
        bestPos = r;
      }
    }
    const { q } = remaining.splice(bestPos, 1)[0];
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
