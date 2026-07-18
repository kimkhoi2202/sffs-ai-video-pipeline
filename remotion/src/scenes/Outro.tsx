import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { Pill } from "../components/Pill";
import { FloatingShapes } from "../components/FloatingShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";
import type { Platform } from "../full/timeline";

/**
 * Outro / end card — the closing hero moment, matching the intro/website-hero
 * energy: floating rotating neo-brutalist shapes over a vibrant green field, a
 * big two-line Anton headline in brand color with a hard offset black shadow,
 * the brain-logo accent, and a springy staggered entrance. Hierarchy: "YOUR
 * TURN" coral eyebrow -> "HOW DID / YOU DO?" hero headline -> "COMMENT YOUR
 * SCORE BELOW" -> platform CTA pill (YouTube "SUBSCRIBE FOR MORE", IG/TikTok
 * "FOLLOW FOR MORE"). No em/en dashes; no black-filled pills.
 */
const HEAD = 150;
const OUTLINE = HEAD * 0.022; // ~3px black outline (matches intro title)
const SHADOW_OFF = HEAD * 0.05; // hard extruded shadow, down-right

const headWord = (color: string): React.CSSProperties => ({
  fontFamily: ANTON,
  fontSize: HEAD,
  lineHeight: 1,
  color,
  WebkitTextStroke: `${OUTLINE}px ${COLORS.ink}`,
  textShadow: `${SHADOW_OFF}px ${SHADOW_OFF}px 0 ${COLORS.ink}`,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
});

/** Springy pop-in (scale + rise + fade), positioned centered at (cx, cy). */
const Pop: React.FC<{ frame: number; fps: number; delay: number; cx: number; cy: number; children: React.ReactNode }> = ({
  frame,
  fps,
  delay,
  cx,
  cy,
  children,
}) => {
  const p = spring({ frame: frame - delay, fps, config: { damping: 13, stiffness: 180, mass: 0.6 } });
  const scale = interpolate(p, [0, 1], [0.6, 1]);
  const opacity = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
  const dy = interpolate(p, [0, 1], [26, 0]);
  return (
    <div style={{ position: "absolute", left: cx, top: cy + dy, transform: "translate(-50%, -50%)", opacity }}>
      <div style={{ transform: `scale(${scale})`, display: "flex", alignItems: "center", justifyContent: "center" }}>{children}</div>
    </div>
  );
};

export const Outro: React.FC<{ platform?: Platform }> = ({ platform = "youtube" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const cta = platform === "youtube" ? "SUBSCRIBE FOR MORE" : "FOLLOW FOR MORE";

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.green }}>
      <PerspectiveGrid base={COLORS.green} />
      <FloatingShapes t={t} />

      {/* content block biased UP (~2:3 top:bottom whitespace) */}
      {/* YOUR TURN eyebrow */}
      <Pop frame={frame} fps={fps} delay={2} cx={960} cy={181}>
        <Pill text="YOUR TURN" fill={COLORS.coral} textColor={COLORS.ink} fontSize={38} tracking={4} padX={36} padY={18} />
      </Pop>

      {/* HOW DID / YOU DO? hero headline (blue + coral, hard shadow) */}
      <Pop frame={frame} fps={fps} delay={8} cx={960} cy={357}>
        <div style={headWord(COLORS.blue)}>HOW DID</div>
      </Pop>
      <Pop frame={frame} fps={fps} delay={12} cx={960} cy={507}>
        <div style={headWord(COLORS.coral)}>YOU DO?</div>
      </Pop>

      {/* COMMENT YOUR SCORE BELOW */}
      <Pop frame={frame} fps={fps} delay={18} cx={960} cy={659}>
        <div style={{ fontFamily: ANTON, fontSize: 56, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.01em" }}>
          COMMENT YOUR SCORE BELOW
        </div>
      </Pop>

      {/* platform CTA pill (auto-sizes to its text) with the tilted brain-logo
          sticker overlapping its TOP-RIGHT corner — anchored to the pill so it
          lands correctly on both the wider "SUBSCRIBE" and narrower "FOLLOW" */}
      <Pop frame={frame} fps={fps} delay={24} cx={960} cy={803}>
        <div style={{ position: "relative", display: "inline-flex" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              background: COLORS.yellow,
              color: COLORS.ink,
              border: `8px solid ${COLORS.ink}`,
              borderRadius: 9999,
              padding: "26px 60px",
              boxShadow: hardShadow(12),
              fontFamily: ANTON,
              fontSize: 66,
              lineHeight: 1,
              textTransform: "uppercase",
              letterSpacing: "0.01em",
            }}
          >
            {cta}
          </div>
          <Img
            src={staticFile("images/sffs-logo.png")}
            style={{
              position: "absolute",
              top: -52,
              right: -34,
              width: 132,
              height: "auto",
              display: "block",
              transform: "rotate(12deg)",
              filter: hardDropShadow(10),
              zIndex: 2,
            }}
          />
        </div>
      </Pop>
    </AbsoluteFill>
  );
};
