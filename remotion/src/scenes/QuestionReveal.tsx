import { BADGE_COLORS, COLORS } from "../theme/brand";
import { ShapeGlyph } from "../components/ShapeGlyph";
import { Polygon } from "../components/Polygon";
import { DotSquare } from "../components/DotSquare";
import { HoleGrid } from "./questions/FoldQuestion";
import { foldAxes } from "../data/fold";
import { FigGlyphGroup } from "../components/FigureCell";
import { SHADE_FILL } from "../data/questions";
import type { Question } from "../data/types";
import { Reveal } from "./Reveal";

/** Builds the correct-answer reveal for any question kind (text answer, shaded
 *  glyph, polygon, or dot-square), reusing the unified Reveal layout. */
export const QuestionReveal: React.FC<{ q: Question }> = ({ q }) => {
  const letter = q.ansLetter;
  switch (q.kind) {
    case "text":
    case "numseries":
      return <Reveal letter={letter} explanation={q.explanation} answer={{ kind: "text", text: q.ansLabel }} />;
    case "shaded":
      return (
        <Reveal
          letter={letter}
          explanation={q.explanation}
          answer={{ kind: "shape", label: q.ansLabel, node: <ShapeGlyph kind={q.ansShape} s={66} fill={q.ansFilled ? SHADE_FILL : COLORS.paper} /> }}
        />
      );
    case "polygon":
      return (
        <Reveal
          letter={letter}
          explanation={q.explanation}
          answer={{ kind: "shape", label: q.ansLabel, node: <Polygon shape={q.ansShape} r={74} fill={BADGE_COLORS[letter]} border={8} /> }}
        />
      );
    case "dot":
      return (
        <Reveal
          letter={letter}
          explanation={q.explanation}
          answer={{ kind: "shape", label: q.ansLabel, node: <DotSquare size={150} pos={q.ansPos} dotColor={BADGE_COLORS[letter]} border={8} sqRadius={12} /> }}
        />
      );
    case "fold":
      return (
        <Reveal
          letter={letter}
          explanation={q.explanation}
          answer={{ kind: "shape", label: q.ansLabel, node: <HoleGrid size={150} n={q.grid ?? 4} holes={q.ansHoles} creases={foldAxes(q.folds)} border={8} radius={16} /> }}
        />
      );
    // MATRIX-FAMILY: reveal the correct figure (drawn with the shared vocabulary).
    case "matrix":
    case "analogy2":
    case "figure-odd":
      return (
        <Reveal
          letter={letter}
          explanation={q.explanation}
          answer={{ kind: "shape", label: q.ansLabel, node: <FigGlyphGroup fig={q.ans} base={44} border={7} /> }}
        />
      );
  }
};
