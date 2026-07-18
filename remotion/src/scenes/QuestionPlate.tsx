import type { Question } from "../data/types";
import { TextQuestion } from "./questions/TextQuestion";
import { NumSeriesQuestion } from "./questions/NumSeriesQuestion";
import { ShadedQuestion } from "./questions/ShadedQuestion";
import { PolygonQuestion } from "./questions/PolygonQuestion";
import { DotQuestion } from "./questions/DotQuestion";

/** Dispatches to the right question-type plate. `elapsed` (seconds) drives the
 *  countdown; pass 0 for the static "read" plate (timer full). */
export const QuestionPlate: React.FC<{ q: Question; elapsed: number }> = ({ q, elapsed }) => {
  switch (q.kind) {
    case "text":
      return <TextQuestion q={q} elapsed={elapsed} />;
    case "numseries":
      return <NumSeriesQuestion q={q} elapsed={elapsed} />;
    case "shaded":
      return <ShadedQuestion q={q} elapsed={elapsed} />;
    case "polygon":
      return <PolygonQuestion q={q} elapsed={elapsed} />;
    case "dot":
      return <DotQuestion q={q} elapsed={elapsed} />;
  }
};
