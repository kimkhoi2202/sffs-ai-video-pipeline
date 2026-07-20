import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  Series,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, hardDropShadow, hardShadow, slotColors } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { QUESTIONS } from "../data/questions";
import type { NumSeriesQuestion as NumQ, TextQuestion as TextQ } from "../data/types";
import { TextQuestion } from "../scenes/questions/TextQuestion";
import { NumSeriesQuestion } from "../scenes/questions/NumSeriesQuestion";
import { Stage, titleStyle, BrandPill, PopIn } from "./bits";
import { SECTIONS, secFrames, LEAD, TOTAL, FPS } from "./timing";

/**
 * SELF-CONTAINED brand INTRO (pinned first post), 9:16 1080x1920, ~45s. Built
 * ONLY from READ-ONLY imports of the shared brand kit (theme, hero shapes, and
 * the REAL question plates) so it is pixel-consistent with the site + the other
 * videos, but it is registered by its OWN entry (introcut/entry.tsx) and never
 * touches Root.tsx or the running render.
 */

const LOGO = "images/sffs-logo.png";
const byIdx = (idx: number) => QUESTIONS.find((q) => q.idx === idx)!;

/** Cloned VO played a touch under unity so the music bed + SFX have headroom;
 *  the whole mix is mastered back up to broadcast loudness after render. */
const VO_GAIN = 0.78;
/** Delay a section's VO so the entrance animation lands first. */
const SectionVO: React.FC<{ id: string }> = ({ id }) => (
  <Sequence from={LEAD} name={`vo-${id}`}>
    <Audio src={staticFile(`sffs-intro/${id}.mp3`)} volume={VO_GAIN} />
  </Sequence>
);

// ---- LOCKED IG safe area (@1080x1920) -----------------------------------
// Approved margins TOP 220 / BOTTOM 350 / LEFT 120 / RIGHT 120 -> safe box
// x120-960, y220-1570 (w840 x h1350). All readable content must stay inside it.
// Because the box is horizontally centred (its centre x = 540 = frame centre), a
// single UNIFORM scale about the frame centre + a small upward nudge maps the
// whole 1080x1920 canvas EXACTLY onto the box (no distortion; designs +
// animations preserved). Each scene's content lives inside <SafeArea>; the
// decorative HeroShapes render OUTSIDE it and may still roam the full frame.
const SAFE = { top: 220, bottom: 350, left: 120, right: 120 };
const SAFE_SCALE = (1920 - SAFE.top - SAFE.bottom) / 1920; // 1350/1920 = 0.703125
const SAFE_DY = (SAFE.top + (1920 - SAFE.bottom)) / 2 - 1920 / 2; // 895 - 960 = -65
const SafeArea: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ transform: `translateY(${SAFE_DY}px) scale(${SAFE_SCALE})`, transformOrigin: "540px 960px" }}>
    {children}
  </AbsoluteFill>
);

// ---- 1) HOOK -------------------------------------------------------------
const HookSection: React.FC = () => (
  <Stage bg={COLORS.yellow}>
    <SectionVO id="hook" />
    <SafeArea>
      <PopIn delay={2} cx={540} cy={648} rise={40}>
        <div style={titleStyle(132, COLORS.blue)}>SMART FELLA</div>
      </PopIn>
      <PopIn delay={11} cx={540} cy={858} from={0.2}>
        <BrandPill fill={COLORS.paper} size={78} pad="14px 46px" shadow={10}>
          OR
        </BrandPill>
      </PopIn>
      <PopIn delay={17} cx={540} cy={1074} rise={40}>
        <div style={titleStyle(132, COLORS.coral)}>FART SMELLA?</div>
      </PopIn>
      <PopIn delay={27} cx={812} cy={996} from={0.1}>
        <Img
          src={staticFile(LOGO)}
          style={{ width: 228, height: "auto", display: "block", transform: "rotate(10deg)", filter: hardDropShadow(12) }}
        />
      </PopIn>
    </SafeArea>
  </Stage>
);

