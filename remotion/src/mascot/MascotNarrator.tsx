import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardShadow } from "../theme/brand";
import { BrainMascot } from "./BrainMascot";
import { mouthParamsAtTime, SHAPE_PARAMS, type MouthCue } from "./visemes";

/**
 * The bottom-right talking brain-mascot NARRATOR, overlaid on a full short and
 * lip-synced to EVERY VO clip on the timeline. Given the timeline's narration
 * clips (each `{ from, durF, cues }`), it finds the clip active at the current
 * (global) frame, converts to that clip's LOCAL time, and drives the mouth from
 * its Rhubarb visemes; during VO-silent gaps it idles at rest (X). The brain's
 * blink/bob idle runs on the global frame, so it feels alive the whole video.
 *
 * Sync fix carried over from the POC: the muxed AAC track has a constant
 * 2048-sample (~42.7ms) encoder-priming delay (no compensating edit list), so
 * the audio is HEARD ~42.7ms after each clip's `from`. We subtract that from the
 * per-clip local time: t = (frame - from)/fps - AUDIO_LAG.
 */
export type NarratorClip = { from: number; durF: number; cues: MouthCue[] };

/** Constant AAC encoder-priming lag of the muxed track (2048 samples @48kHz). */
export const NARRATOR_AUDIO_LAG_SEC = 2048 / 48000;

// Locked IG safe box @1080x1920 (SafeArea's margins expressed as a pixel box).
const SAFE = { x0: 120, y0: 220, x1: 960, y1: 1570 } as const;

/** Bottom-right narrator card, kept modest ("a narrator, not dominating"). The
 *  right edge (+shadow) stays inside the safe box, and the left edge (684)
 *  clears the centre-pinned "SCROLL FOR MORE" cue on the outro (text ends ~x656). */
const CARD = { size: 256, shadow: 12 } as const;
const cardX = SAFE.x1 - 20 - CARD.size; // 684 (right edge 940, +12 shadow = 952 < 960)

// --- Vertical placement -----------------------------------------------------
// The mascot (its hard shadow INCLUDED) is centred in the empty band between the
// LAST option row's shadow and the bottom timer bar, and never touches the bar.
// Every line is DERIVED from the shared plate-layout constants (not a magic
// pixel) so it tracks the safe box, the option grid, and the bar position.
//
// The narrator is overlaid on the raw 1080x1920 canvas (OUTSIDE <SafeArea/>),
// while the plate (options + bar) lives INSIDE <SafeArea/>, which uniformly
// squeezes the whole canvas into the safe box. We map plate-local Y through the
// SAME transform (derived from the SAFE box above; identical to SafeArea's).
const FRAME_H = 1920;
const SAFE_SCALE = (SAFE.y1 - SAFE.y0) / FRAME_H; // 1350/1920 = 0.703125
const SAFE_DY = (SAFE.y0 + SAFE.y1) / 2 - FRAME_H / 2; // 895 - 960 = -65
/** plate-local Y (inside SafeArea) -> raw canvas Y (where the narrator lives). */
const safeScreenY = (localY: number): number => FRAME_H / 2 + SAFE_DY + SAFE_SCALE * (localY - FRAME_H / 2);

// Bottom timer bar (Countdown, portrait): a full-width bar at local y = h - 118.
const BAR_BOTTOM_OFFSET = 118;
const barTopScreen = safeScreenY(FRAME_H - BAR_BOTTOM_OFFSET); // ~1487

// Last option row's shadow-inclusive bottom, from the QuestionFrame portrait
// flex band + the OptionCards portrait grid: the prompt/options block sits at
// its natural height, biased UP (spacers 2:3) between the header and bar zones,
// with the four option rows as the block's last element (each a 12px shadow).
const HEADER_ZONE = 250; // QuestionFrame portrait headerZone
const BAR_ZONE = 150; // QuestionFrame portrait barZone
const OPTIONS_GAP = 40; // QuestionFrame portrait prompt -> options gap
const SPACER_TOP = 2; // QuestionFrame block bias (top:bottom = 2:3 -> biased up)
const SPACER_BOTTOM = 3;
const OPT_H = 132; // OptionCards portrait row height
const OPT_ROW_GAP = 22; // OptionCards portrait rowGap
const OPT_SHADOW = 12; // hardShadow(12) on each option row
const N_OPTIONS = 4;
// Representative single-line prompt (odd-one-out / "what comes next" hook):
// TextQuestion portrait font = round(questionFontSize * 0.72); PromptTitle adds
// lineHeight 1.08 + 26px vertical padding + 8px border, top and bottom.
const PROMPT_FONT = Math.round(96 * 0.72);
const PROMPT_H = Math.round(PROMPT_FONT * 1.08) + 2 * 26 + 2 * 8;

const OPTIONS_H = N_OPTIONS * OPT_H + (N_OPTIONS - 1) * OPT_ROW_GAP; // 594
const BLOCK_H = PROMPT_H + OPTIONS_GAP + OPTIONS_H;
const FLEX_BAND = FRAME_H - BAR_ZONE - HEADER_ZONE; // free height between the zones
const BLOCK_TOP = HEADER_ZONE + ((FLEX_BAND - BLOCK_H) * SPACER_TOP) / (SPACER_TOP + SPACER_BOTTOM);
const lastOptionShadowBottomScreen = safeScreenY(BLOCK_TOP + BLOCK_H + OPT_SHADOW); // ~1159

// Centre the mascot's shadow-inclusive box in the [last option, bar] gap, then
// clamp so neither the card nor its shadow can ever touch the bar (or overlap
// the options) even if the plate constants shift.
const MASCOT_BOX = CARD.size + CARD.shadow; // 268 (card + its hard shadow)
const MIN_CLEARANCE = 16;
const gapCentre = (lastOptionShadowBottomScreen + barTopScreen) / 2;
const cardY = Math.round(
  Math.max(
    lastOptionShadowBottomScreen + MIN_CLEARANCE,
    Math.min(gapCentre - MASCOT_BOX / 2, barTopScreen - MASCOT_BOX - MIN_CLEARANCE),
  ),
); // ~1189 (was a hardcoded 1222): centred in the gap, ~30px clear of the bar

export const MascotNarrator: React.FC<{ clips: NarratorClip[]; audioLagSec?: number }> = ({
  clips,
  audioLagSec = NARRATOR_AUDIO_LAG_SEC,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Which VO clip is speaking now? (clips are timeline-ordered + non-overlapping.)
  let mouth = SHAPE_PARAMS.X;
  for (const c of clips) {
    if (frame >= c.from && frame < c.from + c.durF) {
      const t = (frame - c.from) / fps - audioLagSec;
      mouth = mouthParamsAtTime(c.cues, t);
      break;
    }
  }

  // Gentle cold-open entrance (transform/opacity only).
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.6 }, durationInFrames: 16 });
  const popScale = interpolate(pop, [0, 1], [0.86, 1]);
  const opacity = interpolate(pop, [0, 1], [0, 1], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        left: cardX,
        top: cardY,
        width: CARD.size,
        height: CARD.size,
        transform: `scale(${popScale})`,
        transformOrigin: "90% 90%",
        opacity,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: COLORS.paper,
          border: "7px solid #000",
          borderRadius: 36,
          boxShadow: hardShadow(CARD.shadow),
        }}
      />
      <div style={{ position: "absolute", inset: 18 }}>
        <BrainMascot mouth={mouth} />
      </div>
    </div>
  );
};
