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

// Locked IG safe box @1080x1920.
const SAFE = { x0: 120, y0: 220, x1: 960, y1: 1570 } as const;
// Bottom-right narrator card, kept modest ("a narrator, not dominating"). Its
// bottom is RAISED to clear the question countdown timer bar (a full-width green
// bar at ~screen y1493): the card + its 12px hard shadow sit just above it. The
// right edge (+shadow) stays inside the safe box, and the left edge (684) clears
// the centre-pinned "SCROLL FOR MORE" cue on the outro (its text ends ~x656).
const CARD = { size: 256 } as const;
const cardX = SAFE.x1 - 20 - CARD.size; // 684 (right edge 940, +12 shadow = 952 < 960)
const cardY = 1478 - CARD.size; // 1222 (bottom 1478, +12 shadow = 1490 < bar top ~1493)

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
          boxShadow: hardShadow(12),
        }}
      />
      <div style={{ position: "absolute", inset: 18 }}>
        <BrainMascot mouth={mouth} />
      </div>
    </div>
  );
};
