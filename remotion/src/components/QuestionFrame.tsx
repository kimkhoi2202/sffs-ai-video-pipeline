import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { COLORS, slotColors } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { HeaderPills } from "./HeaderPills";
import { Countdown } from "./Countdown";
import { SafeArea } from "./SafeArea";
import type { Question } from "../data/types";

/**
 * Shared question-plate layout. Header row (pills + countdown chip) is pinned at
 * the top and the green progress bar is pinned at the bottom (both drawn as
 * chrome). The question+content+options block sits at its natural height and is
 * VERTICALLY CENTERED (slightly biased up, ~1:2 G1:G2) in the region between the
 * header and the bar via flex-grow spacers. Re-flows for portrait: narrower
 * margins, a taller header zone (the two header pills stack), and the options
 * stack into a single column.
 */
export const HEADER_ZONE = 168; // landscape reserved top region (header + countdown + shadow)
export const BAR_ZONE = 124; // landscape reserved bottom region (progress bar)
export const CONTENT_GAP = 44; // prompt/title -> content (tiles/shapes)
export const OPTIONS_GAP = 40; // prompt/content -> options (G1, small; block biased up)
const SPACER_TOP = 2;
const SPACER_BOTTOM = 3;

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
}> = ({ q, elapsed, prompt, content, options, pos, total }) => {
  const { portrait, M } = useFmt();
  const c = slotColors(q.idx);
  const headerZone = portrait ? 250 : HEADER_ZONE;
  const barZone = portrait ? 150 : BAR_ZONE;
  const contentGap = portrait ? 40 : CONTENT_GAP;
  const optionsGap = portrait ? 40 : OPTIONS_GAP;
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      {/* full-frame bg above is UNSCALED (plate's own colour); all readable content
          lives inside the IG safe box in portrait (SafeArea passes through in 16:9). */}
      <SafeArea>
      {/* flex body (transparent) — the header/countdown/bar chrome is drawn on top */}
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
        <div style={{ flexGrow: SPACER_TOP }} />
        <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          {prompt}
          {content ? (
            <div style={{ marginTop: contentGap, width: "100%", display: "flex", justifyContent: "center" }}>{content}</div>
          ) : null}
          <div style={{ marginTop: optionsGap, width: "100%" }}>{options}</div>
        </div>
        <div style={{ flexGrow: SPACER_BOTTOM }} />
      </div>

      <HeaderPills idx={pos ?? q.idx} total={total ?? 15} tier={q.tier} countFill={c.countFill} topicFill={c.topicFill} />
      <Countdown elapsed={elapsed} total={q.countdown} accent={c.clock} />
      </SafeArea>
    </AbsoluteFill>
  );
};
