import { BAR, CD, COLORS } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { Card } from "./Card";

/**
 * The top-right countdown box + the bottom depleting bar. Ports the per-frame
 * logic of render_demo_quiz.py `_countdown_sequence`: the number = ceil(total -
 * elapsed) with a 1s hold on 0, a "press" pop (1.16x) on each new second, and
 * the accent bar depleting left-to-right. The countdown BOX keeps its hard
 * shadow (it is chrome, not a prompt box / tile / badge).
 */
export const Countdown: React.FC<{
  elapsed: number;
  total: number;
  accent: string;
}> = ({ elapsed, total, accent }) => {
  const num = Math.max(0, Math.ceil(total - elapsed));
  const frac = Math.max(0, Math.min(1, (total - elapsed) / total));
  const innerW = (BAR.w - 2 * BAR.pad) * frac;
  const withinSecond = elapsed - Math.floor(elapsed);
  const pop = withinSecond < 0.12 && elapsed < total;
  const fontSize = pop ? 74 * 1.16 : 74;

  return (
    <>
      <Card x={CD.x0} y={CD.y0} w={CD.w} h={CD.h} radius={22} border={7} fill={accent} shadow={10} />
      <div
        style={{
          position: "absolute",
          left: CD.x0,
          top: CD.y0,
          width: CD.w,
          height: CD.h,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: ANTON,
          fontSize,
          lineHeight: 1,
          color: COLORS.ink,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {num}
      </div>

      {/* bar track (solid black) + depleting accent fill */}
      <div
        style={{
          position: "absolute",
          left: BAR.x,
          top: BAR.y,
          width: BAR.w,
          height: BAR.h,
          background: COLORS.ink,
          borderRadius: BAR.h / 2,
        }}
      />
      {innerW > 2 ? (
        <div
          style={{
            position: "absolute",
            left: BAR.x + BAR.pad,
            top: BAR.y + BAR.pad,
            width: innerW,
            height: BAR.h - 2 * BAR.pad,
            background: accent,
            borderRadius: (BAR.h - 2 * BAR.pad) / 2,
          }}
        />
      ) : null}
    </>
  );
};
