import { AbsoluteFill, Audio, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardShadow } from "../theme/brand";
import { ANTON, DM_SANS } from "../theme/fonts";
import { BrainMascot } from "./BrainMascot";
import { mouthParamsAtTime, type RhubarbJson } from "./visemes";
import introRhubarb from "./data/intro.rhubarb.json";

/**
 * STANDALONE proof-of-concept: the talking brain-mascot narrator lip-syncing one
 * existing ElevenLabs line (audio/narration/intro.mp3) over a simple sample quiz
 * plate. Self-contained — does NOT touch the shared FullVideo/timeline pipeline.
 *
 * The mascot is parked lower-right INSIDE the locked IG safe box (x120–960,
 * y220–1570 @1080x1920) so it clears the platform's action rail, sized as a
 * narrator (not dominating), inside a white ink-outlined card so it reads on any
 * background.
 */

const CUES = (introRhubarb as unknown as RhubarbJson).mouthCues;
const AUDIO = "audio/narration/intro.mp3";
const VO_DURATION = introRhubarb.metadata?.duration ?? CUES[CUES.length - 1].end;
const FPS = 30;

/**
 * The muxed AAC track carries a constant 2048-sample (~42.7ms @48kHz) encoder
 * priming delay and the container has NO compensating edit list (audio
 * start_time = 0), so the audio is actually HEARD ~42.7ms later than frame 0.
 * We therefore shift the viseme lookup back by the same amount so the mouth
 * matches what's audible. Measured by cross-correlating the render's audio
 * against the source mp3: constant 42.7ms, zero drift.
 */
const AUDIO_LAG_SEC = 2048 / 48000;

/** Composition length: the VO plus a short breath so the last shape settles. */
export const MASCOT_POC_DURATION = Math.ceil((VO_DURATION + 0.5) * FPS);

// Locked IG safe box @1080x1920.
const SAFE = { x0: 120, y0: 220, x1: 960, y1: 1570 } as const;

// Bottom-right narrator card, inset from the safe edges.
const CARD = { size: 300, inset: 24 };
const cardX = SAFE.x1 - CARD.inset - CARD.size;
const cardY = SAFE.y1 - CARD.inset - CARD.size;

const Pill: React.FC<{ text: string; fill: string; left?: number; right?: number }> = ({ text, fill, left, right }) => (
  <div
    style={{
      position: "absolute",
      top: SAFE.y0 + 8,
      left,
      right,
      background: fill,
      border: "5px solid #000",
      borderRadius: 999,
      padding: "14px 26px",
      fontFamily: DM_SANS,
      fontWeight: 800,
      fontSize: 30,
      letterSpacing: 1,
      color: COLORS.ink,
      boxShadow: hardShadow(7),
    }}
  >
    {text}
  </div>
);

const SEQ: { glyph: string; fill: string }[] = [
  { glyph: "\u25CF", fill: COLORS.coral },
  { glyph: "\u25A0", fill: COLORS.yellow },
  { glyph: "\u25B2", fill: COLORS.green },
  { glyph: "?", fill: COLORS.paper },
];

export const MascotPoc: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Lookup time is relative to the AUDIO's true (heard) start: frame 0 minus the
  // measured constant AAC priming lag. fps comes straight from the composition
  // (30) so seconds->cue conversion can't drift.
  const t = frame / fps - AUDIO_LAG_SEC;
  const mouth = mouthParamsAtTime(CUES, t);

  // Gentle pop-in for the narrator card (transform-only).
  const pop = spring({ frame, fps, config: { damping: 14, mass: 0.6 }, durationInFrames: 16 });
  const popScale = interpolate(pop, [0, 1], [0.86, 1]);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.blue }}>
      <Audio src={staticFile(AUDIO)} />

      {/* --- simple sample quiz plate (inside the safe box) --- */}
      <Pill text="QUESTION 1 OF 15" fill={COLORS.mint} left={SAFE.x0} />
      <Pill text="PATTERNS" fill={COLORS.coral} right={1080 - SAFE.x1} />

      <div
        style={{
          position: "absolute",
          left: SAFE.x0,
          right: 1080 - SAFE.x1,
          top: SAFE.y0 + 170,
          background: COLORS.paper,
          border: "7px solid #000",
          borderRadius: 36,
          padding: "56px 48px",
          boxShadow: hardShadow(14),
          fontFamily: DM_SANS,
          color: COLORS.ink,
        }}
      >
        <div style={{ fontFamily: ANTON, fontSize: 74, lineHeight: 1.02, letterSpacing: 1 }}>
          WHICH SHAPE
          <br /> COMES NEXT?
        </div>
        <div style={{ display: "flex", gap: 22, marginTop: 44 }}>
          {SEQ.map((s, i) => (
            <div
              key={i}
              style={{
                width: 128,
                height: 128,
                background: s.fill,
                border: "6px solid #000",
                borderRadius: 22,
                boxShadow: hardShadow(8),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: ANTON,
                fontSize: 70,
                color: COLORS.ink,
              }}
            >
              {s.glyph}
            </div>
          ))}
        </div>
      </div>

      {/* --- the lip-synced narrator, lower-right, inside the safe box --- */}
      <div
        style={{
          position: "absolute",
          left: cardX,
          top: cardY,
          width: CARD.size,
          height: CARD.size,
          transform: `scale(${popScale})`,
          transformOrigin: "90% 90%",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: COLORS.paper,
            border: "7px solid #000",
            borderRadius: 40,
            boxShadow: hardShadow(12),
          }}
        />
        <div style={{ position: "absolute", inset: 20 }}>
          <BrainMascot mouth={mouth} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
