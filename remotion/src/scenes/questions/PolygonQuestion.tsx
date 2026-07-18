import type { ReactNode } from "react";
import { BADGE_COLORS, COLORS } from "../../theme/brand";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { Polygon } from "../../components/Polygon";
import type { PolygonQuestion as PolyQ } from "../../data/types";

/** Figure-series plate: a growing-sides polygon sequence (FLAT tiles) + four
 *  polygon-icon option cards. Flow layout via QuestionFrame. */
const SEQ_COLORS = [COLORS.blue, COLORS.coral, COLORS.yellow, COLORS.mint];

const Cell: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div style={{ width: 190, height: 190, boxSizing: "border-box", background: COLORS.paper, border: `7px solid ${COLORS.ink}`, borderRadius: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
    {children}
  </div>
);

export const PolygonQuestion: React.FC<{ q: PolyQ; elapsed: number }> = ({ q, elapsed }) => {
  const content = (
    <div style={{ display: "flex", gap: 70, justifyContent: "center", alignItems: "center" }}>
      {q.seq.map((sides, i) => (
        <Cell key={i}>
          <Polygon shape={sides} r={64.6} fill={SEQ_COLORS[i % SEQ_COLORS.length]} border={8} />
        </Cell>
      ))}
      <Cell>
        <span style={{ fontFamily: ANTON, fontSize: 190 * 0.6, lineHeight: 1, color: COLORS.ink }}>?</span>
      </Cell>
    </div>
  );

  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter}>
          <Polygon shape={o.poly} r={72} fill={BADGE_COLORS[o.letter]} border={8} />
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );

  return (
    <QuestionFrame q={q} elapsed={elapsed} prompt={<PromptTitle fontSize={64} radius={36}>{q.prompt}</PromptTitle>} content={content} options={options} />
  );
};
