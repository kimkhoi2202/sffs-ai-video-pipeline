import type { Question } from "../data/types";
import { TextQuestion } from "./questions/TextQuestion";
import { NumSeriesQuestion } from "./questions/NumSeriesQuestion";
import { ShadedQuestion } from "./questions/ShadedQuestion";
import { PolygonQuestion } from "./questions/PolygonQuestion";
import { DotQuestion } from "./questions/DotQuestion";
import { FoldQuestion } from "./questions/FoldQuestion";

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
    // PAPER FOLDING (new nonverbal type; heavy fold/punch/mirror render)
    case "fold":
      return <FoldQuestion q={q} {...p} />;
  }
};
