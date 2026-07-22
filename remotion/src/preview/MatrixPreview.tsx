import { AbsoluteFill } from "remotion";
import { PlatformProvider } from "../theme/layout";
import { QuestionPlate } from "../scenes/QuestionPlate";
import { QuestionReveal } from "../scenes/QuestionReveal";
import { COLORS } from "../theme/brand";
import type { MatrixQuestion, Question } from "../data/types";

/**
 * Still-only preview for the MATRIX-FAMILY nonverbal plates (Figure Matrix 2x2,
 * Figure Analogy v2, Visual Odd-One-Out). Renders ANY question (or its reveal)
 * full-frame at 1080x1920 via --props, so a single `remotion still` gives a fast
 * on-brand check of a plate before committing to a full MP4 sample. Purely a dev
 * aid — never part of a published cut. Defaults to a representative Figure Matrix.
 */
const DEFAULT_Q: MatrixQuestion = {
  kind: "matrix",
  idx: 1,
  bg: COLORS.blue,
  tier: "FIGURE MATRIX",
  tierColor: COLORS.mint,
  accent: COLORS.yellow,
  countdown: 6,
  prompt: "WHICH SHAPE COMPLETES THE GRID?",
  cells: [
    { shape: "arrow", filled: false },
    { shape: "arrow", filled: true, rotate: 90 },
    { shape: "triangle", filled: false },
  ],
  options: [
    { letter: "A", fig: { shape: "triangle", filled: true, rotate: 90 } },
    { letter: "B", fig: { shape: "triangle", filled: true } },
    { letter: "C", fig: { shape: "triangle", filled: false, rotate: 90 } },
    { letter: "D", fig: { shape: "arrow", filled: true, rotate: 90 } },
  ],
  ans: { shape: "triangle", filled: true, rotate: 90 },
  ansLetter: "A",
  ansLabel: "FILLED, TURNED RIGHT",
  explanation:
    "Each shape turns a quarter-turn clockwise and gets filled in, so the empty triangle becomes a filled triangle pointing right.",
  qDur: 0,
  rDur: 0,
};

export const MatrixPreview: React.FC<{ q?: Question; reveal?: boolean }> = ({ q = DEFAULT_Q, reveal = false }) => (
  <PlatformProvider platform="instagram">
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
      {reveal ? <QuestionReveal q={q} /> : <QuestionPlate q={q} elapsed={0} pos={1} total={5} />}
    </AbsoluteFill>
  </PlatformProvider>
);
