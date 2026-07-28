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
 * TikTok AND YouTube SHORTS (portrait) use the TT_* transform below: the IG box
 * wastes the top of the frame AND lets their chrome (right action rail + bottom
 * caption/title band) crowd the plate, so we scale the content UP and push it toward
 * the top-left, landing the readable columns inside a box that clears both. Instagram
 * keeps the IG box, which does NOT clear the Shorts player.
 *
 * WHY YOUTUBE SHARES TIKTOK'S BOX RATHER THAN GETTING A THIRD TRANSFORM. The Shorts
 * player's own content-safe box works out to x140-940, y214-1460 — the TikTok box to
 * within 20px, and TikTok's bottom edge (1440) is the HIGHER of the two, so the TikTok
 * cut is a strict subset of the Shorts-safe area and already clears it. A third
 * transform would be 20px of difference and a second thing to keep in step with
 * QuestionFrame and Countdown, both of which read the same predicate.
 */
export const SAFE = { top: 220, bottom: 350, left: 120, right: 120 } as const;
const SAFE_SCALE = (1920 - SAFE.top - SAFE.bottom) / 1920; // 1350/1920 = 0.703125
const SAFE_DY = (SAFE.top + (1920 - SAFE.bottom)) / 2 - 1920 / 2; // 895 - 960 = -65

// --- Chrome-safe box + transform, used by TikTok AND YouTube Shorts --------------
// (verified vs 2026 TikTok UI; the Shorts player's box is the same to within 20px and
// is the LOOSER of the two, so this cut clears both.)
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
 * Chrome-safe DESIGN band for a TOO-TALL TikTok question block. On TikTok the two
 * header pills (Q# count + tier tag) are pinned STACKED at design y≈62 and reach
 * ~y224 with their hard shadow, and the depleting progress bar is pulled up to
 * TT_BAR_Y. QuestionFrame true-centres the question block in the full safe band,
 * which is fine for short blocks but lets a TALL block (the 2x2 FIGURE MATRIX:
 * prompt + two rows of 290px tiles + two rows of option cards ≈ 1332px design)
 * rise INTO the pills at the top and push its options UNDER the bar at the bottom.
 * When a block's natural height exceeds this band, QuestionFrame uniformly scales
 * it to fit BETWEEN the pills (top) and the bar (bottom) so it overlaps NEITHER.
 * Short blocks never reach this band and are rendered byte-for-byte unchanged.
 */
export const TT_DENSE_TOP = 246; // design y: just below the stacked header pills (+ shadow)
export const TT_DENSE_BOTTOM = TT_BAR_Y - 22; // design y (1368): just above the pulled-up progress bar

/**
 * Design-space Y band that the TikTok transform maps ONTO the on-screen content-
 * safe band [TT_DANGER.top .. 1920 - TT_DANGER.bottom] = [200 .. 1440]. Inverting
 * screenY = TT_TY + TT_SCALE*designY gives the design coordinates QuestionFrame
 * uses to VERTICALLY CENTRE the question+options block inside that safe band on
 * TikTok (so the block's midpoint lands on the safe band's centre, y=820 screen).
 */
export const TT_BAND_TOP = (TT_DANGER.top - TT_TY) / TT_SCALE; // ~31 (design)
export const TT_BAND_BOTTOM = (1920 - TT_DANGER.bottom - TT_TY) / TT_SCALE; // ~1507 (design)

/**
 * Does this platform use the tighter, up-scaled TT_* safe box (rather than the IG box)?
 *
 * ONE predicate, exported, because the transform is only a third of the story: the
 * QuestionFrame band and the Countdown bar position have to agree with it or the
 * content is laid out for one box and then transformed into another. Three separate
 * `platform === "tiktok"` checks is how those drift apart.
 */
export const usesChromeSafeBox = (platform: string): boolean =>
  platform === "tiktok" || platform === "youtube";

export const SafeArea: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { portrait, platform } = useFmt();
  if (!portrait) return <>{children}</>;
  if (usesChromeSafeBox(platform)) {
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
