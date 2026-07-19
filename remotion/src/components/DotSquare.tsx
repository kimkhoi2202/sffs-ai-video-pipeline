import { COLORS } from "../theme/brand";

/** 3x3 grid: four corners, four edge-midpoints, and the center. */
export type DotPos = "tl" | "tm" | "tr" | "rm" | "br" | "bm" | "bl" | "lm" | "center";

/** The 8 perimeter positions in clockwise order (center excluded) — the ring the
 *  rotation solver/enumerator walk. Rotations of a constant angular step around
 *  this ring are the deterministic "where does the dot move next" patterns. */
export const DOT_RING: DotPos[] = ["tl", "tm", "tr", "rm", "br", "bm", "bl", "lm"];

/**
 * The dot-position icon: a bordered square with a colored dot at one of nine grid
 * spots (four corners, four edge-midpoints, center) and faint ghost pips marking
 * the eight perimeter spots so the moving-dot geometry reads at a glance. FLAT by
 * design (the option CARD around it keeps its shadow, not this square).
 */
export const DotSquare: React.FC<{
  size: number;
  pos: DotPos | null;
  dotColor: string;
  border?: number;
  sqRadius?: number;
  ghost?: boolean;
}> = ({ size, pos, dotColor, border = 7, sqRadius = 10, ghost = true }) => {
  // inset (pad) and dot radius (dr) tuned so the dot NEVER touches the tile edge,
  // including the 3x3 edge/corner spots and at small preview sizes.
  const pad = size * 0.25;
  const mid = size / 2;
  const dr = size * 0.125;
  const P: Record<DotPos, [number, number]> = {
    tl: [pad, pad],
    tm: [mid, pad],
    tr: [size - pad, pad],
    rm: [size - pad, mid],
    br: [size - pad, size - pad],
    bm: [mid, size - pad],
    bl: [pad, size - pad],
    lm: [pad, mid],
    center: [mid, mid],
  };
  const dotStroke = Math.max(4, border - 1);

  return (
    <svg width={size} height={size} style={{ overflow: "visible", display: "block" }}>
      <rect
        x={border / 2}
        y={border / 2}
        width={size - border}
        height={size - border}
        rx={sqRadius}
        fill={COLORS.paper}
        stroke={COLORS.ink}
        strokeWidth={border}
      />
      {ghost
        ? DOT_RING.map((k) => {
            const [gx, gy] = P[k];
            return <circle key={k} cx={gx} cy={gy} r={dr * 0.34} fill={COLORS.ghostGray} />;
          })
        : null}
      {pos ? (
        <circle cx={P[pos][0]} cy={P[pos][1]} r={dr} fill={dotColor} stroke={COLORS.ink} strokeWidth={dotStroke} />
      ) : null}
    </svg>
  );
};
