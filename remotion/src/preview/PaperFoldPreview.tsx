import { COLORS } from "../theme/brand";
import { QuestionPlate } from "../scenes/QuestionPlate";
import { QuestionReveal } from "../scenes/QuestionReveal";
import { unfold, type FoldDir, type HoleCell } from "../data/fold";
import type { FoldQuestion } from "../data/types";

/**
 * DEV-only preview for iterating on the PAPER FOLDING plate + reveal without
 * rendering a whole short. Renders one sample fold question as either its read
 * plate or its answer reveal (pick via props). Still-only; not part of any cut.
 *   npx remotion still PaperFoldPreview out.png --props='{"which":0,"mode":"read"}'
 */
const mk = (
  idx: number,
  folds: FoldDir[],
  punches: HoleCell[],
  options: { letter: string; holes: HoleCell[] }[],
  ansLetter: string,
  ansLabel: string,
  explanation: string,
  prompt = "WHAT DOES IT LOOK LIKE UNFOLDED?",
): FoldQuestion => ({
  kind: "fold",
  idx,
  bg: COLORS.blue,
  tier: "PAPER FOLDING",
  tierColor: COLORS.mint,
  accent: COLORS.yellow,
  countdown: 7,
  prompt,
  grid: 4,
  folds,
  punches,
  options,
  ansLetter,
  ansLabel,
  ansHoles: unfold(folds, punches, 4),
  explanation,
  qDur: 0,
  rDur: 0,
});

const SAMPLES: FoldQuestion[] = [
  mk(
    1,
    ["left"],
    [{ r: 1, c: 0 }],
    [
      { letter: "A", holes: [{ r: 1, c: 0 }, { r: 1, c: 3 }] },
      { letter: "B", holes: [{ r: 1, c: 0 }] },
      { letter: "C", holes: [{ r: 1, c: 0 }, { r: 1, c: 1 }] },
      { letter: "D", holes: [{ r: 0, c: 0 }, { r: 3, c: 0 }] },
    ],
    "A",
    "2 HOLES",
    "The fold is a mirror, so the one hole copies across the crease to make two holes.",
  ),
  mk(
    2,
    ["left", "up"],
    [{ r: 0, c: 0 }],
    [
      { letter: "A", holes: [{ r: 0, c: 0 }, { r: 0, c: 3 }] },
      { letter: "B", holes: [{ r: 0, c: 0 }, { r: 0, c: 3 }, { r: 3, c: 0 }, { r: 3, c: 3 }] },
      { letter: "C", holes: [{ r: 0, c: 0 }] },
      { letter: "D", holes: [{ r: 0, c: 0 }, { r: 3, c: 3 }] },
    ],
    "B",
    "4 HOLES",
    "Two folds make two mirrors, so one hole becomes four, one in each corner.",
  ),
];

export const PaperFoldPreview: React.FC<{ which?: number; mode?: "read" | "reveal" }> = ({ which = 0, mode = "read" }) => {
  const q = SAMPLES[which] ?? SAMPLES[0];
  return mode === "reveal" ? <QuestionReveal q={q} /> : <QuestionPlate q={q} elapsed={0} pos={which + 1} total={SAMPLES.length} />;
};
