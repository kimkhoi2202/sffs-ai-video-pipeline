import { COLORS, M, VIDEO, slotColors } from "../../theme/brand";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { TextOptionsGrid } from "../../components/OptionCards";
import type { NumSeriesQuestion as NumQ } from "../../data/types";

/** Number-series plate: FLAT prompt title + a centered row of FLAT number tiles
 *  (the "?" tile takes the clock accent), then the 2x2 text options. */
export const NumSeriesQuestion: React.FC<{ q: NumQ; elapsed: number }> = ({ q, elapsed }) => {
  const clock = slotColors(q.idx).clock;
  const n = q.seq.length;
  const gap = 36;
  const tw = Math.min(160, Math.floor((VIDEO.width - 2 * M - (n - 1) * gap) / n));

  const content = (
    <div style={{ display: "flex", gap, justifyContent: "center", alignItems: "center" }}>
      {q.seq.map((tok, i) => (
        <div
          key={i}
          style={{
            width: tw,
            height: 132,
            boxSizing: "border-box",
            background: tok === "?" ? clock : COLORS.paper,
            border: `8px solid ${COLORS.ink}`,
            borderRadius: 22,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: ANTON,
            fontSize: tok.length <= 2 ? 92 : 84,
            lineHeight: 1,
            color: COLORS.ink,
          }}
        >
          {tok}
        </div>
      ))}
    </div>
  );

  return (
    <QuestionFrame
      q={q}
      elapsed={elapsed}
      prompt={<PromptTitle fontSize={64} radius={36}>{q.prompt}</PromptTitle>}
      content={content}
      options={<TextOptionsGrid options={q.options} />}
    />
  );
};
