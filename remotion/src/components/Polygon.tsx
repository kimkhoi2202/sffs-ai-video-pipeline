import { COLORS } from "../theme/brand";

export type PolyShape = number | "circle";

/**
 * A crisp regular polygon (or circle) drawn as a real SVG with rounded joins —
 * the figure-series shapes (triangle=3 ... octagon=8). Ports draw_polygon +
 * POLY_ROT from render_cogat_round_15.py: `r` is the circumradius, per-shape
 * start angle orients each shape "correctly" (triangle/pentagon point up, square
 * axis-aligned, hexagon flat-top, octagon). FLAT by design.
 */
const POLY_ROT: Record<number, number> = { 3: -90, 4: 45, 5: -90, 6: 0, 7: -90, 8: 22.5 };

export const Polygon: React.FC<{ shape: PolyShape; r: number; fill: string; border?: number }> = ({
  shape,
  r,
  fill,
  border = 8,
}) => {
  const pad = border + 2;
  const size = 2 * (r + pad);
  const cx = r + pad;
  const cy = r + pad;

  if (shape === "circle") {
    return (
      <svg width={size} height={size} style={{ overflow: "visible", display: "block" }}>
        <circle cx={cx} cy={cy} r={r} fill={fill} stroke={COLORS.ink} strokeWidth={border} />
      </svg>
    );
  }

  const sides = shape;
  const rot = POLY_ROT[sides] ?? -90;
  const pts = Array.from({ length: sides }, (_, i) => {
    const a = ((rot + (i * 360) / sides) * Math.PI) / 180;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }).join(" ");

  return (
    <svg width={size} height={size} style={{ overflow: "visible", display: "block" }}>
      <polygon points={pts} fill={fill} stroke={COLORS.ink} strokeWidth={border} strokeLinejoin="round" />
    </svg>
  );
};
