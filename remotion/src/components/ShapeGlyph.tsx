import { COLORS } from "../theme/brand";

export type GlyphKind = "circle" | "square" | "triangle";

/**
 * A crisp FLAT figure glyph (circle / rounded-square / triangle) used inside the
 * analogy tiles and the shape option cards. Real vector geometry: divs with
 * border-radius for circle/square, and an SVG <polygon strokeLinejoin="round">
 * for the triangle — so corners are clean (the whole reason for leaving Pillow's
 * `polygon(width=...)` miter joins behind). Ports `_draw_shaded` from
 * render_cogat_round_15.py: `s` is the half-size, border is the ink stroke.
 * FLAT by design (no shadow) — matches the approved figure-tile spec.
 */
export const ShapeGlyph: React.FC<{
  kind: GlyphKind;
  s: number;
  fill: string;
  border?: number;
}> = ({ kind, s, fill, border = 8 }) => {
  const d = 2 * s;

  if (kind === "circle") {
    return (
      <div
        style={{
          width: d,
          height: d,
          borderRadius: "50%",
          border: `${border}px solid ${COLORS.ink}`,
          background: fill,
          boxSizing: "border-box",
        }}
      />
    );
  }

  if (kind === "square") {
    return (
      <div
        style={{
          width: d,
          height: d,
          borderRadius: 16,
          border: `${border}px solid ${COLORS.ink}`,
          background: fill,
          boxSizing: "border-box",
        }}
      />
    );
  }

  // Triangle — Python geometry: top (cx, cy - s), bl (cx - 0.98s, cy + 0.72s),
  // br (cx + 0.98s, cy + 0.72s). Rounded joins for crisp brand corners.
  const w = 1.96 * s;
  const h = 1.72 * s;
  const p = border;
  const svgW = w + 2 * p;
  const svgH = h + 2 * p;
  const pts = `${p + 0.98 * s},${p} ${p + w},${p + h} ${p},${p + h}`;
  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} style={{ overflow: "visible", display: "block" }}>
      <polygon points={pts} fill={fill} stroke={COLORS.ink} strokeWidth={border} strokeLinejoin="round" />
    </svg>
  );
};
