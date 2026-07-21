import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { HeroShapes } from "../components/HeroShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";
import { SafeArea } from "../components/SafeArea";
import type { Platform, EndCard } from "../full/timeline";

/**
 * Outro / end card — the closing hero moment matching the intro/website hero:
 * floating rotating HeroShapes over a vibrant green field, a two-line Anton
 * headline in brand color with a hard offset black shadow, the tilted brain-logo
 * accent on the CTA, and a springy staggered entrance. Hierarchy (eyebrow pill
 * removed for a cleaner, more minimal end card): "HOW DID / YOU DO?" -> "COMMENT
 * YOUR SCORE BELOW" -> platform CTA pill (YouTube "SUBSCRIBE FOR MORE", IG/TikTok
 * "FOLLOW FOR MORE"). SHORT/portrait outros also get a "SCROLL FOR MORE" hint
 * pinned near the bottom -- a white circle + ink stroke down-arrow (hard shadow) that
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

/** Clean ink STROKE arrow (lucide `ArrowDown`), pointing DOWN — the scroll-
 *  for-more affordance. A plain vertical shaft + arrowhead drawn as ink
 *  (#000) strokes with NO fill, round caps/joins, on a 24x24 viewBox. */
const ArrowDown: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={COLORS.ink} strokeWidth={2.75} strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </svg>
);

export const Outro: React.FC<{ platform?: Platform; variant?: EndCard }> = ({ platform = "youtube", variant = "default" }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { w, portrait } = useFmt();
  const followCta = platform === "youtube" ? "SUBSCRIBE FOR MORE" : "FOLLOW FOR MORE";
  const cx = w / 2;

  // The end card is prop-driven: the standard outro asks the score, the NO-ANSWER
  // test asks for the answer in the comments, and the ONE-QUESTION verdict delivers
  // the smart-fella/fart-smella payoff. All share the same on-brand green field,
  // floating shapes, two-color Anton headline, CTA pill, and scroll cue.
  const COPY =
    variant === "noanswer"
      ? { l1: "WHAT'S YOUR", l2: "ANSWER?", sub: "COMMENT YOUR ANSWER BELOW", cta: followCta, headScale: 0.94 }
      : variant === "verdict"
        ? { l1: "SMART FELLA", l2: "OR FART SMELLA?", sub: "COMMENT YOUR VERDICT", cta: followCta, headScale: 0.72 }
        : { l1: "HOW DID", l2: "YOU DO?", sub: "COMMENT YOUR SCORE BELOW", cta: followCta, headScale: 1 };
  const cta = COPY.cta;

  // Eyebrow removed -> bigger headline + re-centered block using the freed space.
  // Portrait is enlarged noticeably to fill the tall frame (text sits above shapes).
  const head = Math.round((portrait ? 170 : 150) * COPY.headScale);
  // Portrait: the main block sits a touch higher to make room for the SCROLL FOR
  // MORE hint pinned near the bottom (with safe-area padding). Landscape unchanged.
  const L = portrait
    ? { l1: 636, l2: 824, comment: 998, cta: 1204, commentSize: 58, ctaSize: 74, ctaPad: "30px 62px", brain: { top: -56, right: -34, w: 140 }, scroll: 1688 }
    : { l1: 330, l2: 480, comment: 632, cta: 776, commentSize: 56, ctaSize: 66, ctaPad: "26px 60px", brain: { top: -52, right: -34, w: 132 }, scroll: 0 };
  // Whole scroll-cue bob (the circle + its border + hard shadow + arrow move as
  // ONE unit), matching the website cue (gsap y:8 duration:0.7 yoyo sine.inOut =>
  // a 1.4s sine-eased 0->peak->0 cycle). Amplitude scaled up for the larger video
  // circle; transform-only, no layout shift.
  const cueBob = 8 * (1 - Math.cos(((frame % (1.4 * fps)) / (1.4 * fps)) * Math.PI * 2)); // 0..16px, ease-in-out

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.green }}>
      <PerspectiveGrid base={COLORS.green} />
      {/* same 6 hero shapes as the intro; hexagon recolored yellow so no shape blends into the green bg */}
      <HeroShapes overrides={{ hexagon: COLORS.yellow }} />

      {/* headline + CTA render ABOVE the floating shapes, inside the IG safe box
          in portrait; the grid + shapes stay full-frame (SafeArea no-ops in 16:9). */}
      <SafeArea>
      <div style={{ position: "absolute", inset: 0, zIndex: 1 }}>
      <Pop frame={frame} fps={fps} delay={4} cx={cx} cy={L.l1}>
        <div style={headWord(head, COLORS.blue)}>{COPY.l1}</div>
      </Pop>
      <Pop frame={frame} fps={fps} delay={12} cx={cx} cy={L.l2}>
        <div style={headWord(head, COLORS.coral)}>{COPY.l2}</div>
      </Pop>

      <Pop frame={frame} fps={fps} delay={18} cx={cx} cy={L.comment}>
        <div style={{ fontFamily: ANTON, fontSize: L.commentSize, lineHeight: 1, color: COLORS.ink, textTransform: "uppercase", letterSpacing: "0.01em", whiteSpace: "nowrap" }}>
          {COPY.sub}
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
            {/* whole cue bobs as one unit (circle + border + shadow + arrow) */}
            <div style={{ transform: `translateY(${cueBob}px)`, width: 92, height: 92, borderRadius: 9999, background: COLORS.paper, border: `6px solid ${COLORS.ink}`, boxShadow: hardShadow(8), display: "flex", alignItems: "center", justifyContent: "center" }}>
              <ArrowDown size={44} />
            </div>
          </div>
        </Pop>
      )}
      </div>
      </SafeArea>
    </AbsoluteFill>
  );
};
