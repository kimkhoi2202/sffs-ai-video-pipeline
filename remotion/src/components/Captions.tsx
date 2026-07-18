import { useMemo } from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { CAPTION, COLORS } from "../theme/brand";
import { DM_SANS } from "../theme/fonts";
import type { TimelineData } from "../full/timeline";
import { buildSmartPhrases } from "../lib/phrases";

/**
 * Burned-in PHRASE captions with a calm, Emil-style transition (replaces the old
 * jittery per-word pop). Each phrase is shown as ONE uniform unit; swaps use a
 * short crossfade: ENTER = fade 0->1 + translateY 10px->0, ease-out ~200ms;
 * EXIT = fade ->0, ease-out ~133ms (quicker than enter). Only transform +
 * opacity animate, and every phrase is anchored to the SAME fixed center in the
 * safe band, so 1- vs 2-line phrases never shift layout. No per-word scale,
 * weight, or color change. White text + thick black outline reads on every bg.
 * Swaps are sequential (each phrase fades out over its last frames, the next
 * fades in) so two phrases never overlap on screen - a calm, clean handoff.
 */
const ENTER = 6; // frames (~200ms) fade + rise in
const EXIT = 4; // frames (~133ms) fade out (quicker than enter)
const RISE = 10; // px translateY on enter
const EASE = Easing.out(Easing.cubic); // ease-out (enter + exit)

export const Captions: React.FC<{ timeline: TimelineData }> = ({ timeline }) => {
  const frame = useCurrentFrame();
  const phrases = useMemo(() => buildSmartPhrases(timeline), [timeline]);
  const cy = CAPTION.top + CAPTION.height / 2; // fixed vertical anchor

  const visible = phrases.filter((p) => frame >= p.s && frame <= p.e);
  if (!visible.length) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {visible.map((p) => {
        const inP = interpolate(frame, [p.s, p.s + ENTER], [0, 1], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const outP = interpolate(frame, [p.e - EXIT, p.e], [1, 0], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const opacity = Math.min(inP, outP);
        const y = interpolate(frame, [p.s, p.s + ENTER], [RISE, 0], { easing: EASE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div
            key={p.s}
            style={{
              position: "absolute",
              left: "50%",
              top: cy,
              transform: `translate(-50%, -50%) translateY(${y}px)`,
              width: 1740,
              textAlign: "center",
              opacity,
              fontFamily: DM_SANS,
              fontWeight: 800,
              fontSize: 40,
              lineHeight: 1.1,
              color: COLORS.paper,
              textTransform: "uppercase",
              letterSpacing: "0.01em",
              WebkitTextStroke: "6px #000",
              paintOrder: "stroke fill",
            }}
          >
            {p.text}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
