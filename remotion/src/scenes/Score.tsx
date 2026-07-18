import { AbsoluteFill } from "remotion";
import { COLORS, VIDEO } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";

/**
 * Score screen (blue field). Ports render_score with SCORE_TIERS. The
 * "HOW DID YOU DO?" banner is recolored from black to CORAL (non-black fill,
 * black text) so its border + hard shadow are visible.
 */
const TIERS: [string, string, string][] = [
  ["13-15", "CERTIFIED SMART FELLA", COLORS.mint],
  ["8-12", "SHARP COOKIE", COLORS.yellow],
  ["0-7", "CERTIFIED FART SMELLA", COLORS.coral],
];

const centeredText = (top: number): React.CSSProperties => ({
  position: "absolute",
  left: 0,
  top,
  width: VIDEO.width,
  transform: "translateY(-50%)",
  textAlign: "center",
  lineHeight: 1,
});

export const Score: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: COLORS.blue }}>
    <div style={{ position: "absolute", left: VIDEO.width / 2, top: 138, transform: "translate(-50%, -50%)" }}>
      <Pill text="ARE YOU SMART OR FART?" fill={COLORS.coral} textColor={COLORS.ink} fontSize={38} tracking={4} padX={36} padY={18} />
    </div>
    <div style={{ ...centeredText(278), fontFamily: ANTON, fontSize: 96, color: COLORS.ink }}>SCORE YOURSELF</div>

    {TIERS.map(([score, name, color], i) => {
      const y = 372 + i * 186;
      return (
        <div key={score}>
          {/* colored tier BAND keeps its hard shadow */}
          <Card x={330} y={y} w={VIDEO.width - 660} h={150} radius={36} border={9} fill={color} shadow={16} />
          {/* small number-range badge is FLAT (no shadow), like the A/B/C/D badges */}
          <Card x={354} y={y + 22} w={200} h={106} radius={20} border={6} fill={COLORS.paper} shadow={0} />
          <div style={{ position: "absolute", left: 354, top: y + 22, width: 200, height: 106, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: ANTON, fontSize: 70, color: COLORS.ink }}>
            {score}
          </div>
          <div style={{ position: "absolute", left: 594, top: y, height: 150, display: "flex", alignItems: "center", fontFamily: ANTON, fontSize: 64, color: COLORS.ink }}>
            {name}
          </div>
        </div>
      );
    })}
  </AbsoluteFill>
);
