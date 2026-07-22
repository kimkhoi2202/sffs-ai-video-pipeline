import { COLORS } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { FigCell, FigGlyphGroup, type FigState } from "../../components/FigureCell";
import type { MatrixQuestion as MatrixQ } from "../../data/types";

/**
 * Figure Matrix 2x2 plate — the flagship nonverbal upgrade. A 2x2 grid of flat
 * figure cells: the top row states the rule (cell A -> cell B) and the bottom
 * row applies it (cell C -> ?). Four figure option cards below. Everything is
 * drawn with the shared FigState transform vocabulary (rotate/fill/count/size),
 * reusing ShapeGlyph — no new drawing primitives. Cells shrink for portrait.
 */
export const MatrixQuestion: React.FC<{ q: MatrixQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait } = useFmt();
  const TILE = portrait ? 290 : 264;
  const GAP = portrait ? 32 : 40;
  const base = Math.round(TILE * 0.3);
  const [tl, tr, bl] = q.cells;

  const cell = (fig: FigState, key: string) => (
    <FigCell key={key} size={TILE}>
      <FigGlyphGroup fig={fig} base={base} />
    </FigCell>
  );
  const qCell = (
    <FigCell key="q" size={TILE}>
      <span style={{ fontFamily: ANTON, fontSize: TILE * 0.52, lineHeight: 1, color: COLORS.ink }}>?</span>
    </FigCell>
  );

  const content = (
    <div style={{ display: "grid", gridTemplateColumns: `${TILE}px ${TILE}px`, gap: GAP, justifyContent: "center" }}>
      {cell(tl, "tl")}
      {cell(tr, "tr")}
      {cell(bl, "bl")}
      {qCell}
    </div>
  );

  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter}>
          <FigGlyphGroup fig={o.fig} base={portrait ? 52 : 56} border={7} />
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
      prompt={<PromptTitle fontSize={portrait ? 46 : 60} radius={36}>{q.prompt}</PromptTitle>}
      content={content}
      options={options}
    />
  );
};
