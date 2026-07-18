import type { ReactNode } from "react";
import { COLORS, slotColors, separatorColor } from "../../theme/brand";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { ShapeGlyph, type GlyphKind } from "../../components/ShapeGlyph";
import { SHADE_FILL } from "../../data/questions";
import type { ShadedQuestion as ShadedQ } from "../../data/types";

/** Figure-analogy plate: [empty L] : [filled L] = [empty R] : [ ? ] with FLAT
 *  tiles, ratio ":" as stacked dots and analogy "::" as the EQUALS sign; four
 *  shadowed shape option cards below. Flow layout via QuestionFrame. */
// Figure tiles: smaller than before so the shape sits with clear margin (not
// filling edge-to-edge) and the tiles don't crowd adjacent elements.
const TILE = 168;
const Cell: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div style={{ width: TILE, height: TILE, boxSizing: "border-box", background: COLORS.paper, border: `7px solid ${COLORS.ink}`, borderRadius: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
    {children}
  </div>
);

const glyphCell = (kind: GlyphKind, filled: boolean) => (
  <Cell>
    <ShapeGlyph kind={kind} s={50} fill={filled ? SHADE_FILL : COLORS.paper} />
  </Cell>
);

// Colorful, on-brand separators: a bright fill (keyed to the plate bg so it
// always contrasts) + a thick black outline, kept FLAT to match the flat tiles.
const SEP_OUTLINE = 4;
const Dot: React.FC<{ fill: string }> = ({ fill }) => (
  <div style={{ width: 28, height: 28, boxSizing: "border-box", borderRadius: "50%", background: fill, border: `${SEP_OUTLINE}px solid ${COLORS.ink}` }} />
);
const Bar: React.FC<{ fill: string }> = ({ fill }) => (
  <div style={{ width: 76, height: 28, boxSizing: "border-box", borderRadius: 14, background: fill, border: `${SEP_OUTLINE}px solid ${COLORS.ink}` }} />
);
const Sep: React.FC<{ width: number; children: ReactNode }> = ({ width, children }) => (
  <div style={{ width, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22 }}>{children}</div>
);

export const ShadedQuestion: React.FC<{ q: ShadedQ; elapsed: number }> = ({ q, elapsed }) => {
  const sep = separatorColor(slotColors(q.idx).bg);
  const content = (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      {glyphCell(q.leftShape, false)}
      <Sep width={70}><Dot fill={sep} /><Dot fill={sep} /></Sep>
      {glyphCell(q.leftShape, true)}
      <Sep width={130}><Bar fill={sep} /><Bar fill={sep} /></Sep>
      {glyphCell(q.rightShape, false)}
      <Sep width={70}><Dot fill={sep} /><Dot fill={sep} /></Sep>
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
    <QuestionFrame q={q} elapsed={elapsed} prompt={<PromptTitle fontSize={64} radius={36}>{q.prompt}</PromptTitle>} content={content} options={options} />
  );
};
