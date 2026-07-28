import { BAR, CD, COLORS } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { Card } from "./Card";
import { TT_BAR_Y, usesChromeSafeBox } from "./SafeArea";

/**
 * The top-right countdown box + the bottom depleting bar. Ports the per-frame
 * logic of render_demo_quiz.py `_countdown_sequence`: the number = ceil(total -
 * elapsed) with a 1s hold on 0, a "press" pop (1.16x) on each new second, and
 * the accent bar depleting left-to-right. The countdown BOX keeps its hard
 * shadow (it is chrome). The chip + bar reposition for the portrait frame.
 */
export const Countdown: React.FC<{
  elapsed: number;
  total: number;
  accent: string;
}> = ({ elapsed, total, accent }) => {
  const { w, h, portrait, M, platform } = useFmt();
  // Chip (top-right) + depleting bar (bottom), format-aware. TikTok and YouTube Shorts
  // pull the bar UP (TT_BAR_Y) so it clears the bottom caption band after the bigger
  // transform — it has to follow the same predicate as the transform itself.
  const chip = portrait ? { w: 118, h: 104, x0: w - M - 118, y0: 48 } : { w: CD.w, h: CD.h, x0: CD.x0, y0: CD.y0 };
  const barY = usesChromeSafeBox(platform) ? TT_BAR_Y : h - 118;
  const bar = portrait ? { x: M, y: barY, w: w - 2 * M, h: 42, pad: 8 } : { x: BAR.x, y: BAR.y, w: BAR.w, h: BAR.h, pad: BAR.pad };

  const num = Math.max(0, Math.ceil(total - elapsed));
  const frac = Math.max(0, Math.min(1, (total - elapsed) / total));
  const innerW = (bar.w - 2 * bar.pad) * frac;
  const withinSecond = elapsed - Math.floor(elapsed);
  const pop = withinSecond < 0.12 && elapsed < total;
  const base = portrait ? 64 : 74;
  const fontSize = pop ? base * 1.16 : base;

  return (
    <>
      <Card x={chip.x0} y={chip.y0} w={chip.w} h={chip.h} radius={22} border={7} fill={accent} shadow={10} />
      <div
        style={{
          position: "absolute",
          left: chip.x0,
          top: chip.y0,
          width: chip.w,
          height: chip.h,
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
          left: bar.x,
          top: bar.y,
          width: bar.w,
          height: bar.h,
          background: COLORS.ink,
          borderRadius: bar.h / 2,
        }}
      />
      {innerW > 2 ? (
        <div
          style={{
            position: "absolute",
            left: bar.x + bar.pad,
            top: bar.y + bar.pad,
            width: innerW,
            height: bar.h - 2 * bar.pad,
            background: accent,
            borderRadius: (bar.h - 2 * bar.pad) / 2,
          }}
        />
      ) : null}
    </>
  );
};
