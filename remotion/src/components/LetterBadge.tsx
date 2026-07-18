import { BADGE_COLORS, COLORS, hardShadow } from "../theme/brand";
import { ANTON } from "../theme/fonts";

/**
 * The small colored A/B/C/D letter badge. Per the approved plate spec these read
 * FLAT (no offset shadow) even when the option ROW bar around them keeps its
 * shadow — so `shadow` defaults to 0.
 */
export const LetterBadge: React.FC<{
  letter: string;
  size: number;
  radius?: number;
  border?: number;
  shadow?: number;
}> = ({ letter, size, radius = 16, border = 6, shadow = 0 }) => (
  <div
    style={{
      width: size,
      height: size,
      boxSizing: "border-box",
      background: BADGE_COLORS[letter],
      border: `${border}px solid ${COLORS.ink}`,
      borderRadius: radius,
      boxShadow: hardShadow(shadow),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: ANTON,
      fontSize: size * 0.6,
      lineHeight: 1,
      color: COLORS.ink,
    }}
  >
    {letter}
  </div>
);
