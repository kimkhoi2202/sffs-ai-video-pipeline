import type { ReactNode } from "react";
import { AbsoluteFill } from "remotion";
import { COLORS, M, slotColors } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { HeaderPills } from "./HeaderPills";
import { Countdown } from "./Countdown";
import type { Question } from "../data/types";

/**
 * Shared question-plate layout. Header row (pills + countdown chip) is pinned at
 * the top and the green progress bar is pinned at the bottom (both drawn as
 * chrome). The question+content+options block sits at its natural height and is
 * VERTICALLY CENTERED in the region between the header and the bar via equal
 * flex-grow spacers above and below — so there's equal empty space above the
 * question and below the options. When a question is tall the spacers just
 * shrink; the block never overlaps the header or the bar.
 */
export const HEADER_ZONE = 168; // reserved top region (header + countdown + shadow)
export const BAR_ZONE = 124; // reserved bottom region (progress bar)
export const CONTENT_GAP = 44; // prompt/title -> content (tiles/shapes)
export const OPTIONS_GAP = 72; // question group -> answer options

/** The flat white prompt/question box. Natural height — grows with its text. */
export const PromptTitle: React.FC<{ fontSize: number; radius?: number; children: ReactNode }> = ({
  fontSize,
  radius = 40,
  children,
}) => (
  <div
    style={{
      boxSizing: "border-box",
      width: "100%",
      background: COLORS.paper,
      border: `9px solid ${COLORS.ink}`,
      borderRadius: radius,
      padding: "30px 48px",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      fontFamily: ANTON,
      fontSize,
      lineHeight: 1.05,
      color: COLORS.ink,
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);

export const QuestionFrame: React.FC<{
  q: Question;
  elapsed: number;
  prompt: ReactNode;
  content?: ReactNode;
  options: ReactNode;
}> = ({ q, elapsed, prompt, content, options }) => {
  const c = slotColors(q.idx);
  return (
    <AbsoluteFill style={{ backgroundColor: c.bg }}>
      {/* flex body (transparent) — the header/countdown/bar chrome is drawn on top */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          boxSizing: "border-box",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: HEADER_ZONE,
          paddingBottom: BAR_ZONE,
          paddingLeft: M,
          paddingRight: M,
        }}
      >
        <div style={{ flexGrow: 1 }} />
        <div style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          {prompt}
          {content ? (
            <div style={{ marginTop: CONTENT_GAP, width: "100%", display: "flex", justifyContent: "center" }}>{content}</div>
          ) : null}
          <div style={{ marginTop: OPTIONS_GAP, width: "100%" }}>{options}</div>
        </div>
        <div style={{ flexGrow: 1 }} />
      </div>

      <HeaderPills idx={q.idx} total={15} tier={q.tier} countFill={c.countFill} topicFill={c.topicFill} />
      <Countdown elapsed={elapsed} total={q.countdown} accent={c.clock} />
    </AbsoluteFill>
  );
};
