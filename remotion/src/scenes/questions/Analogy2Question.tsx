import type { ReactNode } from "react";
import { COLORS, slotColors, separatorColor } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { FigCell, FigGlyphGroup, type FigState } from "../../components/FigureCell";
import type { Analogy2Question as Analogy2Q } from "../../data/types";

/**
 * Figure Analogy v2 plate: [A] : [B] :: [C] : [ ? ] with FLAT tiles, the ratio
 * ":" as stacked dots and the analogy "::" as bars — the SAME analogy grammar as
 * the shade-only `shaded` plate, but every tile is drawn with the full FigState
 * transform vocabulary (rotate / count / size / fill), so the A->B rule can be a
 * quarter-turn, a doubling, a grow/shrink, or a fill. Four figure option cards
 * below. Tiles + separators shrink for portrait so the whole row fits the frame.
 */
const SEP_OUTLINE = 4;
const Dot: React.FC<{ fill: string; d: number }> = ({ fill, d }) => (
  <div style={{ width: d, height: d, boxSizing: "border-box", borderRadius: "50%", background: fill, border: `${SEP_OUTLINE}px solid ${COLORS.ink}` }} />
);
const Bar: React.FC<{ fill: string; w: number; h: number }> = ({ fill, w, h }) => (
  <div style={{ width: w, height: h, boxSizing: "border-box", borderRadius: h / 2, background: fill, border: `${SEP_OUTLINE}px solid ${COLORS.ink}` }} />
);
const Sep: React.FC<{ width: number; gap: number; children: ReactNode }> = ({ width, gap, children }) => (
  <div style={{ width, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap }}>{children}</div>
);

export const Analogy2Question: React.FC<{ q: Analogy2Q; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait } = useFmt();
  const sep = separatorColor(slotColors(q.idx).bg);
  const TILE = portrait ? 132 : 168;
  const base = Math.round(TILE * 0.3);
  const dotD = portrait ? 22 : 28;
  const barW = portrait ? 54 : 76;
  const barH = portrait ? 22 : 28;
  const sepGap = portrait ? 15 : 22;
  const ratioW = portrait ? 48 : 70;
  const eqW = portrait ? 92 : 130;

  const figCell = (fig: FigState) => (
    <FigCell size={TILE}>
      <FigGlyphGroup fig={fig} base={base} />
    </FigCell>
  );

  const content = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      {figCell(q.a)}
      <Sep width={ratioW} gap={sepGap}><Dot fill={sep} d={dotD} /><Dot fill={sep} d={dotD} /></Sep>
      {figCell(q.b)}
      <Sep width={eqW} gap={sepGap}><Bar fill={sep} w={barW} h={barH} /><Bar fill={sep} w={barW} h={barH} /></Sep>
      {figCell(q.c)}
      <Sep width={ratioW} gap={sepGap}><Dot fill={sep} d={dotD} /><Dot fill={sep} d={dotD} /></Sep>
      <FigCell size={TILE}>
        <span style={{ fontFamily: ANTON, fontSize: TILE * 0.6, lineHeight: 1, color: COLORS.ink }}>?</span>
      </FigCell>
    </div>
  );

  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter}>
          <FigGlyphGroup fig={o.fig} base={portrait ? 52 : 55} border={7} />
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );

  return (
    <QuestionFrame
      q={q}
      elapsed={elapsed}
      pos={pos}
      total={total}
      prompt={<PromptTitle fontSize={portrait ? 46 : 64} radius={36}>{q.prompt}</PromptTitle>}
      content={content}
      options={options}
    />
  );
};
