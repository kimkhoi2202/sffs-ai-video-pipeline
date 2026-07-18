import { COLORS } from "../theme/brand";

/**
 * Analogy separators, in the approved gray style (Python `_sep_dots`, col
 * (120,120,120)):
 *   - "ratio"  ( : )  — two stacked gray dots (a single ratio separator).
 *   - "equals" ( :: ) — the analogy separator, now an EQUALS sign: two
 *     horizontal gray rounded-capsule bars, as if the top pair of dots joined
 *     into one bar and the bottom pair into another. Same gray, same vertical
 *     rhythm as the dots. (No em dashes anywhere.)
 * Geometry: dots r=12 at cy +/- 23 (Python vgap 46); the double-dot columns sat
 * at cx +/- 24, so each joined bar spans cx-36..cx+36 (width 72, height 24,
 * fully rounded).
 */
export const AnalogySeparator: React.FC<{
  cx: number;
  cy: number;
  variant: "ratio" | "equals";
}> = ({ cx, cy, variant }) => {
  const off = 23;
  const rows = [-off, off];

  if (variant === "ratio") {
    return (
      <>
        {rows.map((dy, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: cx - 12,
              top: cy + dy - 12,
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: COLORS.sepGray,
            }}
          />
        ))}
      </>
    );
  }

  return (
    <>
      {rows.map((dy, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: cx - 36,
            top: cy + dy - 12,
            width: 72,
            height: 24,
            borderRadius: 12,
            background: COLORS.sepGray,
          }}
        />
      ))}
    </>
  );
};
