import type { ReactNode } from "react";
import { COLORS } from "../theme/brand";
import { ShapeGlyph, type GlyphKind } from "./ShapeGlyph";
import { SHADE_FILL } from "../data/questions";

/**
 * The SHARED figure-transform vocabulary for the MATRIX-FAMILY nonverbal plates
 * (Figure Matrix 2x2, Figure Analogy v2, Visual Odd-One-Out). A `FigState` is a
 * single figure described by a small set of transforms — no new drawing
 * primitives, everything reuses the existing `ShapeGlyph`:
 *   - shape   which of the 11 glyphs (circle, arrow, triangle, star, ...)
 *   - filled  the existing empty(paper) -> filled(SHADE_FILL) transform
 *   - color   optional recolor of the filled glyph (defaults to SHADE_FILL blue)
 *   - rotate  a quarter/half/eighth turn, drawn as a CSS transform: rotate()
 *   - count   render N copies of the glyph (1..4) for the "count doubles" rule
 *   - size    s / m / l for the grow/shrink rule (the existing glyph `s` prop)
 * Build the vocabulary once here so all three plates + their reveals share it.
 */
export type FigSize = "s" | "m" | "l";
export type FigState = {
  shape: GlyphKind;
  filled?: boolean;
  color?: string; // fill when `filled` (default SHADE_FILL)
  rotate?: number; // degrees clockwise (CSS transform)
  count?: number; // 1..4 (default 1)
  size?: FigSize; // default "m"
};

const SIZE_SCALE: Record<FigSize, number> = { s: 0.64, m: 1, l: 1.26 };
/** Shrink each glyph as the count grows so N copies stay inside one cell. */
const COUNT_SCALE: Record<number, number> = { 1: 1, 2: 0.6, 3: 0.42, 4: 0.42 };

/**
 * Renders the GLYPH GROUP for a figure state (no surrounding cell box): `count`
 * copies of `shape`, scaled by size+count, each rotated by `rotate`, filled or
 * empty. Used inside matrix/analogy cells, the shape option cards, and the
 * reveal. `base` is the single-glyph half-size at size "m", count 1.
 */
export const FigGlyphGroup: React.FC<{ fig: FigState; base: number; border?: number }> = ({
  fig,
  base,
  border = 8,
}) => {
  const count = Math.max(1, Math.min(4, fig.count ?? 1));
  const s = Math.round(base * SIZE_SCALE[fig.size ?? "m"] * (COUNT_SCALE[count] ?? 0.42));
  const fill = fig.filled ? fig.color ?? SHADE_FILL : COLORS.paper;
  const gap = Math.round(s * 0.35);
  const glyph = (key: number) => (
    <div key={key} style={{ display: "flex", transform: fig.rotate ? `rotate(${fig.rotate}deg)` : undefined }}>
      <ShapeGlyph kind={fig.shape} s={s} fill={fill} border={border} />
    </div>
  );
  const glyphs = Array.from({ length: count }, (_, i) => glyph(i));
  if (count === 4) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap, justifyItems: "center", alignItems: "center" }}>
        {glyphs}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap, alignItems: "center", justifyContent: "center" }}>{glyphs}</div>
  );
};

/** A bordered white figure cell (matches the flat tiles used across the pipeline:
 *  paper fill, 7px ink border, rounded). Holds any node (a glyph group or "?"). */
export const FigCell: React.FC<{ size: number; radius?: number; children?: ReactNode }> = ({
  size,
  radius = 22,
  children,
}) => (
  <div
    style={{
      width: size,
      height: size,
      boxSizing: "border-box",
      background: COLORS.paper,
      border: `7px solid ${COLORS.ink}`,
      borderRadius: radius,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    {children}
  </div>
);
