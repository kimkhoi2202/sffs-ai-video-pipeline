import { useMemo } from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, slotColors } from "../theme/brand";
import { PlatformProvider, HeaderConfigProvider, type ProgressStyle } from "../theme/layout";
import { DebugSafeZones } from "../components/DebugSafeZones";
import { Intro } from "../scenes/Intro";
import { Hook } from "../scenes/Hook";
import { QuestionPlate } from "../scenes/QuestionPlate";
import { QuestionReveal } from "../scenes/QuestionReveal";
import { Score } from "../scenes/Score";
import { Outro } from "../scenes/Outro";
import type { Question } from "../data/types";
import {
  getTimeline,
  type Platform,
  type Segment,
  type SfxSet,
  type TimelineData,
  type Variant,
  type ReadVO,
  type EndCard,
  type DropReveal,
  type Opening,
  fanfareBed,
  paradeBed,
  musicLevel,
  winnerVolume,
  winStartFrame,
  shortMusicVolume,
  GAIN,
} from "./timeline";
import { bySlug } from "../data/cuts";

/** Brand-mascot A/B visibility (the loop's `mascot` dimension). "standard" keeps
 *  the intro-cover + outro brain exactly as today; "absent" hides it; "prominent"
 *  enlarges it. Omitted => "standard" (every non-mascot arm renders unchanged). */
export type MascotVis = "standard" | "absent" | "prominent";

/** Countdown-active plate: drives `elapsed` from the sequence-local frame. */
const CountdownPlate: React.FC<{ q: Question; pos: number; total: number }> = ({ q, pos, total }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return <QuestionPlate q={q} elapsed={frame / fps} pos={pos} total={total} />;
};

const renderSegment = (
  seg: Segment,
  platform: Platform,
  total: number,
  endCard: EndCard,
  mascot: MascotVis,
  hookBg: string,
): React.ReactNode => {
  switch (seg.type) {
    case "intro":
      return <Intro mascot={mascot} />;
    case "hook":
      return <Hook bg={hookBg} />;
    case "read":
      return <QuestionPlate q={seg.q} elapsed={0} pos={seg.pos} total={total} />;
    case "countdown":
      return <CountdownPlate q={seg.q} pos={seg.pos} total={total} />;
    case "reveal":
      return <QuestionReveal q={seg.q} />;
    case "score":
      return <Score total={total} />;
    case "outro":
      return <Outro platform={platform} variant={endCard} mascot={mascot} />;
  }
};

const segName = (seg: Segment): string => {
  if (seg.type === "intro" || seg.type === "hook" || seg.type === "score" || seg.type === "outro") return seg.type;
  return `Q${seg.q.idx} ${seg.type}`;
};

/**
 * The complete ~11-minute video: every scene sequenced on the shared timeline,
 * with the full existing narration, tick beds, reveal dings, the dynamic
 * fanfare -> parade (looped) -> winner music arc, and burned-in word-by-word
 * captions. `platform` (youtube | instagram | tiktok) selects the outro CTA +
 * outro VO/captions; the whole timeline (and total length) is computed per
 * platform, so an IG/TikTok "follow for more" render is a one-flag switch.
 */
/**
 * Renders a named cut. Pass `slug` (resolved from src/data/cuts.ts) to select
 * the question subset, platform, and per-cut music + SFX; explicit props are a
 * fallback (the default is the full 15-Q YouTube master). Shorts get a single
 * distinct looped music bed (shortMusicVolume); the YouTube cuts keep the
 * fanfare -> parade -> winner arc. Both share the two-level VO-keyed duck/swell.
 */
