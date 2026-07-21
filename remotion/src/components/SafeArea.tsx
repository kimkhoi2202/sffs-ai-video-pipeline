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
 *
 * TikTok (portrait) uses its OWN transform (TT_* below): the IG box wastes the
 * top of the frame AND lets TikTok's chrome (right action rail + bottom caption)
 * crowd the plate, so on TikTok we scale the content UP and push it toward the
 * top-left, landing the readable columns inside a TikTok-safe box that clears the
 * rail and caption band. Instagram/YouTube are completely unchanged.
 */
export const SAFE = { top: 220, bottom: 350, left: 120, right: 120 } as const;
const SAFE_SCALE = (1920 - SAFE.top - SAFE.bottom) / 1920; // 1350/1920 = 0.703125
const SAFE_DY = (SAFE.top + (1920 - SAFE.bottom)) / 2 - 1920 / 2; // 895 - 960 = -65

// --- TikTok-only content-safe box + transform (verified vs 2026 TikTok UI) ----
// TikTok organic chrome on a 1080x1920 frame: top tabs/status ~200px, the right
// action rail (like/comment/share/bookmark) ~180px (x >= ~900), and the bottom
// caption/username/CTA band ~480px (y >= ~1440). We map the plate's readable
// columns (design x = M..1080-M) and its top header row onto this box, which
// yields a bigger scale than IG (content fills more of the frame), reclaims the
// wasted top space, and clears the top + bottom danger zones. Horizontally the
// content is CENTERED (equal L/R padding) rather than shifted clear of the right
// action rail, so it overlaps that rail ~40px by design (see TT_BOX below).
export const TT_DANGER = { top: 200, right: 180, bottom: 480 } as const; // px reserved for TikTok UI
// Per the user's call we PREFER horizontally-centered content over dodging the
// right rail: the ~800px content sits with EQUAL L/R padding ((1080-800)/2 = 140
// each side), which pushes its right edge ~40px into the action-rail zone (x>=900)
// — accepted. Width (=> TT_SCALE ~0.845) and the vertical treatment are unchanged.
const TT_CONTENT_W = 800; // on-screen width of the scaled content columns (unchanged)
/** TikTok content-safe box: horizontally centred; top clears the tabs; bottom clears the caption. */
export const TT_BOX = { x0: (1080 - TT_CONTENT_W) / 2, y0: TT_DANGER.top + 14, x1: (1080 + TT_CONTENT_W) / 2, y1: 1920 - TT_DANGER.bottom } as const; // x140..940, y214..1440
const TT_CONTENT_L = 64; // design content left  (== portrait M)
const TT_CONTENT_R = 1016; // design content right (== 1080 - M)
const TT_CONTENT_TOP = 48; // design topmost content (countdown chip / header row)
export const TT_SCALE = (TT_BOX.x1 - TT_BOX.x0) / (TT_CONTENT_R - TT_CONTENT_L); // ~0.845 (> IG 0.703 => bigger)
const TT_TX = TT_BOX.x0 - TT_SCALE * TT_CONTENT_L; // translate so content-left -> TT_BOX.x0
const TT_TY = TT_BOX.y0 - TT_SCALE * TT_CONTENT_TOP; // translate so content-top  -> TT_BOX.y0
/** TikTok timer bar: pulled UP to just below the option block so that, after the
 *  up-scaled transform, it lands ABOVE the bottom caption band (design y). */
export const TT_BAR_Y = 1390;

/**
 * Design-space Y band that the TikTok transform maps ONTO the on-screen content-
 * safe band [TT_DANGER.top .. 1920 - TT_DANGER.bottom] = [200 .. 1440]. Inverting
 * screenY = TT_TY + TT_SCALE*designY gives the design coordinates QuestionFrame
 * uses to VERTICALLY CENTRE the question+options block inside that safe band on
 * TikTok (so the block's midpoint lands on the safe band's centre, y=820 screen).
 */
export const TT_BAND_TOP = (TT_DANGER.top - TT_TY) / TT_SCALE; // ~31 (design)
export const TT_BAND_BOTTOM = (1920 - TT_DANGER.bottom - TT_TY) / TT_SCALE; // ~1507 (design)

export const SafeArea: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { portrait, platform } = useFmt();
  if (!portrait) return <>{children}</>;
  if (platform === "tiktok") {
    return (
      <AbsoluteFill style={{ transform: `translate(${TT_TX}px, ${TT_TY}px) scale(${TT_SCALE})`, transformOrigin: "0 0" }}>
        {children}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ transform: `translateY(${SAFE_DY}px) scale(${SAFE_SCALE})`, transformOrigin: "540px 960px" }}>
      {children}
    </AbsoluteFill>
  );
};
