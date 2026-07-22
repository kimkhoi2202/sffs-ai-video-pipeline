import { useFmt } from "../../theme/layout";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { FigGlyphGroup } from "../../components/FigureCell";
import type { FigureOddQuestion as FigureOddQ } from "../../data/types";

/**
 * Visual Odd-One-Out (Figure Classification) plate — the visual twin of the text
 * ODD ONE OUT. Four figure cards; one differs by shape, fill, rotation, or count.
 * Like the text version there is NO content row: the four figures ARE the answer
 * options (the viewer picks the one that does not belong). Figures are drawn with
 * the shared FigState vocabulary (ShapeGlyph), so it reuses everything.
 */
export const FigureOddQuestion: React.FC<{ q: FigureOddQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait } = useFmt();
  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter}>
          <FigGlyphGroup fig={o.fig} base={portrait ? 60 : 64} border={7} />
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
      prompt={<PromptTitle fontSize={portrait ? 48 : 66} radius={36}>{q.prompt}</PromptTitle>}
      options={options}
    />
  );
};
