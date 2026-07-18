import { BADGE_COLORS, COLORS } from "../../theme/brand";
import { ANTON, DM_SANS } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { DotSquare, type DotPos } from "../../components/DotSquare";
import type { DotQuestion as DotQ } from "../../data/types";

/** Position plate: a dot stepping around a square (FLAT cells) + four
 *  dot-position option cards with labels. Flow layout via QuestionFrame. */
const SEQ_COLORS = [COLORS.blue, COLORS.coral, COLORS.yellow, COLORS.mint];
const POS_LABEL: Record<DotPos, string> = {
  tl: "TOP-LEFT",
  tr: "TOP-RIGHT",
  br: "BOTTOM-RIGHT",
  bl: "BOTTOM-LEFT",
  center: "CENTER",
};

export const DotQuestion: React.FC<{ q: DotQ; elapsed: number }> = ({ q, elapsed }) => {
  const content = (
    <div style={{ display: "flex", gap: 70, justifyContent: "center", alignItems: "center" }}>
      {q.seq.map((pos, i) => (
        <DotSquare key={i} size={190} pos={pos} dotColor={SEQ_COLORS[i % SEQ_COLORS.length]} />
      ))}
      <div style={{ position: "relative", width: 190, height: 190 }}>
        <DotSquare size={190} pos={null} dotColor={COLORS.ink} />
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: ANTON, fontSize: 190 * 0.5, lineHeight: 1, color: COLORS.ink }}>
          ?
        </div>
      </div>
    </div>
  );

  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter} badgeSize={74}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
            <DotSquare size={116} pos={o.pos} dotColor={BADGE_COLORS[o.letter]} border={6} sqRadius={8} />
            <span style={{ fontFamily: DM_SANS, fontWeight: 700, fontSize: 28, letterSpacing: "1px", color: COLORS.ink }}>
              {POS_LABEL[o.pos]}
            </span>
          </div>
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );

  return (
    <QuestionFrame q={q} elapsed={elapsed} prompt={<PromptTitle fontSize={64} radius={36}>{q.prompt}</PromptTitle>} content={content} options={options} />
  );
};
