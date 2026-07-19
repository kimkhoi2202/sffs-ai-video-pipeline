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
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { QUESTIONS } from "../data/questions";
import type { NumSeriesQuestion as NumQ, TextQuestion as TextQ } from "../data/types";
import { TextQuestion } from "../scenes/questions/TextQuestion";
import { NumSeriesQuestion } from "../scenes/questions/NumSeriesQuestion";
import { Stage, titleStyle, BrandPill, PopIn } from "./bits";
import { SECTIONS, secFrames, LEAD, TOTAL } from "./timing";

/**
 * SELF-CONTAINED brand INTRO (pinned first post), 9:16 1080x1920, ~45s. Built
 * ONLY from READ-ONLY imports of the shared brand kit (theme, hero shapes, and
 * the REAL question plates) so it is pixel-consistent with the site + the other
 * videos, but it is registered by its OWN entry (introcut/entry.tsx) and never
 * touches Root.tsx or the running render.
 */

const LOGO = "images/sffs-logo.png";
const byIdx = (idx: number) => QUESTIONS.find((q) => q.idx === idx)!;

/** Delay a section's VO so the entrance animation lands first. */
const SectionVO: React.FC<{ id: string }> = ({ id }) => (
  <Sequence from={LEAD} name={`vo-${id}`}>
    <Audio src={staticFile(`sffs-intro/${id}.mp3`)} />
  </Sequence>
);

// ---- 1) HOOK -------------------------------------------------------------
const HookSection: React.FC = () => (
  <Stage bg={COLORS.yellow}>
    <SectionVO id="hook" />
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
  </Stage>
);

// ---- 2) WHAT IT IS -------------------------------------------------------
const WhatSection: React.FC = () => (
  <Stage bg={COLORS.blue}>
    <SectionVO id="what" />
    <PopIn delay={3} cx={540} cy={470} from={0.2}>
      <BrandPill fill={COLORS.paper} size={44} pad="14px 36px" shadow={8}>
        WHAT IS IT?
      </BrandPill>
    </PopIn>
    <PopIn delay={12} cx={540} cy={640} rise={34}>
      <div style={titleStyle(112, COLORS.yellow)}>A REAL IQ TEST</div>
    </PopIn>
    <PopIn delay={22} cx={540} cy={800} rise={30}>
      <div style={titleStyle(86, COLORS.paper)}>THAT'S ACTUALLY</div>
    </PopIn>
    <PopIn delay={30} cx={540} cy={980} from={0.3} rise={30}>
      <div style={titleStyle(180, COLORS.coral)}>FUN!</div>
    </PopIn>
    <PopIn delay={42} cx={540} cy={1230}>
      <BrandPill fill={COLORS.mint} size={48} pad="20px 44px" shadow={9} maxWidth={960}>
        FUN BRAIN CHALLENGES, K-12
      </BrandPill>
    </PopIn>
    <PopIn delay={50} cx={540} cy={1470} from={0.2}>
      <Img
        src={staticFile(LOGO)}
        style={{ width: 210, height: "auto", display: "block", transform: "rotate(-8deg)", filter: hardDropShadow(11) }}
      />
    </PopIn>
  </Stage>
);

// ---- 3) DEMO PLATES (REAL question components) ---------------------------
const DemoPlate: React.FC<{ q: TextQ | NumQ; pos: number }> = ({ q, pos }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame, fps, config: { damping: 15, stiffness: 170, mass: 0.7 } });
  const scale = interpolate(p, [0, 1], [0.93, 1]);
  const opacity = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
  const elapsed = Math.max(0, (frame - LEAD) / fps); // live countdown 5..1
  return (
    <AbsoluteFill style={{ backgroundColor: q.bg }}>
      <SectionVO id={`demo${pos}`} />
      <AbsoluteFill style={{ transform: `scale(${scale})`, opacity }}>
        {q.kind === "numseries" ? (
          <NumSeriesQuestion q={q} elapsed={elapsed} pos={pos} total={15} />
        ) : (
          <TextQuestion q={q as TextQ} elapsed={elapsed} pos={pos} total={15} />
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---- 4) MISSION ----------------------------------------------------------
const MissionSection: React.FC = () => (
  <Stage bg={COLORS.coral}>
    <SectionVO id="mission" />
    <PopIn delay={2} cx={540} cy={452} from={0.2}>
      <BrandPill fill={COLORS.paper} size={46} pad="14px 40px" shadow={8}>
        OUR MISSION
      </BrandPill>
    </PopIn>
    <PopIn delay={12} cx={540} cy={636} rise={30}>
      <div style={titleStyle(126, COLORS.yellow)}>TESTS SO FUN</div>
    </PopIn>
    <PopIn delay={24} cx={540} cy={812} rise={26}>
      <div style={titleStyle(76, COLORS.paper)}>AND AS ADDICTIVE AS</div>
    </PopIn>
    <PopIn delay={33} cx={540} cy={968} from={0.3} rise={26}>
      <div style={titleStyle(118, COLORS.blue)}>SOCIAL MEDIA</div>
    </PopIn>
    <PopIn delay={46} cx={540} cy={1210} rise={26}>
      <div style={titleStyle(82, COLORS.paper)}>KIDS CAN'T STOP</div>
    </PopIn>
    <PopIn delay={56} cx={540} cy={1380} from={0.3} rise={30}>
      <div style={titleStyle(158, COLORS.yellow)}>LEARNING</div>
    </PopIn>
  </Stage>
);

// ---- 5) CTA --------------------------------------------------------------
const ChevronDown: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size * 0.66} viewBox="0 0 40 26" style={{ display: "block" }} aria-hidden>
    <polyline points="4,5 20,21 36,5" fill="none" stroke={COLORS.ink} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CtaSection: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const bob = (1 - Math.cos(((frame % (1.1 * fps)) / (1.1 * fps)) * Math.PI * 2)) * 6;
  return (
    <Stage bg={COLORS.green}>
      <SectionVO id="cta" />
      <PopIn delay={4} cx={540} cy={694} rise={34}>
        <div style={titleStyle(116, COLORS.blue)}>NEW CHALLENGE</div>
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
          <div style={{ width: 96, height: 96, borderRadius: 9999, background: COLORS.paper, border: `6px solid ${COLORS.ink}`, boxShadow: hardShadow(8), display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ transform: `translateY(${bob}px)`, display: "flex" }}>
              <ChevronDown size={46} />
            </div>
          </div>
        </div>
      </PopIn>
    </Stage>
  );
};

// ---- Music bed -----------------------------------------------------------
const musicVolume = (f: number): number => {
  const fadeIn = interpolate(f, [0, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fadeOut = interpolate(f, [TOTAL - 26, TOTAL - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return 0.12 * fadeIn * fadeOut;
};

export const IntroBrand: React.FC = () => {
  const idx = (id: string) => SECTIONS.findIndex((s) => s.id === id);
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.yellow }}>
      <Audio loop src={staticFile("audio/music/gameshow-fanfare.mp3")} volume={musicVolume} />
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
