import type { Question } from "../data/types";
import { TextQuestion } from "./questions/TextQuestion";
import { NumSeriesQuestion } from "./questions/NumSeriesQuestion";
import { ShadedQuestion } from "./questions/ShadedQuestion";
import { PolygonQuestion } from "./questions/PolygonQuestion";
import { DotQuestion } from "./questions/DotQuestion";
import { MatrixQuestion } from "./questions/MatrixQuestion";
import { Analogy2Question } from "./questions/Analogy2Question";
import { FigureOddQuestion } from "./questions/FigureOddQuestion";

/** Dispatches to the right question-type plate. `elapsed` (seconds) drives the
 *  countdown; pass 0 for the static "read" plate (timer full). `pos`/`total`
 *  drive the "QUESTION pos OF total" header for the current cut. */
export const QuestionPlate: React.FC<{ q: Question; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const p = { elapsed, pos, total };
  switch (q.kind) {
    case "text":
      return <TextQuestion q={q} {...p} />;
    case "numseries":
      return <NumSeriesQuestion q={q} {...p} />;
    case "shaded":
      return <ShadedQuestion q={q} {...p} />;
    case "polygon":
      return <PolygonQuestion q={q} {...p} />;
    case "dot":
      return <DotQuestion q={q} {...p} />;
    // MATRIX-FAMILY (new nonverbal types; share the FigState transform vocabulary)
    case "matrix":
      return <MatrixQuestion q={q} {...p} />;
    case "analogy2":
      return <Analogy2Question q={q} {...p} />;
    case "figure-odd":
      return <FigureOddQuestion q={q} {...p} />;
  }
};
