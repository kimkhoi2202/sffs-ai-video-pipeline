import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { easeOutBack, easeOutCubic } from "../theme/easing";
import { HeroShapes } from "../components/HeroShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";
import { SafeArea } from "../components/SafeArea";

/**
 * Animated branded INTRO — matches the website hero + the approved Python intro:
 * "SMART FELLA" (blue) / OR pill / "FART SMELLA?" (coral) in Anton with a ~3px
 * black outline + tight hard black drop shadow, over the yellow field with the
 * synthwave grid + the six floating neo-brutalist HeroShapes. The brain logo
 * pops in over the "?" at a jaunty clockwise tilt. Snappy staggered entrance,
 * then the title HOLDS. Re-flows for the portrait frame (smaller caps, stacked
 * spacing, block biased up ~2:3).
 */
type Mode = "riseup" | "poprot" | "logopop";

const transform = (mode: Mode, u: number) => {
  const eo = easeOutCubic(u);
  const eb = easeOutBack(u);
  const alpha = easeOutCubic(Math.min(1, u / 0.5));
  let dy = 0;
  let scale = 1;
  let angle = 0;
  if (mode === "riseup") {
    dy = 155 * (1 - eo);
    scale = 0.9 + 0.1 * eb;
  } else if (mode === "poprot") {
    scale = eb;
    angle = -12 * (1 - eb);
  } else {
    scale = 0.1 + 0.9 * eb;
    angle = -12 + 24 * eb;
  }
  return { dy, scale, angle, alpha };
};

const titleWord = (cap: number, color: string): React.CSSProperties => ({
  fontFamily: ANTON,
  fontSize: cap,
  lineHeight: 1,
  color,
  WebkitTextStroke: `${cap * 0.022}px ${COLORS.ink}`,
  textShadow: `${cap * 0.04}px ${cap * 0.04}px 0 ${COLORS.ink}`,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
});

const TitleEl: React.FC<{
  cx: number;
  cy: number;
  mode: Mode;
  start: number;
  dur: number;
  t: number;
  children: React.ReactNode;
}> = ({ cx, cy, mode, start, dur, t, children }) => {
  const entered = t >= start;
  const u = entered ? (t - start) / dur : 0;
  const { dy, scale, angle, alpha } = entered ? transform(mode, u) : transform(mode, 0);
  return (
    <div style={{ position: "absolute", left: cx, top: cy + dy, transform: "translate(-50%, -50%)", opacity: alpha }}>
      <div style={{ transform: `scale(${scale}) rotate(${angle}deg)`, display: "flex" }}>{children}</div>
    </div>
  );
};

export const Intro: React.FC<{ mascot?: "standard" | "absent" | "prominent" }> = ({ mascot = "standard" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { w, portrait } = useFmt();
  const t = frame / fps;

  const cap = portrait ? 146 : 208;
  const cx = w / 2;
  const L = portrait
    ? { smart: 560, or: 760, fart: 984, orSize: 84, orPad: "15px 38px", orShadow: 9, brain: { cx: 936, cy: 918, wImg: 196, shadow: 11 } }
    : { smart: 274, or: 494, fart: 720, orSize: 102, orPad: "18px 45px", orShadow: 11, brain: { cx: 1530, cy: 597, wImg: 286, shadow: 13 } };
  // MASCOT A/B (loop `mascot` dimension): "standard" renders the brain exactly as
  // before; "absent" hides it; "prominent" enlarges it (a modest 1.3x that stays
  // inside the frame/safe box). Baseline is byte-for-byte unchanged.
  const brainW = Math.round(L.brain.wImg * (mascot === "prominent" ? 1.3 : 1));

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.yellow }}>
      <PerspectiveGrid base={COLORS.yellow} />
      <HeroShapes />

      {/* readable title inside the IG safe box (portrait); grid + shapes full-frame */}
      <SafeArea>
      {/* SMART FELLA (blue) */}
      <TitleEl cx={cx} cy={L.smart} mode="riseup" start={0.08} dur={0.58} t={t}>
        <div style={titleWord(cap, COLORS.blue)}>SMART FELLA</div>
      </TitleEl>

      {/* OR pill */}
      <TitleEl cx={cx} cy={L.or} mode="poprot" start={0.66} dur={0.46} t={t}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: COLORS.paper,
            color: COLORS.ink,
            border: `6px solid ${COLORS.ink}`,
            borderRadius: 9999,
            padding: L.orPad,
            boxShadow: hardShadow(L.orShadow),
            fontFamily: ANTON,
            fontSize: L.orSize,
            lineHeight: 1,
            textTransform: "uppercase",
          }}
        >
          OR
        </div>
      </TitleEl>

      {/* FART SMELLA? (coral) */}
      <TitleEl cx={portrait ? cx : 944} cy={L.fart} mode="riseup" start={1.05} dur={0.58} t={t}>
        <div style={titleWord(cap, COLORS.coral)}>FART SMELLA?</div>
      </TitleEl>

      {/* Brain mascot logo — pops in over the "?" (A/B: hidden when mascot="absent",
          enlarged when "prominent"; unchanged for "standard"). */}
      {mascot !== "absent" && (
        <TitleEl cx={L.brain.cx} cy={L.brain.cy} mode="logopop" start={1.6} dur={0.7} t={t}>
          <Img src={staticFile("images/sffs-logo.png")} style={{ width: brainW, height: "auto", display: "block", filter: hardDropShadow(L.brain.shadow) }} />
        </TitleEl>
      )}
      </SafeArea>
    </AbsoluteFill>
  );
};
