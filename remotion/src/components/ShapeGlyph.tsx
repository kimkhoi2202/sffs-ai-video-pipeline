import { COLORS } from "../theme/brand";

export type GlyphKind =
  | "circle" | "square" | "triangle" | "diamond" | "star" | "heart"
  | "cross" | "arrow" | "crescent" | "lightning" | "teardrop";

/** The full set, in a stable order (used by enumerators + the preview). Every
 *  glyph is a clearly DISTINCT silhouette (none reads as a near-circle) so the
 *  figure-analogy vocabulary scales with unmistakable options. */
export const GLYPH_KINDS: GlyphKind[] = [
  "circle", "square", "triangle", "diamond", "star", "heart",
  "cross", "arrow", "crescent", "lightning", "teardrop",
];

/** Build the SVG points for a regular star (5-point) centered in a `dim` box. */
const starPoints = (dim: number, p: number): string => {
  const cx = dim / 2, cy = dim / 2;
  const R = dim / 2 - p; // outer radius (inside the stroke padding)
  const r = R * 0.42; // inner radius
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = (-90 + i * 36) * (Math.PI / 180);
    pts.push(`${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`);
  }
  return pts.join(" ");
};

/**
 * A crisp FLAT figure glyph used inside the analogy tiles and the shape option
 * cards. Real vector geometry: divs with border-radius for circle/square, and
 * SVG <polygon>/<path> (strokeLinejoin round) for triangle/diamond/star/heart —
 * so corners are clean. `s` is the half-size, border is the ink stroke. FLAT by
 * design (no shadow) — matches the approved figure-tile spec. Circle/square/
 * triangle are the original three; diamond/star/heart extend the figure-analogy
 * vocabulary so the nonverbal signature space can scale (see CONTENT_PIPELINE 14).
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

  if (kind === "triangle") {
    // Triangle — top (cx, cy - s), bl (cx - 0.98s, cy + 0.72s), br (cx + 0.98s, cy + 0.72s).
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
  }

  const p = border;
  const dim = d + 2 * p;

  if (kind === "diamond") {
    // Rhombus: top, right, bottom, left.
    const c = dim / 2;
    const pts = `${c},${p} ${dim - p},${c} ${c},${dim - p} ${p},${c}`;
    return (
      <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} style={{ overflow: "visible", display: "block" }}>
        <polygon points={pts} fill={fill} stroke={COLORS.ink} strokeWidth={border} strokeLinejoin="round" />
      </svg>
    );
  }

  if (kind === "star") {
    return (
      <svg width={dim} height={dim} viewBox={`0 0 ${dim} ${dim}`} style={{ overflow: "visible", display: "block" }}>
        <polygon points={starPoints(dim, p)} fill={fill} stroke={COLORS.ink} strokeWidth={border} strokeLinejoin="round" />
      </svg>
    );
  }

  // All remaining glyphs draw on a shared 0..100 viewBox (scaled by the svg box).
  const sw = (border / dim) * 100;
  const wrap = (child: React.ReactNode) => (
    <svg width={dim} height={dim} viewBox="0 0 100 100" style={{ overflow: "visible", display: "block" }}>
      {child}
    </svg>
  );
  const poly = (pts: string) => wrap(<polygon points={pts} fill={fill} stroke={COLORS.ink} strokeWidth={sw} strokeLinejoin="round" />);
  const path = (d: string) => wrap(<path d={d} fill={fill} stroke={COLORS.ink} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />);

  if (kind === "heart") return path("M50,88 C12,58 4,36 20,22 C32,11 46,18 50,30 C54,18 68,11 80,22 C96,36 88,58 50,88 Z");
  if (kind === "cross") return poly("36,8 64,8 64,36 92,36 92,64 64,64 64,92 36,92 36,64 8,64 8,36 36,36");
  if (kind === "arrow") return poly("50,8 86,48 65,48 65,92 35,92 35,48 14,48");
  if (kind === "crescent") return path("M50,10 A40,40 0 1 0 50,90 A32,40 0 1 1 50,10 Z");
  if (kind === "lightning") return poly("58,6 28,54 47,54 42,94 74,40 54,40 60,6");
  // teardrop — round bottom, sharp point at top
  return path("M50,8 C64,30 82,48 82,64 A32,32 0 1 1 18,64 C18,48 36,30 50,8 Z");
};
