import type { GlyphKind } from "../components/ShapeGlyph";
import type { PolyShape } from "../components/Polygon";
import type { DotPos } from "../components/DotSquare";
import type { FigState } from "../components/FigureCell";

export type TextOption = { letter: string; text: string };
export type ShapeOption = { letter: string; shape: GlyphKind; filled: boolean };
export type PolyOption = { letter: string; poly: PolyShape };
export type DotOption = { letter: string; pos: DotPos };
/** MATRIX-FAMILY option: a figure described by the shared transform vocabulary. */
export type FigureOption = { letter: string; fig: FigState };

type Common = {
  idx: number;
  bg: string;
  tier: string;
  tierColor: string;
  accent: string; // countdown box + depleting bar (Python cd_accent == bar_accent)
  countdown: number; // seconds
  ansLetter: string;
  ansLabel: string;
  explanation: string;
  qDur: number; // question narration duration (s)
  rDur: number; // reveal narration duration (s)
};

export type TextQuestion = Common & {
  kind: "text";
  question: string; // may contain \n hard breaks
  questionFontSize: number;
  options: TextOption[];
};
export type NumSeriesQuestion = Common & {
  kind: "numseries";
  prompt: string;
  seq: string[];
  options: TextOption[];
};
export type ShadedQuestion = Common & {
  kind: "shaded";
  prompt: string;
  leftShape: GlyphKind;
  rightShape: GlyphKind;
  options: ShapeOption[];
  ansShape: GlyphKind;
  ansFilled: boolean;
};
export type PolygonQuestion = Common & {
  kind: "polygon";
  prompt: string;
  seq: number[];
  options: PolyOption[];
  ansShape: PolyShape;
};
export type DotQuestion = Common & {
  kind: "dot";
  prompt: string;
  seq: DotPos[];
  options: DotOption[];
  ansPos: DotPos;
};

// --- MATRIX-FAMILY nonverbal types (new; see content/new-question-types-proposal.md
//     tiers 6-8). All three share the FigState transform vocabulary (FigureCell). ---

/** Figure Matrix 2x2: a 2x2 grid whose top row states the rule (cell 0 -> cell 1)
 *  and whose bottom row applies it (cell 2 -> ?). `cells` are [TL, TR, BL]; the
 *  bottom-right is the "?" the viewer must complete. `ans` is the correct figure. */
export type MatrixQuestion = Common & {
  kind: "matrix";
  prompt: string;
  cells: [FigState, FigState, FigState];
  options: FigureOption[];
  ans: FigState;
};

/** Figure Analogy v2: A : B :: C : ? with the full transform vocabulary (rotate /
 *  count / size / fill), not just the empty->filled shade of the `shaded` kind. */
export type Analogy2Question = Common & {
  kind: "analogy2";
  prompt: string;
  a: FigState;
  b: FigState;
  c: FigState;
  options: FigureOption[];
  ans: FigState;
};

/** Visual Odd-One-Out (Figure Classification): four figures, one differs by
 *  shape / fill / rotation / count. The odd one is `ansLetter`; `ans` mirrors it. */
export type FigureOddQuestion = Common & {
  kind: "figure-odd";
  prompt: string;
  options: FigureOption[];
  ans: FigState;
};

export type Question =
  | TextQuestion
  | NumSeriesQuestion
  | ShadedQuestion
  | PolygonQuestion
  | DotQuestion
  | MatrixQuestion
  | Analogy2Question
  | FigureOddQuestion;
