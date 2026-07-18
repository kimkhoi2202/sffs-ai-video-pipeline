import type { ReactNode } from "react";
import { COLORS, hardShadow } from "../theme/brand";
import { DM_SANS } from "../theme/fonts";
import { LetterBadge } from "./LetterBadge";
import type { TextOption } from "../data/types";

/** 2x2 text option grid (flow). Cards keep their hard shadow; badges are flat. */
export const TextOptionsGrid: React.FC<{ options: TextOption[] }> = ({ options }) => (
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 48, rowGap: 36, width: "100%" }}>
    {options.map((o) => (
      <div
        key={o.letter}
        style={{
          height: 150,
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
        <LetterBadge letter={o.letter} size={106} radius={16} border={6} shadow={0} />
        <span style={{ fontFamily: DM_SANS, fontWeight: 700, fontSize: 52, color: COLORS.ink, whiteSpace: "nowrap" }}>
          {o.text}
        </span>
      </div>
    ))}
  </div>
);

/** A row of four shape/figure option cards (flow). */
export const ShapeOptionsRow: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div style={{ display: "flex", gap: 40, width: "100%", alignItems: "stretch" }}>{children}</div>
);

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
      height: 240,
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
