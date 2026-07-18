import type { GlyphKind } from "../components/ShapeGlyph";
import type { PolyShape } from "../components/Polygon";
import type { DotPos } from "../components/DotSquare";

export type TextOption = { letter: string; text: string };
export type ShapeOption = { letter: string; shape: GlyphKind; filled: boolean };
export type PolyOption = { letter: string; poly: PolyShape };
export type DotOption = { letter: string; pos: DotPos };

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

export type Question = TextQuestion | NumSeriesQuestion | ShadedQuestion | PolygonQuestion | DotQuestion;
