import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { easeOutBack, easeOutCubic } from "../theme/easing";
import { FloatingShapes } from "../components/FloatingShapes";

/**
 * Animated branded INTRO — matches the website hero
 * (components/quiz/smart-fart-hero.tsx) and the approved Python intro
 * (render_cogat_round_15.py): "SMART FELLA" (blue) / OR pill / "FART SMELLA?"
 * (coral) in Anton with a ~3px black outline + a tight hard black drop shadow,
 * over the flat yellow field with five floating neo-brutalist shapes. The brain
 * logo pops in over the "?" at a jaunty clockwise tilt. Snappy staggered
 * entrance (easeOutCubic / easeOutBack), then the title HOLDS under the VO.
 */

const CAP = 208;
const OUTLINE = CAP * 0.022; // ~3px black outline, proportional (site: text-stroke 3px)
const SHADOW_OFF = CAP * 0.04; // 0.04em hard extruded shadow, down-right (site text-shadow)

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
    angle = -12 * (1 - eb); // CSS CW; -12deg -> 0 (site OR: rotate -12 -> 0)
  } else {
    scale = 0.1 + 0.9 * eb;
    angle = -12 + 24 * eb; // spin in, settling at +12deg CW (LOGO_TILT)
  }
  return { dy, scale, angle, alpha };
};

const titleWord = (text: string, color: string): React.CSSProperties => ({
  fontFamily: ANTON,
  fontSize: CAP,
  lineHeight: 1,
  color,
  WebkitTextStroke: `${OUTLINE}px ${COLORS.ink}`,
  textShadow: `${SHADOW_OFF}px ${SHADOW_OFF}px 0 ${COLORS.ink}`,
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
    <div
      style={{
        position: "absolute",
        left: cx,
        top: cy + dy,
        transform: "translate(-50%, -50%)",
        opacity: alpha,
      }}
    >
      <div style={{ transform: `scale(${scale}) rotate(${angle}deg)`, display: "flex" }}>{children}</div>
    </div>
  );
};

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.yellow }}>
      <FloatingShapes t={t} />

      {/* SMART FELLA (blue) */}
      <TitleEl cx={918} cy={322} mode="riseup" start={0.08} dur={0.58} t={t}>
        <div style={titleWord("SMART FELLA", COLORS.blue)}>SMART FELLA</div>
      </TitleEl>

      {/* OR pill (white capsule) */}
      <TitleEl cx={918} cy={548} mode="poprot" start={0.66} dur={0.46} t={t}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: COLORS.paper,
            color: COLORS.ink,
            border: `6px solid ${COLORS.ink}`,
            borderRadius: 9999,
            padding: "18px 45px",
            boxShadow: hardShadow(11),
            fontFamily: ANTON,
            fontSize: 102,
            lineHeight: 1,
            textTransform: "uppercase",
          }}
        >
          OR
        </div>
      </TitleEl>

      {/* FART SMELLA? (coral) */}
      <TitleEl cx={944} cy={768} mode="riseup" start={1.05} dur={0.58} t={t}>
        <div style={titleWord("FART SMELLA?", COLORS.coral)}>FART SMELLA?</div>
      </TitleEl>

      {/* Brain mascot logo — pops in over the "?" (painted last => on top) */}
      <TitleEl cx={1530} cy={645} mode="logopop" start={1.6} dur={0.7} t={t}>
        <Img
          src={staticFile("images/sffs-logo.png")}
          style={{ width: 286, height: "auto", display: "block", filter: hardDropShadow(13) }}
        />
      </TitleEl>
    </AbsoluteFill>
  );
};