export const FullVideo: React.FC<{
  slug?: string;
  platform?: Platform;
  questionIds?: number[];
  music?: string;
  sfx?: SfxSet;
  /** Per-round overrides (batch pipeline). When omitted, the committed master
   *  data (data/questions.ts + durations.json + shared audio/narration/) is used. */
  questions?: Question[];
  durs?: Record<string, number>;
  qrBase?: string;
  /** A/B-test variant toggles (prop-driven; omitted = the standard cut). See
   *  Variant in timeline.ts. Shorts are always cold-open (no intro option). */
  readVO?: ReadVO;
  dropReveal?: DropReveal;
  dropScore?: boolean;
  endCard?: EndCard;
  metaBase?: string;
  /** Progress-counter A/B controls (the loop's progress-counter dimension). When
   *  omitted the count pill shows in full "QUESTION X OF N" form (unchanged for
   *  the committed masters / render-ab). `showProgress=false` hides it; "short"
   *  renders the compact "Q1". */
  showProgress?: boolean;
  progressStyle?: ProgressStyle;
  /** Composition length is set by Root's calculateMetadata from this (when the
   *  A/B render script supplies it); FullVideo itself ignores it. */
  totalFrames?: number;
  /** DEV preview only: overlay TikTok's UI danger zones (top/right/bottom) so a
   *  still can confirm the plate clears them. Off in every real render. */
  debugSafeZones?: boolean;
  /** Brand-mascot A/B visibility (loop `mascot` dimension). Omitted => "standard"
   *  (unchanged render). "absent" hides the intro/outro brain; "prominent" enlarges it. */
  mascot?: MascotVis;
  /** Opening arm for the 3-second skip-rate experiment (shorts only). "cold-plate"
   *  is today's behaviour; "motion-hook" prepends the wordless Hook scene. */
  opening?: Opening;
}> = ({ slug, platform: platformProp, questionIds, music: musicProp, sfx: sfxProp, questions, durs, qrBase, readVO, dropReveal, dropScore, endCard, metaBase, showProgress, progressStyle, debugSafeZones, mascot, opening }) => {
  const cut = slug ? bySlug(slug) : undefined;
  const platform: Platform = cut?.platform ?? platformProp ?? "youtube";
  const ids = cut?.ids ?? questionIds;
  const music = cut?.music ?? musicProp;
  const sfx = cut?.sfx ?? sfxProp;
  // A SHORT is decided by the composition's shape, not by which network it is going to.
  // The Short composition is 1080x1920 and the 16:9 master is 1920x1080, so the aspect
  // is the one signal that is always right — including for a YouTube Short, where the
  // platform name alone would have selected the master's pacing and its branded intro.
  const { width: compW, height: compH } = useVideoConfig();
  const isShort = compH > compW;
  const variant: Variant = useMemo(
    () => ({ readVO, dropReveal, dropScore, endCard, metaBase, opening, isShort }),
    [readVO, dropReveal, dropScore, endCard, metaBase, opening, isShort],
  );
  const T: TimelineData = useMemo(
    () => getTimeline(platform, ids, sfx, questions, durs, qrBase, variant),
    [platform, ids, sfx, questions, durs, qrBase, variant],
  );
  const total = T.questions.length;
  const winStart = winStartFrame(T);
  // The hook ends by flooding the frame with the FIRST plate's own background colour,
  // so the cut into the question reads as one continuous move instead of a jump.
  const hookBg = slotColors(T.questions[0]?.idx ?? 1).bg;
  const headerConfig = useMemo(
    () => ({ showProgress: showProgress ?? true, progressStyle: progressStyle ?? "full" }),
    [showProgress, progressStyle],
  );
  return (
    <PlatformProvider platform={platform}>
    <HeaderConfigProvider config={headerConfig}>
    <AbsoluteFill style={{ backgroundColor: COLORS.ink }}>
      {T.segments.map((seg, i) => (
        <Sequence key={i} from={seg.start} durationInFrames={seg.dur} name={segName(seg)}>
          {renderSegment(seg, platform, total, endCard ?? "default", mascot ?? "standard", hookBg)}
        </Sequence>
      ))}

      {/* narration */}
      {T.narration.map((a, i) => (
        <Sequence key={`n${i}`} from={a.from} name="VO">
          <Audio src={staticFile(a.src)} />
        </Sequence>
      ))}

      {/* tick beds under each countdown (trimmed to the countdown length) */}
      {T.ticks.map((a, i) => (
        <Sequence key={`t${i}`} from={a.from} durationInFrames={a.durationInFrames} name="ticks">
          <Audio src={staticFile(a.src)} />
        </Sequence>
      ))}

      {/* SFX: per-transition-type whooshes/stings + correct-answer ding at each reveal */}
      {T.sfx.map((a, i) => (
        <Sequence key={`s${i}`} from={a.from} name="sfx">
          <Audio src={staticFile(a.src)} volume={a.vol} />
        </Sequence>
      ))}

      {/* music bed — two-level VO-keyed duck/swell (full swell in every VO-gap,
          ducked under narration). Shorts use one distinct looped track; the
          YouTube cuts use the fanfare -> parade -> winner arc. */}
      {music ? (
        <Audio loop src={staticFile(`audio/music/${music}`)} volume={(f) => shortMusicVolume(f, T)} />
      ) : (
        <>
          <Audio src={staticFile("audio/music/fanfare.mp3")} volume={(f) => musicLevel(f, T) * fanfareBed(f) * GAIN.fanfare} />
          <Audio loop src={staticFile("audio/music/parade.mp3")} volume={(f) => musicLevel(f, T) * paradeBed(f, T) * GAIN.parade} />
          <Sequence from={winStart} name="music · winner">
            <Audio src={staticFile("audio/music/winner.mp3")} volume={(local) => winnerVolume(local, T)} />
          </Sequence>
        </>
      )}

      {/* No burned-in captions. Subtitles ship only as the .srt/.vtt sidecar
          (full transcript) generated by scripts/gen-subs.ts. The Captions
          component + captions.json remain in the repo, just not rendered. */}

      {/* DEV preview overlay (off in every real render): TikTok UI danger zones. */}
      {debugSafeZones ? <DebugSafeZones /> : null}
    </AbsoluteFill>
    </HeaderConfigProvider>
    </PlatformProvider>
  );
};
