import { COLORS } from "../theme/brand";

export type DotPos = "tl" | "tr" | "br" | "bl" | "center";

/**
 * The dot-position icon: a bordered square with a colored dot at one corner (or
 * center) and faint ghost pips marking the other corners so the moving-dot
 * geometry reads at a glance. Ports draw_dot_square from
 * render_cogat_round_15.py. FLAT by design (the option CARD around it keeps its
 * shadow, not this square).
 */
export const DotSquare: React.FC<{
  size: number;
  pos: DotPos | null;
  dotColor: string;
  border?: number;
  sqRadius?: number;
  ghost?: boolean;
}> = ({ size, pos, dotColor, border = 7, sqRadius = 10, ghost = true }) => {
  const pad = size * 0.22;
  const dr = size * 0.14;
  const P: Record<DotPos, [number, number]> = {
    tl: [pad, pad],
    tr: [size - pad, pad],
    br: [size - pad, size - pad],
    bl: [pad, size - pad],
    center: [size / 2, size / 2],
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
        ? (["tl", "tr", "br", "bl"] as DotPos[]).map((k) => {
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
