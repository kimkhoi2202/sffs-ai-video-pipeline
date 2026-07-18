import { COLORS, hardShadow } from "../theme/brand";
import { DM_SANS } from "../theme/fonts";

/**
 * A capsule pill (rounded-full) with a thick black border + hard offset shadow
 * — the "QUESTION X OF 15" header, the tier tag, and the "CORRECT ANSWER"
 * banner. Pills KEEP their shadow (only plate chrome goes flat).
 * Mirrors render_demo_quiz.py `pill_left` / `pill_center`.
 */
export const Pill: React.FC<{
  text: string;
  fill: string;
  textColor?: string;
  fontSize: number;
  tracking?: number;
  padX?: number;
  padY?: number;
  border?: number;
  shadow?: number;
  shadowColor?: string;
  fontWeight?: number;
}> = ({
  text,
  fill,
  textColor = COLORS.ink,
  fontSize,
  tracking = 3,
  padX = 30,
  padY = 16,
  border = 6,
  shadow = 8,
  shadowColor = COLORS.ink,
  fontWeight = 700,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      background: fill,
      color: textColor,
      border: `${border}px solid ${COLORS.ink}`,
      borderRadius: 9999,
      padding: `${padY}px ${padX}px`,
      boxShadow: hardShadow(shadow, shadowColor),
      fontFamily: DM_SANS,
      fontWeight,
      fontSize,
      lineHeight: 1,
      letterSpacing: `${tracking}px`,
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}
  >
    {text}
  </div>
);
