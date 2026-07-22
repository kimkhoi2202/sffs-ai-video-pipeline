import { COLORS } from "../../theme/brand";
import { useFmt } from "../../theme/layout";
import { DM_SANS } from "../../theme/fonts";
import { QuestionFrame, PromptTitle } from "../../components/QuestionFrame";
import { ShapeOptionsRow, ShapeOptionCard } from "../../components/OptionCards";
import { foldAxes, flapRect, foldStages, type FoldAxis, type FoldDir, type HoleCell, type Rect } from "../../data/fold";
import type { FoldQuestion as FoldQ } from "../../data/types";

/** Fold action color (the flap tint + fold arrow): coral reads "this part folds". */
const FLAP_TINT = "rgba(253, 121, 98, 0.30)"; // COLORS.coral @ 30%
const CREASE = COLORS.ink;

/* -------------------------------------------------------------------------- */
/* HoleGrid — an UNFOLDED sheet: white paper, faint fold-crease line(s), and the */
/* punched holes as solid ink discs. Used for every A-D option + the reveal.    */
/* -------------------------------------------------------------------------- */
export const HoleGrid: React.FC<{
  size: number;
  n: number;
  holes: HoleCell[];
  creases?: FoldAxis[];
  border?: number;
  radius?: number;
}> = ({ size, n, holes, creases = [], border = 7, radius = 14 }) => {
  const S = size;
  const b = border;
  const holeR = (S / n) * 0.32;
  const cx = (c: number) => ((c + 0.5) / n) * S;
  const cy = (r: number) => ((r + 0.5) / n) * S;
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ overflow: "visible", display: "block" }}>
      <rect x={b / 2} y={b / 2} width={S - b} height={S - b} rx={radius} fill={COLORS.paper} stroke={COLORS.ink} strokeWidth={b} />
      {creases.includes("V") ? (
        <line x1={S / 2} y1={b} x2={S / 2} y2={S - b} stroke={COLORS.sepGray} strokeWidth={3} strokeDasharray="9 9" />
      ) : null}
      {creases.includes("H") ? (
        <line x1={b} y1={S / 2} x2={S - b} y2={S / 2} stroke={COLORS.sepGray} strokeWidth={3} strokeDasharray="9 9" />
      ) : null}
      {holes.map((h, i) => (
        <circle key={i} cx={cx(h.c)} cy={cy(h.r)} r={holeR} fill={COLORS.ink} />
      ))}
    </svg>
  );
};

