/**
 * Paper-folding geometry — the deterministic fold / punch / mirror solver shared
 * by the FoldQuestion plate, its reveal, and the sample render script.
 *
 * Model: a sheet is an N x N grid of hole slots (N even, default 4). A fold
 * halves the sheet along the vertical middle (V, from left/right folds) or the
 * horizontal middle (H, from up/down folds); the surviving "active region" is the
 * half that stays on top of the stack. A punch goes through every layer, so on
 * UNFOLD each punched slot is reflected across every folded axis and the images
 * are unioned. Restricting authored folds to at most one V and one H keeps the
 * mirror math to a clean 4-cell orbit (a single crease -> a mirrored pair; two
 * creases -> the four quarters), which is exactly the CogAT Level-11 difficulty.
 */
export type FoldDir = "left" | "right" | "up" | "down";
export type FoldAxis = "V" | "H";
export type HoleCell = { r: number; c: number };

export const foldAxis = (d: FoldDir): FoldAxis => (d === "left" || d === "right" ? "V" : "H");

/** The distinct crease axes for a fold sequence (["V"], ["H"], or ["V","H"]). */
export const foldAxes = (folds: FoldDir[]): FoldAxis[] => {
  const set = new Set(folds.map(foldAxis));
  return (["V", "H"] as FoldAxis[]).filter((a) => set.has(a));
};

const key = (h: HoleCell): string => `${h.r},${h.c}`;

/** Reflect a cell across the middle axis of an N x N grid. */
export const mirrorCell = (h: HoleCell, axis: FoldAxis, n: number): HoleCell =>
  axis === "V" ? { r: h.r, c: n - 1 - h.c } : { r: n - 1 - h.r, c: h.c };

/**
 * Unfold: reflect every punch across each folded axis (V and/or H) and union the
 * images. Order-independent for the two independent axes. Returned holes are
 * sorted (row, then col) so two hole sets can be compared deterministically.
 */
export function unfold(folds: FoldDir[], punches: HoleCell[], n = 4): HoleCell[] {
  let holes = [...punches];
  for (const axis of foldAxes(folds)) {
    const m = new Map<string, HoleCell>();
    for (const h of holes) {
      m.set(key(h), h);
      const mir = mirrorCell(h, axis, n);
      m.set(key(mir), mir);
    }
    holes = [...m.values()];
  }
  return holes.sort((a, b) => a.r - b.r || a.c - b.c);
}

/** Set-equality on hole cells (ignores order + duplicates). */
export const sameHoles = (a: HoleCell[], b: HoleCell[]): boolean => {
  const sa = new Set(a.map(key));
  const sb = new Set(b.map(key));
  return sa.size === sb.size && [...sa].every((k) => sb.has(k));
};

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Apply one fold to a [0,1] paper rectangle, returning the surviving half. */
export const applyFold = (r: Rect, d: FoldDir): Rect => {
  const mx = (r.x0 + r.x1) / 2;
  const my = (r.y0 + r.y1) / 2;
  if (d === "left") return { ...r, x1: mx }; // right flap folds onto the left
  if (d === "right") return { ...r, x0: mx }; // left flap folds onto the right
  if (d === "up") return { ...r, y1: my }; // bottom flap folds up
  return { ...r, y0: my }; // "down": top flap folds down
};

/** The half of `r` that folds over (the flap) for a given fold. */
export const flapRect = (r: Rect, d: FoldDir): Rect => {
  const mx = (r.x0 + r.x1) / 2;
  const my = (r.y0 + r.y1) / 2;
  if (d === "left") return { ...r, x0: mx };
  if (d === "right") return { ...r, x1: mx };
  if (d === "up") return { ...r, y0: my };
  return { ...r, y1: my };
};

/** The full [0,1] sheet, then the surviving packet after each fold. */
export const foldStages = (folds: FoldDir[]): Rect[] => {
  const stages: Rect[] = [{ x0: 0, y0: 0, x1: 1, y1: 1 }];
  for (const d of folds) stages.push(applyFold(stages[stages.length - 1], d));
  return stages;
};

/** Predicate: does a cell sit in the folded packet's active (top) region? Used
 *  to validate that authored punches actually land on the folded stack. */
export const inActiveRegion = (folds: FoldDir[], n = 4) => {
  const packet = foldStages(folds)[folds.length];
  return (h: HoleCell): boolean => {
    const cx = (h.c + 0.5) / n;
    const cy = (h.r + 0.5) / n;
    return cx > packet.x0 && cx < packet.x1 && cy > packet.y0 && cy < packet.y1;
  };
};
