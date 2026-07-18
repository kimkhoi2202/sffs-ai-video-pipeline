import type { ReactNode } from "react";
import { COLORS, slotColors, separatorColor } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { ShapeGlyph, type GlyphKind } from "../../components/ShapeGlyph";
import { SHADE_FILL } from "../../data/questions";
import type { ShadedQuestion as ShadedQ } from "../../data/types";

/** Figure-analogy plate: [empty L] : [filled L] = [empty R] : [ ? ] with FLAT
 *  tiles, ratio ":" as stacked dots and analogy "::" as the EQUALS sign; four
 *  shadowed shape option cards below. Tiles + separators shrink for portrait so
 *  the whole analogy row fits the narrow frame. */
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

export const ShadedQuestion: React.FC<{ q: ShadedQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait } = useFmt();
  const sep = separatorColor(slotColors(q.idx).bg);
  const TILE = portrait ? 130 : 168;
  const glyphS = Math.round(TILE * 0.3);
  const dotD = portrait ? 22 : 28;
  const barW = portrait ? 56 : 76;
  const barH = portrait ? 22 : 28;
  const sepGap = portrait ? 16 : 22;
  const ratioW = portrait ? 52 : 70;
  const eqW = portrait ? 96 : 130;

  const Cell: React.FC<{ children: ReactNode }> = ({ children }) => (
    <div style={{ width: TILE, height: TILE, boxSizing: "border-box", background: COLORS.paper, border: `7px solid ${COLORS.ink}`, borderRadius: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {children}
    </div>
  );
  const glyphCell = (kind: GlyphKind, filled: boolean) => (
    <Cell>
      <ShapeGlyph kind={kind} s={glyphS} fill={filled ? SHADE_FILL : COLORS.paper} />
    </Cell>
  );

  const content = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      {glyphCell(q.leftShape, false)}
      <Sep width={ratioW} gap={sepGap}><Dot fill={sep} d={dotD} /><Dot fill={sep} d={dotD} /></Sep>
      {glyphCell(q.leftShape, true)}
      <Sep width={eqW} gap={sepGap}><Bar fill={sep} w={barW} h={barH} /><Bar fill={sep} w={barW} h={barH} /></Sep>
      {glyphCell(q.rightShape, false)}
      <Sep width={ratioW} gap={sepGap}><Dot fill={sep} d={dotD} /><Dot fill={sep} d={dotD} /></Sep>
      <Cell>
        <span style={{ fontFamily: ANTON, fontSize: TILE * 0.6, lineHeight: 1, color: COLORS.ink }}>?</span>
      </Cell>
    </div>
  );

  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter}>
          <ShapeGlyph kind={o.shape} s={55} fill={o.filled ? SHADE_FILL : COLORS.paper} />
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );

  return (
    <QuestionFrame q={q} elapsed={elapsed} pos={pos} total={total} prompt={<PromptTitle fontSize={portrait ? 46 : 64} radius={36}>{q.prompt}</PromptTitle>} content={content} options={options} />
  );
};
