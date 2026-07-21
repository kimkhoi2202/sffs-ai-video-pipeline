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
import { Stage, titleStyle, BrandPill, PopIn } from "./bits";

/**
 * SELF-CONTAINED comment-reply short (IG/TikTok "reply to comment"), 9:16
 * 1080x1920, ~20s. Reuses the intro brand kit (Stage + HeroShapes, titleStyle,
 * BrandPill, PopIn) read-only, plus a rubber-stamp component. Its OWN composition
 * (entry.tsx); never touches the intro or the shared main-pipeline plate components.
 *
 * Opens straight on the celebration - TikTok's native "reply to comment" feature
 * already pins the original comment onto the video, so there is no on-screen
 * comment card. Beats: (1) YAYYY - our first comment! (confetti), (2) reward gag -
 * a CERTIFIED SMART FELLA rubber stamp THUNKS onto @mai_matz8, (3) tease "just the
 * start / new challenge every day", (4) Follow CTA. Locked IG safe area; no em dashes.
 */
const LOGO = "images/sffs-logo.png";
const FPS = 30;

// ---- Timing --------------------------------------------------------------
const LEAD = 4;
const BEATS = [
  { id: "reply-yay", vo: 3.44, tail: 8 },
  { id: "reply-stamp", vo: 5.93, tail: 12 },
  { id: "reply-tease", vo: 5.01, tail: 7 },
  { id: "reply-cta", vo: 3.01, tail: 24 },
] as const;
const beatFrames = (b: { vo: number; tail: number }) => LEAD + Math.ceil(b.vo * FPS) + b.tail;
export const REPLY_FPS = FPS;
export const REPLY_TOTAL = BEATS.reduce((sum, b) => sum + beatFrames(b), 0);
/** Stamp impact = frame the "thunk" lands (local to the stamp beat), timed to
 *  the VO hitting "SMART FELLA" (~1.4s before that 6.64s line ends). Its global
 *  frame is exported so the audio master can place the thunk SFX on it. */
const STAMP_IMPACT = 150;
export const STAMP_IMPACT_GLOBAL = beatFrames(BEATS[0]) + STAMP_IMPACT; // yay + stamp-local

// ---- LOCKED IG safe area (same as the intro) -----------------------------
const SAFE = { top: 220, bottom: 350 };
const SAFE_SCALE = (1920 - SAFE.top - SAFE.bottom) / 1920; // 0.703125
const SAFE_DY = (SAFE.top + (1920 - SAFE.bottom)) / 2 - 1920 / 2; // -65
const SafeArea: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ transform: `translateY(${SAFE_DY}px) scale(${SAFE_SCALE})`, transformOrigin: "540px 960px" }}>
    {children}
  </AbsoluteFill>
);

// ---- VO ------------------------------------------------------------------
const VO_GAIN = 0.78;
const BeatVO: React.FC<{ id: string }> = ({ id }) => (
  <Sequence from={LEAD} name={`vo-${id}`}>
    <Audio src={staticFile(`sffs-reply/${id}.mp3`)} volume={VO_GAIN} />
  </Sequence>
);

// ---- Confetti burst (YAY beat; decorative, roams full frame) --------------
const CONF_COLORS = [COLORS.coral, COLORS.blue, COLORS.yellow, COLORS.green, COLORS.mint, COLORS.paper];
const CONFETTI = Array.from({ length: 20 }, (_, i) => ({
  ang: (i / 20) * Math.PI * 2 + (i % 3) * 0.4,
  dist: 360 + (i % 5) * 80,
  size: 26 + (i % 4) * 12,
  color: CONF_COLORS[i % CONF_COLORS.length],
  round: i % 2 === 0 ? 6 : 9999,
  delay: 2 + (i % 6),
  spin: (i % 2 === 0 ? 1 : -1) * (120 + (i % 4) * 70),
  fall: 70 + (i % 5) * 46,
}));
const Confetti: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      {CONFETTI.map((c, i) => {
        const p = spring({ frame: frame - c.delay, fps, config: { damping: 13, stiffness: 90, mass: 0.7 } });
        const d = interpolate(p, [0, 1], [0, c.dist]);
        const x = 540 + Math.cos(c.ang) * d;
        const y = 820 + Math.sin(c.ang) * d + interpolate(p, [0, 1], [0, c.fall]);
        const rot = c.spin * p * 2;
        const op = interpolate(frame - c.delay, [0, 6, 66, 88], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return (
          <div key={i} style={{ position: "absolute", left: x, top: y, width: c.size, height: c.size, background: c.color, border: `3px solid ${COLORS.ink}`, borderRadius: c.round, transform: `translate(-50%, -50%) rotate(${rot}deg)`, opacity: op }} />
        );
      })}
    </AbsoluteFill>
  );
};

// ---- CERTIFIED SMART FELLA rubber stamp ----------------------------------
const StampBadge: React.FC = () => (
  <div
    style={{
      border: `10px solid ${COLORS.ink}`,
      borderRadius: 28,
      padding: "18px 56px 30px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 8,
      background: COLORS.green,
      boxShadow: hardShadow(14),
    }}
  >
    <div style={{ ...titleStyle(52, COLORS.paper), letterSpacing: "0.22em", paddingLeft: "0.22em" }}>CERTIFIED</div>
    <div style={titleStyle(120, COLORS.coral)}>SMART FELLA</div>
  </div>
);

