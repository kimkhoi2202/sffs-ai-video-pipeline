import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { Pill } from "../components/Pill";
import { HeroShapes } from "../components/HeroShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";
import type { Platform } from "../full/timeline";

/**
 * Outro / end card — the closing hero moment matching the intro/website hero:
 * floating rotating HeroShapes over a vibrant green field, a two-line Anton
 * headline in brand color with a hard offset black shadow, the tilted brain-logo
 * accent on the CTA, and a springy staggered entrance. Hierarchy: "YOUR TURN"
 * eyebrow -> "HOW DID / YOU DO?" -> "COMMENT YOUR SCORE BELOW" -> platform CTA
 * pill (YouTube "SUBSCRIBE FOR MORE", IG/TikTok "FOLLOW FOR MORE"). Re-flows for
 * the portrait frame. No dashes; no black-filled pills.
 */
const headWord = (head: number, color: string): React.CSSProperties => ({
  fontFamily: ANTON,
  fontSize: head,
  lineHeight: 1,
  color,
  WebkitTextStroke: `${head * 0.022}px ${COLORS.ink}`,
  textShadow: `${head * 0.05}px ${head * 0.05}px 0 ${COLORS.ink}`,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
});

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
  const { w, portrait } = useFmt();
  const cta = platform === "youtube" ? "SUBSCRIBE FOR MORE" : "FOLLOW FOR MORE";
  const cx = w / 2;

  const head = portrait ? 128 : 150;
  const L = portrait
    ? { eyebrow: 380, l1: 566, l2: 726, comment: 916, cta: 1096, commentSize: 44, ctaSize: 58, ctaPad: "24px 52px", brain: { top: -46, right: -30, w: 112 } }
    : { eyebrow: 181, l1: 357, l2: 507, comment: 659, cta: 803, commentSize: 56, ctaSize: 66, ctaPad: "26px 60px", brain: { top: -52, right: -34, w: 132 } };

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.green }}>
      <PerspectiveGrid base={COLORS.green} />
      {/* same 6 hero shapes as the intro; hexagon recolored yellow so no shape blends into the green bg */}
      <HeroShapes overrides={{ hexagon: COLORS.yellow }} />

      <Pop frame={frame} fps={fps} delay={2} cx={cx} cy={L.eyebrow}>
        <Pill text="YOUR TURN" fill={COLORS.coral} textColor={COLORS.ink} fontSize={38} tracking={4} padX={36} padY={18} />
      </Pop>

      <Pop frame={frame} fps={fps} delay={8} cx={cx} cy={L.l1}>
        <div style={headWord(head, COLORS.blue)}>HOW DID</div>
      </Pop>
      <Pop frame={frame} fps={fps} delay={12} cx={cx} cy={L.l2}>
        <div style={headWord(head, COLORS.coral)}>YOU DO?</div>
      </Pop>

      <Pop frame={frame} fps={fps} delay={18} cx={cx} cy={L.comment}>
        <div style={{ fontFamily: ANTON, fontSize: L.commentSize, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.01em" }}>
          COMMENT YOUR SCORE BELOW
        </div>
      </Pop>

      {/* platform CTA pill (auto-sizes) with the tilted brain sticker on its top-right corner */}
      <Pop frame={frame} fps={fps} delay={24} cx={cx} cy={L.cta}>
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
              padding: L.ctaPad,
              boxShadow: hardShadow(12),
              fontFamily: ANTON,
              fontSize: L.ctaSize,
              lineHeight: 1,
              textTransform: "uppercase",
              letterSpacing: "0.01em",
            }}
          >
            {cta}
          </div>
          <Img
            src={staticFile("images/sffs-logo.png")}
            style={{ position: "absolute", top: L.brain.top, right: L.brain.right, width: L.brain.w, height: "auto", display: "block", transform: "rotate(12deg)", filter: hardDropShadow(10), zIndex: 2 }}
          />
        </div>
      </Pop>
    </AbsoluteFill>
  );
};
