/**
 * defaults.ts — the CONTENT baseline defaults + the A/B arm universe, in ONE place.
 *
 * WHAT CHANGED (iteration: content defaults + human default-promotion):
 *   The loop used to bake the baseline into design.ts BASE (music-only narration,
 *   reveal="all"). The new baseline is: NARRATE every video (narration="full") and
 *   END every video on a CLIFFHANGER (reveal the early questions, withhold the last
 *   + comment-CTA, no score screen). The "control/baseline" video is now exactly
 *   full-narration + cliffhanger, and the old behaviours (no narration, full-reveal,
 *   no-answer) are TEST ARMS that each deviate ONE axis from these defaults.
 *
 * SOURCE OF TRUTH:
 *   - The *current* default VALUES (narration/ending arm labels) live in the durable
 *     config file ab-testing/content-defaults.json (CONFIG.CONTENT_DEFAULTS). The ONLY
 *     writer of that file is the HUMAN approval CLI (sffs_promote_default --approve);
 *     the autonomous loop never flips a default. This module READS it (with safe
 *     hardcoded fallbacks) so a promoted default takes effect on the next design pass.
 *   - The arm UNIVERSE (which arms exist per dimension + how each arm maps to the
 *     HermesQuiz render props) is a code constant here, mirrored in the Python
 *     promotion engine (hermes-nous/sffs/promote.py) which shares the same arm labels.
 *
 * This module is render-side only — it has NO Publer/create/schedule/publish path.
 */
import { readJSON } from "./state.ts";
import { CONFIG } from "./config.ts";
import { type NarrationMode } from "./narration.ts";

/** RevealMode as consumed by remotion/hermes/HermesQuiz.tsx (unchanged contract). */
export type RevealMode = "all" | "none" | "last";

/** Canonical ENDING arm labels (map onto RevealMode for the composition). */
export type EndingArm = "cliffhanger" | "full-reveal" | "no-answer";
/** Canonical NARRATION arm labels (map onto NarrationMode). */
export type NarrationArm = "full" | "no-narration" | "no-question-vo" | "no-options-vo";

export interface ContentDefaults {
  /** current NARRATION default (arm label). */
  narration: NarrationArm;
  /** current ENDING default (arm label). */
  ending: EndingArm;
}

/** The HARDCODED fallback defaults (used if content-defaults.json is missing/corrupt). */
export const FALLBACK_DEFAULTS: ContentDefaults = Object.freeze({
  narration: "full",
  ending: "cliffhanger",
});

// ── The A/B arm universe (labels are stable; they are the rollup keys the Python
//    promotion engine compares, so keep them in sync with promote.py) ───────────

/** narration arm label -> the NarrationMode the render/composition consumes. */
export const NARRATION_ARM_TO_MODE: Readonly<Record<NarrationArm, NarrationMode>> = Object.freeze({
  "full": "full",
  "no-narration": "none",
  "no-question-vo": "no-question-vo",
  "no-options-vo": "no-options-vo",
});

/** ending arm label -> the RevealMode the composition consumes.
 *  cliffhanger -> "last"  (reveal all but the last; on a 1-Q video this collapses to
 *                          "reveal nothing" = withhold the single verdict + comment-CTA)
 *  full-reveal -> "all"   (reveal every answer; the old baseline / "score" style)
 *  no-answer   -> "none"  (never reveal; comment-for-answer on every question) */
export const ENDING_ARM_TO_REVEAL: Readonly<Record<EndingArm, RevealMode>> = Object.freeze({
  "cliffhanger": "last",
  "full-reveal": "all",
  "no-answer": "none",
});

export const NARRATION_ARMS: readonly NarrationArm[] = Object.freeze(
  Object.keys(NARRATION_ARM_TO_MODE) as NarrationArm[],
);
export const ENDING_ARMS: readonly EndingArm[] = Object.freeze(
  Object.keys(ENDING_ARM_TO_REVEAL) as EndingArm[],
);

function isNarrationArm(v: unknown): v is NarrationArm {
  return typeof v === "string" && v in NARRATION_ARM_TO_MODE;
}
function isEndingArm(v: unknown): v is EndingArm {
  return typeof v === "string" && v in ENDING_ARM_TO_REVEAL;
}

/**
 * Resolve the CURRENT content defaults from ab-testing/content-defaults.json,
 * falling back to FALLBACK_DEFAULTS for any missing/invalid field. Pure read.
 */
export function contentDefaults(path: string = CONFIG.CONTENT_DEFAULTS): ContentDefaults {
  const raw = readJSON<{ defaults?: Partial<ContentDefaults> }>(path, {});
  const d = raw?.defaults ?? {};
  return {
    narration: isNarrationArm(d.narration) ? d.narration : FALLBACK_DEFAULTS.narration,
    ending: isEndingArm(d.ending) ? d.ending : FALLBACK_DEFAULTS.ending,
  };
}

/** NarrationMode for a narration arm label (safe fallback to the default mode). */
export function narrationModeForArm(arm: string): NarrationMode {
  return isNarrationArm(arm) ? NARRATION_ARM_TO_MODE[arm] : NARRATION_ARM_TO_MODE[FALLBACK_DEFAULTS.narration];
}

/** RevealMode for an ending arm label (safe fallback to the default reveal).
 *  NOTE: cliffhanger -> "last" is what generalizes the ending across question counts.
 *  On a 1-question video, HermesQuiz's willReveal("last", lastIndex=0) is false, so the
 *  single verdict is withheld + comment-CTA — the intended cliffhanger semantics. */
export function revealForEnding(arm: string): RevealMode {
  return isEndingArm(arm) ? ENDING_ARM_TO_REVEAL[arm] : ENDING_ARM_TO_REVEAL[FALLBACK_DEFAULTS.ending];
}

/**
 * The comment-CTA wording for a reveal mode. "all" (full-reveal) shows every answer
 * so it nudges "comment your SCORE"; "last" (cliffhanger) and "none" (no-answer) both
 * withhold at least one verdict so they nudge "comment your ANSWER". This is why the
 * new cliffhanger DEFAULT reads "comment your answer" (the last verdict is withheld).
 */
export function captionAsk(reveal: RevealMode): string {
  return reveal === "all" ? "comment your score" : "comment your answer";
}

/** The centered outro CTA card text for a reveal mode (comment-CTA + follow nudge). */
export function defaultOutro(reveal: RevealMode): string {
  return `${captionAsk(reveal)} \uD83D\uDC47 follow for more`;
}
