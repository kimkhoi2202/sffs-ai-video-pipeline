import { AbsoluteFill } from "remotion";
import { COLORS } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON } from "../theme/fonts";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";

/**
 * Score screen (blue field). Ports render_score with SCORE_TIERS, scaled to the
 * cut's question count: 15 -> [13-15 / 8-12 / 0-7], 10 -> [9-10 / 5-8 / 0-4],
 * 3 -> [3 / 2 / 0-1]. Brand tier names are kept. The "ARE YOU SMART OR FART?"
 * banner is CORAL (non-black fill, black text) so its border + hard shadow show.
 * The tier BAND keeps its hard shadow; the small range badge is FLAT (like the
 * A/B/C/D badges). Re-flows for portrait (range chip left, name beside it).
 */
type Tier = [range: string, name: string, color: string];

const NAMES: [string, string, string] = ["CERTIFIED SMART FELLA", "SHARP COOKIE", "CERTIFIED FART SMELLA"];
const COLORSET: [string, string, string] = [COLORS.mint, COLORS.yellow, COLORS.coral];

/** Tier ranges scaled to the total question count. Tiny totals (the sub-60s
 *  1-question teasers) collapse to a 2-tier binary result. */
export const computeTiers = (total: number): Tier[] => {
  if (total <= 1) return [["1", NAMES[0], COLORSET[0]], ["0", NAMES[2], COLORSET[2]]];
  if (total === 2) return [["2", NAMES[0], COLORSET[0]], ["1", NAMES[1], COLORSET[1]], ["0", NAMES[2], COLORSET[2]]];
  let ranges: [string, string, string];
  if (total === 3) ranges = ["3", "2", "0-1"];
  else if (total === 10) ranges = ["9-10", "5-8", "0-4"];
  else if (total === 15) ranges = ["13-15", "8-12", "0-7"];
  else {
    const hi = Math.ceil(total * 0.8);
    const mid = Math.ceil(total * 0.45);
    ranges = [`${hi}-${total}`, `${mid}-${hi - 1}`, `0-${mid - 1}`];
  }
  return ranges.map((r, i) => [r, NAMES[i], COLORSET[i]] as Tier);
};

export const Score: React.FC<{ total?: number }> = ({ total = 15 }) => {
  const { w, portrait } = useFmt();
  const tiers = computeTiers(total);

  if (portrait) {
    const M = 64;
    const bandW = w - 2 * M;
    // center the stack: a 2-tier binary result (sub-60s) sits a touch lower so it
    // reads centered; the 3-tier result keeps its approved position.
    const y0 = tiers.length === 2 ? 660 : 560;
    const step = 300;
    const bandH = 236;
    const chipW = 220;
    const chipH = 128;
    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.blue }}>
        <div style={{ position: "absolute", left: w / 2, top: 230, transform: "translate(-50%, -50%)" }}>
          <Pill text="ARE YOU SMART OR FART?" fill={COLORS.coral} textColor={COLORS.ink} fontSize={40} tracking={3} padX={34} padY={18} />
        </div>
        <div style={{ position: "absolute", left: 0, top: 380, width: w, transform: "translateY(-50%)", textAlign: "center", fontFamily: ANTON, fontSize: 100, color: COLORS.ink, lineHeight: 1 }}>
          SCORE YOURSELF
        </div>

        {tiers.map(([range, name, color], i) => {
          const y = y0 + i * step;
          const chipX = M + 26;
          const nameX = chipX + chipW + 44;
          return (
            <div key={range}>
              <Card x={M} y={y} w={bandW} h={bandH} radius={40} border={9} fill={color} shadow={16} />
              <Card x={chipX} y={y + (bandH - chipH) / 2} w={chipW} h={chipH} radius={22} border={7} fill={COLORS.paper} shadow={0} />
              <div style={{ position: "absolute", left: chipX, top: y + (bandH - chipH) / 2, width: chipW, height: chipH, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: ANTON, fontSize: 74, color: COLORS.ink }}>
                {range}
              </div>
              <div style={{ position: "absolute", left: nameX, top: y, width: M + bandW - nameX - 28, height: bandH, display: "flex", alignItems: "center", fontFamily: ANTON, fontSize: 50, lineHeight: 1.02, color: COLORS.ink, textTransform: "uppercase" }}>
                {name}
              </div>
            </div>
          );
        })}
      </AbsoluteFill>
    );
  }

  // landscape (unchanged from the approved master)
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.blue }}>
      <div style={{ position: "absolute", left: w / 2, top: 138, transform: "translate(-50%, -50%)" }}>
        <Pill text="ARE YOU SMART OR FART?" fill={COLORS.coral} textColor={COLORS.ink} fontSize={38} tracking={4} padX={36} padY={18} />
      </div>
      <div style={{ position: "absolute", left: 0, top: 278, width: w, transform: "translateY(-50%)", textAlign: "center", fontFamily: ANTON, fontSize: 96, color: COLORS.ink, lineHeight: 1 }}>
        SCORE YOURSELF
      </div>

      {tiers.map(([range, name, color], i) => {
        const y = 372 + i * 186;
        return (
          <div key={range}>
            <Card x={330} y={y} w={w - 660} h={150} radius={36} border={9} fill={color} shadow={16} />
            <Card x={354} y={y + 22} w={200} h={106} radius={20} border={6} fill={COLORS.paper} shadow={0} />
            <div style={{ position: "absolute", left: 354, top: y + 22, width: 200, height: 106, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: ANTON, fontSize: 70, color: COLORS.ink }}>
              {range}
            </div>
            <div style={{ position: "absolute", left: 594, top: y, height: 150, display: "flex", alignItems: "center", fontFamily: ANTON, fontSize: 64, color: COLORS.ink }}>
              {name}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
