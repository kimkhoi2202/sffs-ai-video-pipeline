import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { COLORS, slotColors } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { HeaderPills } from "./HeaderPills";
import { Countdown } from "./Countdown";
import { SafeArea, TT_BAND_TOP, TT_BAND_BOTTOM, TT_DENSE_TOP, TT_DENSE_BOTTOM, usesChromeSafeBox } from "./SafeArea";
import type { Question } from "../data/types";

/**
 * Shared question-plate layout. Header row (pills + countdown chip) is pinned at
 * the top and the green progress bar is pinned at the bottom (both drawn as
 * chrome). The question+content+options block sits at its natural height and is
 * VERTICALLY CENTERED (slightly biased up, ~1:2 G1:G2) in the region between the
 * header and the bar via flex-grow spacers. Re-flows for portrait: narrower
 * margins, a taller header zone (the two header pills stack), and the options
 * stack into a single column.
 *
 * TikTok (portrait) TRUE-CENTERS the block instead: the flex band is set to the
 * design-space safe band (TT_BAND_TOP..TT_BAND_BOTTOM, which the SafeArea TikTok
 * transform maps onto the on-screen safe band 200..1440) and the spacers are 1:1,
 * so the block's midpoint lands on the safe band's centre. Centring is shadow-
 * aware: a marginBottom equal to the last option's hard-shadow offset is reserved
 * so the block's OPTICAL box (shadow included) is what gets centred. IG/YT keep
 * the 2:3 up-bias exactly.
 */
export const HEADER_ZONE = 168; // landscape reserved top region (header + countdown + shadow)
export const BAR_ZONE = 124; // landscape reserved bottom region (progress bar)
export const CONTENT_GAP = 44; // prompt/title -> content (tiles/shapes)
export const OPTIONS_GAP = 40; // prompt/content -> options (G1, small; block biased up)
const SPACER_TOP = 2;
const SPACER_BOTTOM = 3;
const OPT_SHADOW = 12; // option/prompt hard-shadow offset (OptionCards/Card hardShadow(12))
const PORTRAIT_BLOCK_W = 1080 - 2 * 64; // portrait content width (frame - 2*M)

/**
 * Conservative estimate of a PromptTitle's rendered height (design px) for the
 * TikTok fit calc. Anton is condensed; ~0.55*fontSize/char OVER-estimates width
 * so a long prompt yields more lines -> a taller natural height -> a SAFE fit
 * (we would rather shrink a hair too much than let a tall block overlap chrome).
 * padding 26*2 + border 8*2 = 68 (matches PromptTitle portrait); lineHeight 1.08.
 */
export const estPromptHeight = (text: string, fontSize: number): number => {
  const inner = PORTRAIT_BLOCK_W - 2 * 34; // PromptTitle horizontal padding (portrait)
  const cpl = Math.max(6, Math.floor(inner / (fontSize * 0.55)));
  const lines = Math.max(1, Math.ceil((text?.length ?? 0) / cpl));
  return lines * fontSize * 1.08 + 68;
};

/** The parts a TALL question type reports so QuestionFrame can size + scale it to
 *  the TikTok chrome-safe band. contentH/optionsH are portrait design px; the
 *  promptText lets the estimator count wrapped lines without the union `prompt`. */
export type TtFit = { promptText: string; contentH: number; optionsH: number; promptFontSize: number };

