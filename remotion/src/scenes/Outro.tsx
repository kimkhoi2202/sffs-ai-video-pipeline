import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { HeroShapes } from "../components/HeroShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";
import type { Platform } from "../full/timeline";

/**
 * Outro / end card — the closing hero moment matching the intro/website hero:
 * floating rotating HeroShapes over a vibrant green field, a two-line Anton
 * headline in brand color with a hard offset black shadow, the tilted brain-logo
 * accent on the CTA, and a springy staggered entrance. Hierarchy (eyebrow pill
 * removed for a cleaner, more minimal end card): "HOW DID / YOU DO?" -> "COMMENT
 * YOUR SCORE BELOW" -> platform CTA pill (YouTube "SUBSCRIBE FOR MORE", IG/TikTok
 * "FOLLOW FOR MORE"). Text renders ABOVE the floating shapes. Re-flows + enlarges
 * for the portrait frame. No dashes; no black-filled pills.
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

  // Eyebrow removed -> bigger headline + re-centered block using the freed space.
  // Portrait is enlarged noticeably to fill the tall frame (text sits above shapes).
  const head = portrait ? 170 : 150;
  const L = portrait
    ? { l1: 690, l2: 878, comment: 1052, cta: 1258, commentSize: 58, ctaSize: 74, ctaPad: "30px 62px", brain: { top: -56, right: -34, w: 140 } }
    : { l1: 330, l2: 480, comment: 632, cta: 776, commentSize: 56, ctaSize: 66, ctaPad: "26px 60px", brain: { top: -52, right: -34, w: 132 } };

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.green }}>
      <PerspectiveGrid base={COLORS.green} />
      {/* same 6 hero shapes as the intro; hexagon recolored yellow so no shape blends into the green bg */}
      <HeroShapes overrides={{ hexagon: COLORS.yellow }} />

      {/* headline + CTA render ABOVE the floating shapes (eyebrow pill removed) */}
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
      <Pop frame={frame} fps={fps} delay={4} cx={cx} cy={L.l1}>
        <div style={headWord(head, COLORS.blue)}>HOW DID</div>
      </Pop>
      <Pop frame={frame} fps={fps} delay={12} cx={cx} cy={L.l2}>
        <div style={headWord(head, COLORS.coral)}>YOU DO?</div>
      </Pop>

      <Pop frame={frame} fps={fps} delay={18} cx={cx} cy={L.comment}>
        <div style={{ fontFamily: ANTON, fontSize: L.commentSize, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
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
              whiteSpace: "nowrap",
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
      </div>
    </AbsoluteFill>
  );
};
