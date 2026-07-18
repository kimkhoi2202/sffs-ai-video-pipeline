/** Easing helpers — ported verbatim from render_cogat_round_15.py so the intro
 * choreography matches the approved animated title exactly. */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const easeOutCubic = (x: number): number => {
  const c = clamp01(x);
  return 1 - (1 - c) ** 3;
};

export const easeOutBack = (x: number): number => {
  const c = clamp01(x);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (c - 1) ** 3 + c1 * (c - 1) ** 2;
};
