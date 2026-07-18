import { COLORS } from "../theme/brand";
import { DM_SANS } from "../theme/fonts";
import { Card } from "./Card";
import { LetterBadge } from "./LetterBadge";

/**
 * A text A/B/C/D option card: the answer-row bar KEEPS its hard shadow, the
 * letter badge inside is FLAT (approved plate spec). Ports option_tile from
 * render_demo_quiz.py (inset 22, badge = tile height - 2*inset, DM Sans Bold).
 */
export const TextOptionCard: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  letter: string;
  text: string;
}> = ({ x, y, w, h, letter, text }) => {
  const inset = 22;
  const badge = h - 2 * inset;
  const textLeft = x + inset + badge + 34;
  return (
    <>
      <Card x={x} y={y} w={w} h={h} radius={26} border={7} fill={COLORS.paper} shadow={12} />
      <div style={{ position: "absolute", left: x + inset, top: y + inset }}>
        <LetterBadge letter={letter} size={badge} radius={16} border={6} shadow={0} />
      </div>
      <div
        style={{
          position: "absolute",
          left: textLeft,
          top: y,
          width: x + w - textLeft - 30,
          height: h,
          display: "flex",
          alignItems: "center",
          fontFamily: DM_SANS,
          fontWeight: 700,
          fontSize: 52,
          color: COLORS.ink,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </div>
    </>
  );
};
