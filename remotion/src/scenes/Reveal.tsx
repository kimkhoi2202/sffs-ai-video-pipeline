import { AbsoluteFill } from "remotion";
import { COLORS, M, VIDEO } from "../theme/brand";
import { ANTON, DM_SANS } from "../theme/fonts";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { LetterBadge } from "../components/LetterBadge";

/**
 * Unified reveal plate (MINT field): a "CORRECT ANSWER" banner, the answer as an
 * OPTION-STYLE card (colored letter badge + text answer, OR badge + shape +
 * label), and an explanation card. NO green checkmark.
 *
 * FLAT letter badge; the correct-answer card is FLAT (no shadow); the
 * explanation card KEEPS its shadow. Optical centering: the answer content
 * centers on the CARD's center (a right spacer equal to the badge footprint
 * balances the left badge), and the shadowed pill + explanation card are nudged
 * up/left by half their shadow so they read optically centered.
 */
// y nudged up 10 so the (flat) answer card is OPTICALLY centered between the
// CORRECT ANSWER pill above (its shadow eats the top gap) and the explanation
// card below: top gap (pill+shadow -> card) ≈ bottom gap (card -> explanation).
const CARD = { x: 300, y: 252, w: VIDEO.width - 600, h: 208 };
const INSET = 30;
const BADGE = CARD.h - 2 * INSET; // 148
const BADGE_X = CARD.x + INSET; // 330
const TEXT_LEFT = BADGE_X + BADGE + 50; // 528
const SIDE = TEXT_LEFT - CARD.x; // 228 = inset + badge + gap (the badge's left footprint)
const CONTENT_W = CARD.w - 2 * SIDE; // 864 -> answer content centers on CARD center (960)

const PILL_SHADOW = 8; // "CORRECT ANSWER" pill hard-shadow offset (nudge up-left by half)
const EXPL_SHADOW = 16; // explanation card hard-shadow offset (nudge left by half)

type Answer = { kind: "text"; text: string } | { kind: "shape"; node: React.ReactNode; label: string };

export const Reveal: React.FC<{ letter: string; explanation: string; answer: Answer }> = ({ letter, explanation, answer }) => (
  <AbsoluteFill style={{ backgroundColor: COLORS.mint }}>
    {/* CORRECT ANSWER pill — nudged up-left by half its shadow for optical centering */}
    <div
      style={{
        position: "absolute",
        left: VIDEO.width / 2 - PILL_SHADOW / 2,
        top: 150 - PILL_SHADOW / 2,
        transform: "translate(-50%, -50%)",
      }}
    >
      <Pill text="CORRECT ANSWER" fill={COLORS.coral} textColor={COLORS.ink} fontSize={38} tracking={4} padX={36} padY={18} shadow={PILL_SHADOW} />
    </div>

    {/* correct-answer card is FLAT (no hard shadow) per spec */}
    <Card x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} radius={30} border={9} fill={COLORS.paper} shadow={0} />
    <div style={{ position: "absolute", left: BADGE_X, top: CARD.y + INSET }}>
      <LetterBadge letter={letter} size={BADGE} radius={18} border={7} shadow={0} />
    </div>

    {/* answer content, optically centered on the card center (symmetric side spacers) */}
    <div
      style={{
        position: "absolute",
        left: TEXT_LEFT,
        top: CARD.y,
        width: CONTENT_W,
        height: CARD.h,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: answer.kind === "shape" ? 44 : 0,
        fontFamily: ANTON,
        fontSize: answer.kind === "shape" ? 88 : 104,
        lineHeight: 1,
        color: COLORS.ink,
        textTransform: "uppercase",
      }}
    >
      {answer.kind === "shape" ? (
        <>
          {answer.node}
          <span>{answer.label}</span>
        </>
      ) : (
        answer.text
      )}
    </div>

    {/* explanation card: 46px gap below the answer card; nudged left by half its
        shadow so the card+shadow reads optically centered */}
    <Card x={M - EXPL_SHADOW / 2} y={516} w={VIDEO.width - 2 * M} h={386} radius={36} border={8} fill={COLORS.cream} shadow={EXPL_SHADOW} />
    <div
      style={{
        position: "absolute",
        left: M - EXPL_SHADOW / 2 + 60,
        top: 516,
        width: VIDEO.width - 2 * M - 120,
        height: 386,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        fontFamily: DM_SANS,
        fontWeight: 500,
        fontSize: 46,
        lineHeight: 1.3,
        color: COLORS.ink,
      }}
    >
      {explanation}
    </div>
  </AbsoluteFill>
);
