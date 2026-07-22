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
import {
  contentDefaults,
  narrationModeForArm,
  revealForEnding,
  NARRATION_ARMS,
  ENDING_ARMS,
  type ContentDefaults,
  type RevealMode,
  type NarrationArm,
  type EndingArm,
} from "./defaults.ts";

export interface DimSpec {
  dimension: string;
  arm: string; // canonical rollup label (shared with the Python promotion engine)
  rationale: string;
  numQ: number;
  category: "verbal" | "quantitative" | "mixed";
  kinds?: Array<"text" | "numseries">;
  showProgress: boolean;
  progressStyle: "short" | "full";
  countdownSec: number;
  hook?: { title: string; subtitle: string };
  // At most ONE of these is set per spec — the single axis this arm deviates from
  // the current defaults. Unset => inherit the current default for that axis.
  narrationArm?: NarrationArm; // set only on NARRATION test arms
  endingArm?: EndingArm; // set only on ENDING test arms
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
  return [CONTROL, ...narrationArms, ...endingArms, ...OTHER_DIMENSIONS];
}

/** The effective render axes for a spec under the CURRENT defaults. */
export interface ResolvedArm {
  narrationArm: NarrationArm;
  narration: NarrationMode;
  endingArm: EndingArm;
  reveal: RevealMode;
}

/**
 * Apply the current defaults, letting the spec override AT MOST ONE axis (the arm
 * under test). This is what makes every non-tested video a true baseline and the
 * arm-under-test the only deviation.
 */
export function resolveArm(spec: DimSpec, defaults: ContentDefaults): ResolvedArm {
  const narrationArm = spec.narrationArm ?? defaults.narration;
  const endingArm = spec.endingArm ?? defaults.ending;
  return {
    narrationArm,
    narration: narrationModeForArm(narrationArm),
    endingArm,
    reveal: revealForEnding(endingArm),
  };
}

/** Which single axis an arm deviates from the defaults. */
export function deviatesAxis(spec: DimSpec): "narration" | "ending" | "other" | "none" {
  if (spec.dimension === "control") return "none";
  if (spec.narrationArm) return "narration";
  if (spec.endingArm) return "ending";
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
  /** which single axis this arm deviates from the defaults. */
  deviates: "narration" | "ending" | "other" | "none";
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
      deviates: deviatesAxis(d),
      showProgress: d.showProgress,
      progressStyle: d.progressStyle,
      reveal: resolved.reveal,
      countdownSec: d.countdownSec,
    };
  });
}
