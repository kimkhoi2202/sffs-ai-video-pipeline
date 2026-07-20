import { AbsoluteFill } from "remotion";
import { useFmt } from "../theme/layout";

/**
 * LOCKED IG safe area (@1080x1920): approved margins TOP 220 / BOTTOM 350 /
 * LEFT 120 / RIGHT 120 -> safe box x120-960, y220-1570 (w840 x h1350). Because
 * the box is horizontally centred (centre x = 540 = frame centre), a single
 * UNIFORM scale about the frame centre + a small upward nudge maps the whole
 * 1080x1920 canvas EXACTLY onto the box (no distortion; designs + animations
 * preserved). Matches the approved intro treatment.
 *
 * SHORTS/portrait only: landscape (the 16:9 YouTube master) passes through
 * unchanged. Full-frame layers (plate background, perspective grid, decorative
 * HeroShapes) must render OUTSIDE this wrapper so the plate is one seamless
 * full-frame colour and shapes may still roam the whole frame.
 */
export const SAFE = { top: 220, bottom: 350, left: 120, right: 120 } as const;
const SAFE_SCALE = (1920 - SAFE.top - SAFE.bottom) / 1920; // 1350/1920 = 0.703125
const SAFE_DY = (SAFE.top + (1920 - SAFE.bottom)) / 2 - 1920 / 2; // 895 - 960 = -65

export const SafeArea: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { portrait } = useFmt();
  if (!portrait) return <>{children}</>;
  return (
    <AbsoluteFill style={{ transform: `translateY(${SAFE_DY}px) scale(${SAFE_SCALE})`, transformOrigin: "540px 960px" }}>
      {children}
    </AbsoluteFill>
  );
};
