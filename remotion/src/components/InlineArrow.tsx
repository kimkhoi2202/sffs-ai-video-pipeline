import { COLORS } from "../theme/brand";

/**
 * A crisp inline vector arrow ("→") for mapping-style question content
 * (e.g. "2 → 5"). Solid ink: a horizontal shaft + a clean triangular head, with
 * the shaft thickness scaled to match the heavy Anton numerals it sits between.
 * `h` is the arrow's visual height (pass ~0.55x the numeral font size).
 */
export const InlineArrow: React.FC<{ h: number }> = ({ h }) => {
  const w = h * 1.7;
  const t = h * 0.32; // shaft thickness ≈ Anton stroke weight
  const headL = h * 0.6;
  const cy = h / 2;
  const shaftEnd = w - headL;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }} aria-hidden>
      <rect x={0} y={cy - t / 2} width={shaftEnd + 2} height={t} rx={t * 0.2} fill={COLORS.ink} />
      <polygon points={`${shaftEnd},0 ${w},${cy} ${shaftEnd},${h}`} fill={COLORS.ink} />
    </svg>
  );
};