// ---- 1) YAY - our first comment! (confetti; opens the short) -------------
const YayBeat: React.FC = () => (
  <Stage bg={COLORS.coral}>
    <BeatVO id="reply-yay" />
    <Confetti />
    <SafeArea>
      <PopIn delay={2} cx={540} cy={780} from={0.1} rise={34}>
        <div style={titleStyle(214, COLORS.yellow)}>YAYYY!</div>
      </PopIn>
      <PopIn delay={16} cx={540} cy={1080} from={0.4} rise={30}>
        <div style={titleStyle(96, COLORS.paper)}>OUR FIRST COMMENT!</div>
      </PopIn>
    </SafeArea>
  </Stage>
);

// ---- 2) CERTIFIED SMART FELLA stamp THUNK --------------------------------
const StampBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const clampBoth = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
  // Rubber-stamp thunk: big + transparent, SLAMS down (compress at impact),
  // small overshoot + a decaying jitter/wobble, then holds, rotated like a stamp.
  const scale = interpolate(frame, [STAMP_IMPACT - 6, STAMP_IMPACT - 1, STAMP_IMPACT, STAMP_IMPACT + 4, STAMP_IMPACT + 9], [1.7, 1.08, 0.9, 1.05, 1.0], clampBoth);
  const opacity = interpolate(frame, [STAMP_IMPACT - 6, STAMP_IMPACT - 3], [0, 1], clampBoth);
  const since = Math.max(0, frame - STAMP_IMPACT);
  const jAmp = interpolate(since, [0, 10], [16, 0], { extrapolateRight: "clamp" });
  const jx = Math.sin(since * 2.1) * jAmp;
  const jy = Math.cos(since * 2.7) * jAmp * 0.5;
  const tilt = -11 + Math.sin(since * 1.8) * interpolate(since, [0, 10], [4, 0], { extrapolateRight: "clamp" });
  return (
    <Stage bg={COLORS.blue}>
      <BeatVO id="reply-stamp" />
      <SafeArea>
        <PopIn delay={4} cx={540} cy={540} from={0.3}>
          <BrandPill fill={COLORS.paper} size={46} pad="14px 40px" shadow={9}>@MAI_MATZ8</BrandPill>
        </PopIn>
        <div
          style={{
            position: "absolute",
            left: 540,
            top: 1030,
            transform: `translate(-50%, -50%) translate(${jx}px, ${jy}px) rotate(${tilt}deg) scale(${scale})`,
            opacity,
          }}
        >
          <StampBadge />
        </div>
      </SafeArea>
    </Stage>
  );
};

// ---- 3) TEASE - just the start / new challenge every day -----------------
const TeaseBeat: React.FC = () => (
  <Stage bg={COLORS.yellow}>
    <BeatVO id="reply-tease" />
    <SafeArea>
      <PopIn delay={4} cx={540} cy={490} from={0.2}>
        <BrandPill fill={COLORS.paper} size={46} pad="14px 40px" shadow={9}>JUST THE START</BrandPill>
      </PopIn>
      <PopIn delay={22} cx={540} cy={840} rise={34}>
        <div style={titleStyle(136, COLORS.blue)}>NEW CHALLENGE</div>
      </PopIn>
      <PopIn delay={40} cx={540} cy={1030} from={0.3} rise={30}>
        <div style={titleStyle(172, COLORS.coral)}>EVERY DAY</div>
      </PopIn>
    </SafeArea>
  </Stage>
);

// ---- 4) CTA --------------------------------------------------------------
const CtaBeat: React.FC = () => (
  <Stage bg={COLORS.green}>
    <BeatVO id="reply-cta" />
    <SafeArea>
      <PopIn delay={4} cx={540} cy={730} rise={34}>
        <div style={titleStyle(128, COLORS.blue)}>DON'T MISS</div>
      </PopIn>
      <PopIn delay={12} cx={540} cy={920} rise={34}>
        <div style={titleStyle(150, COLORS.coral)}>TOMORROW'S!</div>
      </PopIn>
      <PopIn delay={22} cx={540} cy={1190} from={0.4}>
        <div style={{ position: "relative", display: "inline-flex" }}>
          <BrandPill fill={COLORS.yellow} size={78} pad="30px 64px" shadow={12}>
            FOLLOW FOR MORE
          </BrandPill>
          <Img
            src={staticFile(LOGO)}
            style={{ position: "absolute", top: -58, right: -34, width: 148, height: "auto", display: "block", transform: "rotate(12deg)", filter: hardDropShadow(10) }}
          />
        </div>
      </PopIn>
    </SafeArea>
  </Stage>
);

// ---- Music bed (ducked under VO, swells in gaps; SFX added in post) -------
const VO_SPANS: [number, number][] = (() => {
  const spans: [number, number][] = [];
  let acc = 0;
  BEATS.forEach((b) => {
    const start = acc + LEAD;
    spans.push([start, start + Math.ceil(b.vo * FPS)]);
    acc += beatFrames(b);
  });
  return spans;
})();
const MUSIC_DUCK = 0.36;
const MUSIC_FULL = 0.56;
const DUCK_RAMP = 6;
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
  const fadeOut = interpolate(f, [REPLY_TOTAL - 22, REPLY_TOTAL - 2], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return env * fadeIn * fadeOut;
};

export const ReplyBrand: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.yellow }}>
    <Audio src={staticFile("audio/music/bonus-round-bounce.mp3")} volume={musicVolume} />
    <Series>
      <Series.Sequence durationInFrames={beatFrames(BEATS[0])} name="yay">
        <YayBeat />
      </Series.Sequence>
      <Series.Sequence durationInFrames={beatFrames(BEATS[1])} name="stamp">
        <StampBeat />
      </Series.Sequence>
      <Series.Sequence durationInFrames={beatFrames(BEATS[2])} name="tease">
        <TeaseBeat />
      </Series.Sequence>
      <Series.Sequence durationInFrames={beatFrames(BEATS[3])} name="cta">
        <CtaBeat />
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);
