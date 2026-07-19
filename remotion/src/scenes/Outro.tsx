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
 * "FOLLOW FOR MORE"). SHORT/portrait outros also get a "SCROLL FOR MORE" hint
 * pinned near the bottom -- a white circle + ink down-chevron (hard shadow) that
 * loop-bobs downward as a swipe-to-next affordance; the 16:9 YouTube outro omits
 * it. Text renders ABOVE the floating shapes. Re-flows + enlarges for portrait.
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

/** Clean ink down-chevron for the scroll-for-more affordance. */
const ChevronDown: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size * 0.66} viewBox="0 0 40 26" style={{ display: "block" }} aria-hidden>
    <polyline points="4,5 20,21 36,5" fill="none" stroke={COLORS.ink} strokeWidth={7} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Outro: React.FC<{ platform?: Platform }> = ({ platform = "youtube" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { w, portrait } = useFmt();
  const cta = platform === "youtube" ? "SUBSCRIBE FOR MORE" : "FOLLOW FOR MORE";
  const cx = w / 2;

  // Eyebrow removed -> bigger headline + re-centered block using the freed space.
  // Portrait is enlarged noticeably to fill the tall frame (text sits above shapes).
  const head = portrait ? 170 : 150;
  // Portrait: the main block sits a touch higher to make room for the SCROLL FOR
  // MORE hint pinned near the bottom (with safe-area padding). Landscape unchanged.
  const L = portrait
    ? { l1: 636, l2: 824, comment: 998, cta: 1204, commentSize: 58, ctaSize: 74, ctaPad: "30px 62px", brain: { top: -56, right: -34, w: 140 }, scroll: 1688 }
    : { l1: 330, l2: 480, comment: 632, cta: 776, commentSize: 56, ctaSize: 66, ctaPad: "26px 60px", brain: { top: -52, right: -34, w: 132 }, scroll: 0 };
  // looping eased downward bob (~1.1s) for the scroll-for-more chevron
  const scrollDy = (1 - Math.cos(((frame % (1.1 * fps)) / (1.1 * fps)) * Math.PI * 2)) * 6;

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

      {/* SHORT/portrait only: "SCROLL FOR MORE" swipe-to-next affordance, bottom-pinned */}
      {portrait && (
        <Pop frame={frame} fps={fps} delay={30} cx={cx} cy={L.scroll}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            <div style={{ fontFamily: ANTON, fontSize: 42, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
              SCROLL FOR MORE
            </div>
            <div style={{ width: 92, height: 92, borderRadius: 9999, background: COLORS.paper, border: `6px solid ${COLORS.ink}`, boxShadow: hardShadow(8), display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ transform: `translateY(${scrollDy}px)`, display: "flex" }}>
                <ChevronDown size={44} />
              </div>
            </div>
          </div>
        </Pop>
      )}
      </div>
    </AbsoluteFill>
  );
};
