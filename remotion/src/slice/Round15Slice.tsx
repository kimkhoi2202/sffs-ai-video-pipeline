import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "../theme/brand";
import { Intro } from "../scenes/Intro";
import { QuestionPlate } from "../scenes/QuestionPlate";
import { QuestionReveal } from "../scenes/QuestionReveal";
import { QUESTIONS } from "../data/questions";
import {
  SEG,
  START,
  LEAD_FRAMES,
  Q3_COUNTDOWN,
  fanfareBed,
  frames,
  musicLevel,
  paradeBed,
} from "./timeline";

/**
 * PHASE-1 VERTICAL SLICE (kept for reference): intro -> Q3 (read + countdown) ->
 * Q3 reveal, now built from the same generic components as the full video.
 */
const Q3 = QUESTIONS[2];

const CountdownPlate: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <QuestionPlate q={Q3} elapsed={frame / fps} />;
};

export const Round15Slice: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
    <Sequence durationInFrames={SEG.intro} name="Intro">
      <Intro />
    </Sequence>
    <Sequence from={START.q3read} durationInFrames={SEG.q3read} name="Q3 · read">
      <QuestionPlate q={Q3} elapsed={0} />
    </Sequence>
    <Sequence from={START.countdown} durationInFrames={SEG.countdown} name="Q3 · countdown">
      <CountdownPlate />
    </Sequence>
    <Sequence from={START.reveal} durationInFrames={SEG.reveal} name="Q3 · reveal">
      <QuestionReveal q={Q3} />
    </Sequence>

    <Sequence from={START.intro + LEAD_FRAMES} name="VO · intro">
      <Audio src={staticFile("audio/narration/intro.mp3")} />
    </Sequence>
    <Sequence from={START.q3read + LEAD_FRAMES} name="VO · q3">
      <Audio src={staticFile("audio/narration/q3.mp3")} />
    </Sequence>
    <Sequence from={START.countdown + frames(Q3_COUNTDOWN)} name="VO · time's up">
      <Audio src={staticFile("audio/narration/timesup.mp3")} />
    </Sequence>
    <Sequence from={START.reveal + LEAD_FRAMES} name="VO · r3">
      <Audio src={staticFile("audio/narration/r3.mp3")} />
    </Sequence>

    <Sequence from={START.countdown} durationInFrames={frames(Q3_COUNTDOWN)} name="SFX · ticks">
      <Audio src={staticFile("audio/sfx/tick.wav")} />
    </Sequence>
    <Sequence from={START.reveal + frames(0.12)} name="SFX · ding">
      <Audio src={staticFile("audio/sfx/ding.wav")} />
    </Sequence>

    <Audio src={staticFile("audio/music/fanfare.mp3")} volume={(f) => musicLevel(f) * fanfareBed(f)} />
    <Audio src={staticFile("audio/music/parade.mp3")} volume={(f) => musicLevel(f) * paradeBed(f)} />
  </AbsoluteFill>
);
