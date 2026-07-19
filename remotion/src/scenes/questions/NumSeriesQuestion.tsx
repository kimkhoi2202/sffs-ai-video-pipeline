import { COLORS, slotColors } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { TextOptionsGrid } from "../../components/OptionCards";
import type { NumSeriesQuestion as NumQ } from "../../data/types";

/** Number-series plate: FLAT prompt title + a centered row of FLAT number tiles
 *  (the "?" tile takes the clock accent), then the text options. Tiles shrink to
 *  fit the frame width, so long sequences stay on one row in portrait too. */
export const NumSeriesQuestion: React.FC<{ q: NumQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { w, M, portrait } = useFmt();
  const clock = slotColors(q.idx).clock;
  const n = q.seq.length;
  const gap = portrait ? 20 : 36;
  // Wrap a long series onto TWO rows (portrait) so the number tiles stay big and
  // use vertical space rather than shrinking on one cramped row. 16:9 fits more.
  const maxPerRow = portrait ? 5 : 8;
  const nRows = Math.ceil(n / maxPerRow);
  const perRow = Math.ceil(n / nRows);
  const tw = Math.min(portrait ? 128 : 160, Math.floor((w - 2 * M - (perRow - 1) * gap) / perRow));
  const th = portrait ? 118 : 132;
  const bigFont = Math.min(portrait ? 68 : 92, Math.floor(tw * 0.62));
  const smallFont = Math.min(portrait ? 58 : 84, Math.floor(tw * 0.52));

  const tile = (tok: string, i: number) => (
    <div
      key={i}
      style={{
        width: tw,
        height: th,
        boxSizing: "border-box",
        background: tok === "?" ? clock : COLORS.paper,
        border: `8px solid ${COLORS.ink}`,
        borderRadius: 22,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: ANTON,
        fontSize: tok.length <= 2 ? bigFont : smallFont,
        lineHeight: 1,
        color: COLORS.ink,
      }}
    >
      {tok}
    </div>
  );
  const rows = [];
  for (let i = 0; i < n; i += perRow) rows.push(q.seq.slice(i, i + perRow).map((tok, j) => tile(tok, i + j)));
  const content = (
    <div style={{ display: "flex", flexDirection: "column", gap: Math.round(th * 0.16), alignItems: "center" }}>
      {rows.map((row, ri) => (
        <div key={ri} style={{ display: "flex", gap, justifyContent: "center", alignItems: "center" }}>{row}</div>
      ))}
    </div>
  );

  return (
    <QuestionFrame
      q={q}
      elapsed={elapsed}
      pos={pos}
      total={total}
      prompt={<PromptTitle fontSize={portrait ? 50 : 64} radius={36}>{q.prompt}</PromptTitle>}
      content={content}
      options={<TextOptionsGrid options={q.options} />}
    />
  );
};
