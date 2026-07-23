import type { ReactNode } from "react";
import { COLORS, hardShadow } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { DM_SANS } from "../theme/fonts";
import { LetterBadge } from "./LetterBadge";
import type { TextOption } from "../data/types";

/** Portrait 2x2 shape-option grid: card height + row gap (design px). Exported so
 *  a TALL type (FIGURE MATRIX) can compute its option-block height for the TikTok
 *  scale-to-fit (QuestionFrame ttFit). Landscape keeps its own inline values. */
export const SHAPE_CARD_H = 240;
export const SHAPE_ROW_GAP = 30;

/** Text option grid. Landscape = 2x2; portrait = a single stacked column of 4
 *  full-width rows. Cards keep their hard shadow; badges are flat. */
export const TextOptionsGrid: React.FC<{ options: TextOption[] }> = ({ options }) => {
  const { portrait } = useFmt();
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: portrait ? "1fr" : "1fr 1fr",
        columnGap: 48,
        rowGap: portrait ? 22 : 36,
        width: "100%",
      }}
    >
      {options.map((o) => (
        <div
          key={o.letter}
          style={{
            height: portrait ? 132 : 150,
            boxSizing: "border-box",
            background: COLORS.paper,
            border: `7px solid ${COLORS.ink}`,
            borderRadius: 26,
            boxShadow: hardShadow(12),
            display: "flex",
            alignItems: "center",
            paddingLeft: 22,
            paddingRight: 30,
            gap: 34,
          }}
        >
          <LetterBadge letter={o.letter} size={portrait ? 96 : 106} radius={16} border={6} shadow={0} />
          <span style={{ fontFamily: DM_SANS, fontWeight: 700, fontSize: portrait ? 54 : 52, color: COLORS.ink, whiteSpace: "nowrap" }}>
            {o.text}
          </span>
        </div>
      ))}
    </div>
  );
};

/** A row of four shape/figure option cards. Landscape = one flex row; portrait =
 *  a 2x2 grid so the cards stay large enough on the narrow frame. */
export const ShapeOptionsRow: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { portrait } = useFmt();
  if (portrait) {
    return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: SHAPE_ROW_GAP, width: "100%" }}>{children}</div>;
  }
  return <div style={{ display: "flex", gap: 40, width: "100%", alignItems: "stretch" }}>{children}</div>;
};

/** One shape/figure option card: shadowed card, FLAT letter badge (top-left),
 *  centered content (a shape, polygon, or dot-square column). */
export const ShapeOptionCard: React.FC<{ letter: string; badgeSize?: number; children: ReactNode }> = ({
  letter,
  badgeSize = 78,
  children,
}) => (
  <div
    style={{
      flex: 1,
      height: SHAPE_CARD_H,
      boxSizing: "border-box",
      position: "relative",
      background: COLORS.paper,
      border: `7px solid ${COLORS.ink}`,
      borderRadius: 26,
      boxShadow: hardShadow(12),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    <div style={{ position: "absolute", left: 22, top: 20 }}>
      <LetterBadge letter={letter} size={badgeSize} radius={16} border={6} shadow={0} />
    </div>
    {children}
  </div>
);
