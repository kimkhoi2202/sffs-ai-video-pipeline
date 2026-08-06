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
/** Canonical MASCOT arm labels (map onto the brand-mascot render visibility). The
 *  brand mascot (the brain on the intro cover + outro sticker) is ALWAYS-ON today,
 *  so "mascot-standard" == the current baseline. "mascot-absent" hides it (the clean
 *  no-mascot control for the views hypothesis); "mascot-prominent" enlarges it (the
 *  more-mascot arm). Kept in sync with promote.py PROMOTABLE_DIMENSIONS["mascot"]. */
export type MascotArm = "mascot-standard" | "mascot-absent" | "mascot-prominent";

export interface ContentDefaults {
  /** current NARRATION default (arm label). */
  narration: NarrationArm;
  /** current ENDING default (arm label). */
  ending: EndingArm;
  /** current MASCOT default (arm label). */
  mascot: MascotArm;
}

/** The HARDCODED fallback defaults (used if content-defaults.json is missing/corrupt). */
export const FALLBACK_DEFAULTS: ContentDefaults = Object.freeze({
  narration: "full",
  ending: "cliffhanger",
  mascot: "mascot-prominent",
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

/** mascot arm label -> the render VISIBILITY token the composition consumes
 *  (remotion FullVideo -> Intro/Outro). "standard" keeps today's brain exactly;
 *  "absent" hides it; "prominent" enlarges it. Keys are the canonical rollup labels
 *  the Python promotion engine compares, so keep them in sync with
 *  promote.py PROMOTABLE_DIMENSIONS["mascot"]. */
export const MASCOT_ARM_TO_MODE: Readonly<Record<MascotArm, "standard" | "absent" | "prominent">> = Object.freeze({
  "mascot-standard": "standard",
  "mascot-absent": "absent",
  "mascot-prominent": "prominent",
});
export const MASCOT_ARMS: readonly MascotArm[] = Object.freeze(
  Object.keys(MASCOT_ARM_TO_MODE) as MascotArm[],
);

function isNarrationArm(v: unknown): v is NarrationArm {
  return typeof v === "string" && v in NARRATION_ARM_TO_MODE;
}
function isEndingArm(v: unknown): v is EndingArm {
  return typeof v === "string" && v in ENDING_ARM_TO_REVEAL;
}
function isMascotArm(v: unknown): v is MascotArm {
  return typeof v === "string" && v in MASCOT_ARM_TO_MODE;
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
    mascot: isMascotArm(d.mascot) ? d.mascot : FALLBACK_DEFAULTS.mascot,
  };
}

/** NarrationMode for a narration arm label (safe fallback to the default mode). */
export function narrationModeForArm(arm: string): NarrationMode {
  return isNarrationArm(arm) ? NARRATION_ARM_TO_MODE[arm] : NARRATION_ARM_TO_MODE[FALLBACK_DEFAULTS.narration];
}

/** Canonical mascot arm label (safe fallback to the mascot default). */
export function mascotArmFor(arm: string): MascotArm {
  return isMascotArm(arm) ? arm : FALLBACK_DEFAULTS.mascot;
}
/** Render VISIBILITY token for a mascot arm label (safe fallback to the default). */
export function mascotModeForArm(arm: string): "standard" | "absent" | "prominent" {
  return MASCOT_ARM_TO_MODE[mascotArmFor(arm)];
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
export function captionAsk(_reveal: RevealMode): string {
  return "take the full test";
}

/**
 * The light engagement beat that runs BEFORE the ask, and the reason this is not simply
 * deleted along with the comment CTA.
 *
 * Comments are what distribution keys on and this account is fighting cold start, so a
 * caption that only advertises the site would very likely be seen by fewer people —
 * which defeats the point of putting the site in it. The trade taken here is: keep a
 * reason to engage, demote it from THE ask to the thing that precedes the ask. The
 * end card made the opposite trade on 2026-08-04, and it could afford to: a viewer who
 * reaches the last two seconds has already not skipped.
 *
 * Still varies with the reveal mode for the same reason it always did: "all" shows every
 * answer so there is a score to report, everything else withholds a verdict so there is
 * an answer to guess.
 */
export function captionEngagementBeat(reveal: RevealMode): string {
  return reveal === "all" ? "drop your score" : "drop your answer";
}

/** The centered outro CTA card text. The end card no longer asks for a comment — it
 *  sends people to the free test — so this no longer varies with the reveal mode. */
export function defaultOutro(_reveal: RevealMode): string {
  return "the full test is free \uD83D\uDC47 smartfellaorfartsmella.com";
}
