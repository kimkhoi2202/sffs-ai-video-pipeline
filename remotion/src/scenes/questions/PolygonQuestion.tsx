import type { ReactNode } from "react";
import { BADGE_COLORS, COLORS } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { ANTON } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { Polygon } from "../../components/Polygon";
import type { PolygonQuestion as PolyQ } from "../../data/types";

/** Figure-series plate: a growing-sides polygon sequence (FLAT tiles) + four
 *  polygon-icon option cards. Tiles shrink for portrait. */
const SEQ_COLORS = [COLORS.blue, COLORS.coral, COLORS.yellow, COLORS.mint];

export const PolygonQuestion: React.FC<{ q: PolyQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait, w, M } = useFmt();
  const gap = portrait ? 34 : 70;
  const nTiles = q.seq.length + 1; // shown shapes + the "?" tile
  // shrink tiles to fit the frame width so longer series stay on one row
  const TILE = Math.min(portrait ? 130 : 168, Math.floor((w - 2 * M - (nTiles - 1) * gap) / nTiles));
  const r = Math.round(TILE * 0.34);

  const Cell: React.FC<{ children: ReactNode }> = ({ children }) => (
    <div style={{ width: TILE, height: TILE, boxSizing: "border-box", background: COLORS.paper, border: `7px solid ${COLORS.ink}`, borderRadius: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
      {children}
    </div>
  );

  const content = (
    <div style={{ display: "flex", gap, justifyContent: "center", alignItems: "center" }}>
      {q.seq.map((sides, i) => (
        <Cell key={i}>
          <Polygon shape={sides} r={r} fill={SEQ_COLORS[i % SEQ_COLORS.length]} border={8} />
        </Cell>
      ))}
      <Cell>
        <span style={{ fontFamily: ANTON, fontSize: TILE * 0.6, lineHeight: 1, color: COLORS.ink }}>?</span>
      </Cell>
    </div>
  );

  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter}>
          <Polygon shape={o.poly} r={63} fill={BADGE_COLORS[o.letter]} border={8} />
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );

  return (
    <QuestionFrame q={q} elapsed={elapsed} pos={pos} total={total} prompt={<PromptTitle fontSize={portrait ? 46 : 64} radius={36}>{q.prompt}</PromptTitle>} content={content} options={options} />
  );
};
