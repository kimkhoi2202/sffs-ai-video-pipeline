import { BADGE_COLORS, COLORS } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { ANTON, DM_SANS } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { DotSquare, type DotPos } from "../../components/DotSquare";
import type { DotQuestion as DotQ } from "../../data/types";

/** Position plate: a dot stepping around a square (FLAT cells) + four
 *  dot-position option cards with labels. Cells shrink for portrait. */
const SEQ_COLORS = [COLORS.blue, COLORS.coral, COLORS.yellow, COLORS.mint];
const POS_LABEL: Record<DotPos, string> = {
  tl: "TOP-LEFT",
  tm: "TOP",
  tr: "TOP-RIGHT",
  rm: "RIGHT",
  br: "BOTTOM-RIGHT",
  bm: "BOTTOM",
  bl: "BOTTOM-LEFT",
  lm: "LEFT",
  center: "CENTER",
};

export const DotQuestion: React.FC<{ q: DotQ; elapsed: number; pos?: number; total?: number }> = ({
  q,
  elapsed,
  pos,
  total,
}) => {
  const { portrait, w, M } = useFmt();
  const gap = portrait ? 30 : 66;
  const nTiles = q.seq.length + 1; // shown positions + the "?" tile
  // shrink tiles to fit the frame width so longer rotation sequences stay one row
  const TILE = Math.min(portrait ? 130 : 168, Math.floor((w - 2 * M - (nTiles - 1) * gap) / nTiles));

  const content = (
    <div style={{ display: "flex", gap, justifyContent: "center", alignItems: "center" }}>
      {q.seq.map((p, i) => (
        <DotSquare key={i} size={TILE} pos={p} dotColor={SEQ_COLORS[i % SEQ_COLORS.length]} />
      ))}
      <div style={{ position: "relative", width: TILE, height: TILE }}>
        <DotSquare size={TILE} pos={null} dotColor={COLORS.ink} />
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: ANTON, fontSize: TILE * 0.5, lineHeight: 1, color: COLORS.ink }}>
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
            <DotSquare size={108} pos={o.pos} dotColor={BADGE_COLORS[o.letter]} border={6} sqRadius={8} />
            <span style={{ fontFamily: DM_SANS, fontWeight: 700, fontSize: 28, letterSpacing: "1px", color: COLORS.ink }}>
              {POS_LABEL[o.pos]}
            </span>
          </div>
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );

  return (
    <QuestionFrame q={q} elapsed={elapsed} pos={pos} total={total} prompt={<PromptTitle fontSize={portrait ? 46 : 64} radius={36}>{q.prompt}</PromptTitle>} content={content} options={options} />
  );
};
