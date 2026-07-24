/**
 * Whether the tier/category header pill should render.
 *
 * The pill shows the question-type label (e.g. "ODD ONE OUT", "NUMBER SERIES",
 * "PAPER FOLDING"). It must render ONLY when there is a real, non-blank label:
 * an empty / whitespace / undefined tier HIDES the pill entirely rather than
 * shipping an empty capsule (the blank green pill bug). Pure + dependency-free
 * so it stays unit-testable without a React/Remotion renderer.
 */
export const showTierPill = (tier: string | null | undefined): boolean =>
  typeof tier === "string" && tier.trim().length > 0;