// ---- 2) WHAT IT IS -------------------------------------------------------
const WhatSection: React.FC = () => (
  <Stage bg={COLORS.blue}>
    <SectionVO id="what" />
    <SafeArea>
      <PopIn delay={3} cx={540} cy={385} from={0.2}>
        <BrandPill fill={COLORS.paper} size={44} pad="14px 36px" shadow={8}>
          WHAT IS IT?
        </BrandPill>
      </PopIn>
      <PopIn delay={12} cx={540} cy={555} rise={34}>
        <div style={titleStyle(112, COLORS.yellow)}>A REAL IQ TEST</div>
      </PopIn>
      <PopIn delay={22} cx={540} cy={715} rise={30}>
        <div style={titleStyle(86, COLORS.paper)}>THAT'S ACTUALLY</div>
      </PopIn>
      <PopIn delay={30} cx={540} cy={895} from={0.3} rise={30}>
        <div style={titleStyle(180, COLORS.coral)}>FUN!</div>
      </PopIn>
      <PopIn delay={42} cx={540} cy={1145}>
        <BrandPill fill={COLORS.mint} size={48} pad="20px 44px" shadow={9} maxWidth={960}>
          FUN BRAIN CHALLENGES, K-12
        </BrandPill>
      </PopIn>
    </SafeArea>
  </Stage>
);

// ---- 3) DEMO PLATES (REAL question components) ---------------------------
const DemoPlate: React.FC<{ q: TextQ | NumQ; pos: number }> = ({ q, pos }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame, fps, config: { damping: 16, stiffness: 260, mass: 0.5 } });
  const scale = interpolate(p, [0, 1], [0.93, 1]);
  const opacity = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
  const elapsed = Math.max(0, (frame - LEAD) / fps); // brief live countdown (snappy plate)
  return (
    <AbsoluteFill style={{ backgroundColor: slotColors(q.idx).bg }}>
      <SectionVO id={`demo${pos}`} />
      <SafeArea>
        <AbsoluteFill style={{ transform: `scale(${scale})`, opacity }}>
          {q.kind === "numseries" ? (
            <NumSeriesQuestion q={q} elapsed={elapsed} pos={pos} total={15} />
          ) : (
            <TextQuestion q={q as TextQ} elapsed={elapsed} pos={pos} total={15} />
          )}
        </AbsoluteFill>
      </SafeArea>
    </AbsoluteFill>
  );
};

// ---- 4) MISSION ----------------------------------------------------------
const MissionSection: React.FC = () => (
  <Stage bg={COLORS.coral}>
    <SectionVO id="mission" />
    <SafeArea>
      <PopIn delay={8} cx={540} cy={680} rise={34}>
        <div style={titleStyle(138, COLORS.yellow)}>TESTS SO FUN</div>
      </PopIn>
      <PopIn delay={34} cx={540} cy={870} rise={26}>
        <div style={titleStyle(82, COLORS.paper)}>YOU CAN'T STOP</div>
      </PopIn>
      <PopIn delay={56} cx={540} cy={1050} from={0.3} rise={30}>
        <div style={titleStyle(162, COLORS.yellow)}>LEARNING</div>
      </PopIn>
    </SafeArea>
  </Stage>
);

// ---- 5) CTA --------------------------------------------------------------
/** Full down-arrow (shaft + head): replicates the website hero scroll cue
 *  (lucide ArrowDown, strokeWidth 2.5) so the intro's scroll affordance matches
 *  the site exactly instead of the old shaft-less chevron. */
const DownArrow: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={COLORS.ink} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