/** The flat white prompt/question box. Natural height — grows with its text. */
export const PromptTitle: React.FC<{ fontSize: number; radius?: number; children: ReactNode }> = ({
  fontSize,
  radius = 40,
  children,
}) => {
  const { portrait } = useFmt();
  return (
    <div
      style={{
        boxSizing: "border-box",
        width: "100%",
        background: COLORS.paper,
        border: `${portrait ? 8 : 9}px solid ${COLORS.ink}`,
        borderRadius: radius,
        padding: portrait ? "26px 34px" : "30px 48px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontFamily: ANTON,
        fontSize,
        lineHeight: 1.08,
        color: COLORS.ink,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
};

export const QuestionFrame: React.FC<{
  q: Question;
  elapsed: number;
  prompt: ReactNode;
  content?: ReactNode;
  options: ReactNode;
  /** Display position within the cut (1-based) + the cut's question count. */
  pos?: number;
  total?: number;
  /** TikTok-only: a TALL type (e.g. FIGURE MATRIX) reports its block parts so the
   *  block is uniformly scaled to fit the chrome-safe band (never overlapping the
   *  header pills or the progress bar). Omitted => the block is unchanged. */
  ttFit?: TtFit;
}> = ({ q, elapsed, prompt, content, options, pos, total, ttFit }) => {
  const { portrait, M, platform } = useFmt();
  const c = slotColors(q.idx);
  // Same predicate as the SafeArea transform: the band this centres content in
  // MUST match the box the content is then transformed into.
  const tiktok = portrait && usesChromeSafeBox(platform);
  // Chrome-safe platforms (TikTok, YouTube Shorts): flex band == the design-space safe
  // band + 1:1 spacers -> the block is TRUE-centred in the on-screen safe band.
  // Instagram keeps the 250/150 zones + 2:3 bias.
  const headerZone = tiktok ? TT_BAND_TOP : portrait ? 250 : HEADER_ZONE;
  const barZone = tiktok ? 1920 - TT_BAND_BOTTOM : portrait ? 150 : BAR_ZONE;
  const spacerTop = tiktok ? 1 : SPACER_TOP;
  const spacerBottom = tiktok ? 1 : SPACER_BOTTOM;
  // Shadow-aware centring: reserve the last option's hard-shadow so the block's
  // OPTICAL box (shadow included) is what's centred, not just its border box.
  const blockShadowReserve = tiktok ? OPT_SHADOW : 0;
  const contentGap = portrait ? 40 : CONTENT_GAP;
  const optionsGap = portrait ? 40 : OPTIONS_GAP;
  // TikTok scale-to-fit: only a block whose NATURAL height exceeds the chrome-safe
  // band [TT_DENSE_TOP..TT_DENSE_BOTTOM] (i.e. the 2x2 FIGURE MATRIX) is uniformly
  // scaled to fit between the header pills and the progress bar; it is then filled
  // to the band (fully cleared of both). Every block that already fits keeps the
  // existing true-centred layout exactly (ttScale stays 1 -> non-fit path).
  let ttScale = 1;
  let ttTop = TT_DENSE_TOP;
  if (tiktok && ttFit) {
    const promptH = estPromptHeight(ttFit.promptText, ttFit.promptFontSize);
    const natural = promptH + (content ? contentGap + ttFit.contentH : 0) + optionsGap + ttFit.optionsH + OPT_SHADOW;
    const band = TT_DENSE_BOTTOM - TT_DENSE_TOP;
    if (natural > band) {
      ttScale = band / natural;
      ttTop = TT_DENSE_TOP + (band - natural * ttScale) / 2; // == TT_DENSE_TOP (block fills the band)
    }
  }
  const useFit = ttScale < 1;
  const block = (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", marginBottom: useFit ? 0 : blockShadowReserve }}>
      {prompt}
      {content ? (
        <div style={{ marginTop: contentGap, width: "100%", display: "flex", justifyContent: "center" }}>{content}</div>
      ) : null}
      <div style={{ marginTop: optionsGap, width: "100%" }}>{options}</div>
    </div>
  );
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      {/* full-frame bg above is UNSCALED (plate's own colour); all readable content
          lives inside the IG safe box in portrait (SafeArea passes through in 16:9). */}
      <SafeArea>
      {useFit ? (
        /* TikTok too-tall block: absolutely placed in the chrome-safe band and
           uniformly scaled (about its top centre) so it clears the pills + bar. */
        <div
          style={{
            position: "absolute",
            left: M,
            right: M,
            top: ttTop,
            transform: `scale(${ttScale})`,
            transformOrigin: "50% 0",
          }}
        >
          {block}
        </div>
      ) : (
        /* flex body (transparent) — the header/countdown/bar chrome is drawn on top */
        <div
          style={{
            position: "absolute",
            inset: 0,
            boxSizing: "border-box",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: headerZone,
            paddingBottom: barZone,
            paddingLeft: M,
            paddingRight: M,
          }}
        >
          <div style={{ flexGrow: spacerTop }} />
          {block}
          <div style={{ flexGrow: spacerBottom }} />
        </div>
      )}

      <HeaderPills idx={pos ?? q.idx} total={total ?? 15} tier={q.tier} countFill={c.countFill} topicFill={c.topicFill} />
      <Countdown elapsed={elapsed} total={q.countdown} accent={c.clock} />
      </SafeArea>
    </AbsoluteFill>
  );
};
