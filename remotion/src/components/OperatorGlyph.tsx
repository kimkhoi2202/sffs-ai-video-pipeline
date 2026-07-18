import { COLORS } from "../theme/brand";

export type Operator = "+" | "=" | "×" | "÷" | "−";

/**
 * Crisp inline math-operator glyphs (SVG), matched to the heavy Anton numerals
 * they sit between — same approach as InlineArrow / the analogy "=" separator.
 * Solid ink, stroke weight matched to the digit strokes, optically centered on
 * the numeral mid-line. `fontSize` is the numeral font size it sits with.
 */
export const isOperator = (s: string): s is Operator => /^[+=×÷−]$/.test(s);

export const OperatorGlyph: React.FC<{ op: string; fontSize: number }> = ({ op, fontSize }) => {
  const h = fontSize * 0.52; // glyph box height
  const t = fontSize * 0.145; // bar thickness ≈ Anton stroke weight
  const r = t * 0.18;
  const cy = h / 2;
  const ink = COLORS.ink;
  const wrap = (w: number, children: React.ReactNode) => (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", overflow: "visible" }} aria-hidden>
      {children}
    </svg>
  );

  if (op === "+") {
    const w = h;
    return wrap(
      w,
      <>
        <rect x={w / 2 - t / 2} y={0} width={t} height={h} rx={r} fill={ink} />
        <rect x={0} y={cy - t / 2} width={w} height={t} rx={r} fill={ink} />
      </>,
    );
  }
  if (op === "=") {
    const w = h * 0.98;
    const gap = t * 1.2;
    return wrap(
      w,
      <>
        <rect x={0} y={cy - gap / 2 - t} width={w} height={t} rx={r} fill={ink} />
        <rect x={0} y={cy + gap / 2} width={w} height={t} rx={r} fill={ink} />
      </>,
    );
  }
  if (op === "−") {
    const w = h * 0.92;
    return wrap(w, <rect x={0} y={cy - t / 2} width={w} height={t} rx={r} fill={ink} />);
  }
  if (op === "×") {
    const w = h;
    return wrap(
      w,
      <g transform={`translate(${w / 2}, ${cy}) rotate(45)`}>
        <rect x={-w * 0.44} y={-t / 2} width={w * 0.88} height={t} rx={r} fill={ink} />
        <rect x={-t / 2} y={-w * 0.44} width={t} height={w * 0.88} rx={r} fill={ink} />
      </g>,
    );
  }
  // ÷
  const w = h * 0.96;
  const dotR = t * 0.64;
  return wrap(
    w,
    <>
      <rect x={0} y={cy - t / 2} width={w} height={t} rx={r} fill={ink} />
      <circle cx={w / 2} cy={cy - t * 1.75} r={dotR} fill={ink} />
      <circle cx={w / 2} cy={cy + t * 1.75} r={dotR} fill={ink} />
    </>,
  );
};