/* -------------------------------------------------------------------------- */
/* PaperMini — one stage of the fold strip. Draws a ghost of the full sheet, the */
/* current paper packet, and EITHER the next fold (tinted flap + dashed crease + */
/* fold arrow) OR, on the final stage, the punched hole(s) with bold crease edges.*/
/* -------------------------------------------------------------------------- */
const PaperMini: React.FC<{
  size: number;
  n: number;
  rect: Rect; // current packet, in [0,1]
  nextFold?: FoldDir; // the fold applied to THIS stage (omitted on the last)
  holes?: HoleCell[]; // punched holes (final stage only)
  creaseEdges?: FoldDir[]; // folded edges to draw bold (final stage only)
  border?: number;
}> = ({ size, n, rect, nextFold, holes = [], creaseEdges = [], border = 6 }) => {
  const S = size;
  const px = (v: number) => v * S;
  const b = border;
  const paper = { x: px(rect.x0), y: px(rect.y0), w: px(rect.x1 - rect.x0), h: px(rect.y1 - rect.y0) };
  const holeR = (S / n) * 0.3;

  // crease line + flap for the upcoming fold (drawn relative to THIS packet)
  const mx = px((rect.x0 + rect.x1) / 2);
  const my = px((rect.y0 + rect.y1) / 2);
  const flap = nextFold ? flapRect(rect, nextFold) : null;

  // bold folded edges on the final packet (which side each fold creased)
  const edgeLine = (d: FoldDir): [number, number, number, number] => {
    if (d === "left") return [px(rect.x1), px(rect.y0), px(rect.x1), px(rect.y1)];
    if (d === "right") return [px(rect.x0), px(rect.y0), px(rect.x0), px(rect.y1)];
    if (d === "up") return [px(rect.x0), px(rect.y1), px(rect.x1), px(rect.y1)];
    return [px(rect.x0), px(rect.y0), px(rect.x1), px(rect.y0)]; // down
  };

  // fold arrow: a clean curved "fold-over" arc sweeping from the flap's OUTER edge
  // across to the crease, arrowhead pointing in the fold direction. Communicates
  // "this whole half folds THIS way onto the other half".
  const arrow = () => {
    if (!nextFold || !flap) return null;
    const fcx = px((flap.x0 + flap.x1) / 2);
    const fcy = px((flap.y0 + flap.y1) / 2);
    const bulge = Math.min(paper.w, paper.h) * 0.22;
    let sx = fcx, sy = fcy, ex = fcx, ey = fcy, ctrlx = fcx, ctrly = fcy;
    if (nextFold === "left") { sx = px(flap.x1) - 6; ex = mx - 4; sy = ey = fcy; ctrlx = (sx + ex) / 2; ctrly = fcy - bulge; }
    else if (nextFold === "right") { sx = px(flap.x0) + 6; ex = mx + 4; sy = ey = fcy; ctrlx = (sx + ex) / 2; ctrly = fcy - bulge; }
    else if (nextFold === "up") { sy = px(flap.y1) - 6; ey = my - 4; sx = ex = fcx; ctrly = (sy + ey) / 2; ctrlx = fcx + bulge; }
    else { sy = px(flap.y0) + 6; ey = my + 4; sx = ex = fcx; ctrly = (sy + ey) / 2; ctrlx = fcx - bulge; }
    const a = 15; // arrowhead size
    const head =
      nextFold === "left" ? `${ex},${ey} ${ex + a},${ey - a} ${ex + a},${ey + a}`
      : nextFold === "right" ? `${ex},${ey} ${ex - a},${ey - a} ${ex - a},${ey + a}`
      : nextFold === "up" ? `${ex},${ey} ${ex - a},${ey + a} ${ex + a},${ey + a}`
      : `${ex},${ey} ${ex - a},${ey - a} ${ex + a},${ey - a}`;
    return (
      <>
        <path d={`M ${sx} ${sy} Q ${ctrlx} ${ctrly} ${ex} ${ey}`} fill="none" stroke={COLORS.coral} strokeWidth={6} strokeLinecap="round" />
        <polygon points={head} fill={COLORS.coral} stroke={COLORS.coral} strokeWidth={1} strokeLinejoin="round" />
      </>
    );
  };

  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ overflow: "visible", display: "block" }}>
      {/* ghost of the full sheet (shows how much has folded away) */}
      <rect x={2} y={2} width={S - 4} height={S - 4} rx={12} fill="none" stroke={COLORS.ghostGray} strokeWidth={2} strokeDasharray="4 7" />
      {/* current paper packet */}
      <rect x={paper.x + b / 2} y={paper.y + b / 2} width={paper.w - b} height={paper.h - b} rx={12} fill={COLORS.paper} stroke={COLORS.ink} strokeWidth={b} />
      {/* upcoming fold: tinted flap + dashed crease + arrow */}
      {flap ? (
        <rect x={px(flap.x0) + b / 2} y={px(flap.y0) + b / 2} width={px(flap.x1 - flap.x0) - b} height={px(flap.y1 - flap.y0) - b} rx={8} fill={FLAP_TINT} />
      ) : null}
      {nextFold && foldAxes([nextFold])[0] === "V" ? (
        <line x1={mx} y1={paper.y + b} x2={mx} y2={paper.y + paper.h - b} stroke={CREASE} strokeWidth={3} strokeDasharray="8 8" />
      ) : null}
      {nextFold && foldAxes([nextFold])[0] === "H" ? (
        <line x1={paper.x + b} y1={my} x2={paper.x + paper.w - b} y2={my} stroke={CREASE} strokeWidth={3} strokeDasharray="8 8" />
      ) : null}
      {arrow()}
      {/* final stage: bold folded edges + punched holes */}
      {creaseEdges.map((d, i) => {
        const [x1, y1, x2, y2] = edgeLine(d);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={COLORS.ink} strokeWidth={b + 5} strokeLinecap="round" />;
      })}
      {holes.map((h, i) => (
        <circle key={i} cx={((h.c + 0.5) / n) * S} cy={((h.r + 0.5) / n) * S} r={holeR} fill={COLORS.ink} />
      ))}
    </svg>
  );
};