const CtaSection: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Scroll-cue bob matches the website (gsap y:8, dur 0.7s, sine.inOut, yoyo =
  // a raised cosine over a 1.4s period), amplitude scaled 96/36 to the intro's
  // larger circle so it reads identically. Transform-only; the WHOLE cue (circle
  // + ink border + hard shadow + arrow) translates as one unit, no layout shift.
  const BOB_AMP = 21; // px: site's 8px * (96/36 circle scale)
  const BOB_PERIOD = 1.4; // s: 0.7s each way, like the site
  const bob = ((1 - Math.cos((frame % (BOB_PERIOD * fps)) / (BOB_PERIOD * fps) * Math.PI * 2)) / 2) * BOB_AMP;
  return (
    <Stage bg={COLORS.green}>
      <SectionVO id="cta" />
      <SafeArea>
        <PopIn delay={4} cx={540} cy={694} rise={34}>
          <div style={titleStyle(116, COLORS.blue)}>NEW CHALLENGES</div>
        </PopIn>
        <PopIn delay={12} cx={540} cy={874} rise={34}>
          <div style={titleStyle(140, COLORS.coral)}>EVERY DAY</div>
        </PopIn>
        <PopIn delay={22} cx={540} cy={1130} from={0.4}>
          <div style={{ position: "relative", display: "inline-flex" }}>
            <BrandPill fill={COLORS.yellow} size={78} pad="30px 64px" shadow={12}>
              FOLLOW FOR MORE
            </BrandPill>
            <Img
              src={staticFile(LOGO)}
              style={{
                position: "absolute",
                top: -58,
                right: -34,
                width: 148,
                height: "auto",
                display: "block",
                transform: "rotate(12deg)",
                filter: hardDropShadow(10),
              }}
            />
          </div>
        </PopIn>
        <PopIn delay={34} cx={540} cy={1650} from={0.5}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div style={{ fontFamily: ANTON, fontSize: 44, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
              SCROLL FOR MORE
            </div>
            <div style={{ width: 96, height: 96, borderRadius: 9999, background: COLORS.paper, border: `6px solid ${COLORS.ink}`, boxShadow: hardShadow(8), display: "flex", alignItems: "center", justifyContent: "center", transform: `translateY(${bob}px)` }}>
              <DownArrow size={44} />
            </div>
          </div>
        </PopIn>
      </SafeArea>
    </Stage>
  );
};

// ---- Music bed -----------------------------------------------------------
// Upbeat brand bed (bonus-round-bounce; longer than the intro, so no loop seam).
// It DUCKS to MUSIC_DUCK under the VO (VO sits ~+9 dB over the bed) and SWELLS to
// MUSIC_FULL in the VO-silent gaps (opening, between the snappy plates, outro).
// Kept < 1.0 with the VO here; SFX + final loudness are added in a post master.
const VO_SPANS: [number, number][] = (() => {
  const spans: [number, number][] = [];
  let acc = 0;
  SECTIONS.forEach((s, i) => {
    const start = acc + LEAD;
    spans.push([start, start + Math.ceil(s.vo * FPS)]);
    acc += secFrames(i);
  });
  return spans;
})();

const MUSIC_DUCK = 0.36;
const MUSIC_FULL = 0.56;
const DUCK_RAMP = 6; // frames to glide between duck and full near a VO edge

/** 0 = fully ducked (inside a VO span), 1 = full (in a VO-silent gap). */
const gapAmount = (f: number): number => {
  let best = 1;
  for (const [a, b] of VO_SPANS) {
    if (f >= a && f <= b) return 0;
    const d = f < a ? a - f : f - b;
    best = Math.min(best, d / DUCK_RAMP);
  }
  return Math.max(0, Math.min(1, best));
};

const musicVolume = (f: number): number => {
  const env = MUSIC_DUCK + (MUSIC_FULL - MUSIC_DUCK) * gapAmount(f);
  const fadeIn = interpolate(f, [0, 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(f, [TOTAL - 22, TOTAL - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return env * fadeIn * fadeOut;
};

export const IntroBrand: React.FC = () => {
  const idx = (id: string) => SECTIONS.findIndex((s) => s.id === id);
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.yellow }}>
      <Audio src={staticFile("audio/music/bonus-round-bounce.mp3")} volume={musicVolume} />
      <Series>
        <Series.Sequence durationInFrames={secFrames(idx("hook"))} name="hook">
          <HookSection />
        </Series.Sequence>
        <Series.Sequence durationInFrames={secFrames(idx("what"))} name="what">
          <WhatSection />
        </Series.Sequence>
        <Series.Sequence durationInFrames={secFrames(idx("demo1"))} name="demo1">
          <DemoPlate q={byIdx(1) as TextQ} pos={1} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={secFrames(idx("demo2"))} name="demo2">
          <DemoPlate q={byIdx(2) as NumQ} pos={2} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={secFrames(idx("demo3"))} name="demo3">
          <DemoPlate q={byIdx(4) as TextQ} pos={3} />
        </Series.Sequence>
        <Series.Sequence durationInFrames={secFrames(idx("mission"))} name="mission">
          <MissionSection />
        </Series.Sequence>
        <Series.Sequence durationInFrames={secFrames(idx("cta"))} name="cta">
          <CtaSection />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