const StageLabel: React.FC<{ text: string; w: number }> = ({ text, w }) => (
  <div style={{ width: w, textAlign: "center", marginTop: 12, fontFamily: DM_SANS, fontWeight: 800, fontSize: 24, letterSpacing: "1.5px", color: COLORS.ink }}>
    {text}
  </div>
);

const StepArrow: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", flex: "0 0 auto" }}>
    <path d="M10 50 H70" stroke={COLORS.ink} strokeWidth={10} strokeLinecap="round" />
    <polygon points="66,32 92,50 66,68" fill={COLORS.ink} />
  </svg>
);

/* -------------------------------------------------------------------------- */
/* FoldStrip — the full "SHEET -> FOLD(s) -> PUNCH" filmstrip.                   */
/* -------------------------------------------------------------------------- */
const FoldStrip: React.FC<{ folds: FoldDir[]; punches: HoleCell[]; n: number; portrait: boolean }> = ({ folds, punches, n, portrait }) => {
  const stages = foldStages(folds); // full sheet + one packet per fold
  const nStages = stages.length;
  const cap = portrait ? 188 : 210;
  const arrow = Math.round(cap * 0.34);
  const mini = cap;
  const creaseEdges = folds; // every fold's crease is a folded edge on the packet
  return (
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 0 }}>
      {stages.map((rect, i) => {
        const last = i === nStages - 1;
        const label = i === 0 ? "SHEET" : last ? "PUNCH" : "FOLD";
        return (
          <div key={i} style={{ display: "flex", alignItems: "flex-start" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <PaperMini
                size={mini}
                n={n}
                rect={rect}
                nextFold={last ? undefined : folds[i]}
                holes={last ? punches : []}
                creaseEdges={last ? creaseEdges : []}
              />
              <StageLabel text={label} w={mini} />
            </div>
            {!last ? (
              <div style={{ height: mini, display: "flex", alignItems: "center" }}>
                <StepArrow size={arrow} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* FoldQuestion — the plate. Prompt + fold strip (content) + A-D unfolded grids. */
/* -------------------------------------------------------------------------- */
export const FoldQuestion: React.FC<{ q: FoldQ; elapsed: number; pos?: number; total?: number }> = ({ q, elapsed, pos, total }) => {
  const { portrait } = useFmt();
  const n = q.grid ?? 4;
  const creases = foldAxes(q.folds);
  const content = <FoldStrip folds={q.folds} punches={q.punches} n={n} portrait={portrait} />;
  const gridSize = portrait ? 176 : 150;
  const options = (
    <ShapeOptionsRow>
      {q.options.map((o) => (
        <ShapeOptionCard key={o.letter} letter={o.letter} badgeSize={74}>
          <HoleGrid size={gridSize} n={n} holes={o.holes} creases={creases} />
        </ShapeOptionCard>
      ))}
    </ShapeOptionsRow>
  );
  return (
    <QuestionFrame
      q={q}
      elapsed={elapsed}
      pos={pos}
      total={total}
      prompt={<PromptTitle fontSize={portrait ? 46 : 62} radius={36}>{q.prompt}</PromptTitle>}
      content={content}
      options={options}
    />
  );
};
