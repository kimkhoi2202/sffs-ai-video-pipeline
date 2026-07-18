import { AbsoluteFill } from "remotion";
import { COLORS } from "../theme/brand";
import { useFmt } from "../theme/layout";
import { ANTON, DM_SANS } from "../theme/fonts";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { LetterBadge } from "../components/LetterBadge";

/**
 * Unified reveal plate (MINT field): a "CORRECT ANSWER" banner, the answer as an
 * OPTION-STYLE card (colored letter badge + text answer, OR badge + shape +
 * label), and an explanation card. NO green checkmark. Flat letter badge; the
 * correct-answer card is FLAT; the explanation card keeps its shadow. Landscape
 * uses shadow-aware optical centering (right spacer balances the left badge,
 * pill nudged up-left). Portrait centers the [badge + answer] as one group and
 * stacks the cards with room to breathe.
 */
type Answer = { kind: "text"; text: string } | { kind: "shape"; node: React.ReactNode; label: string };

const PILL_SHADOW = 8;
const EXPL_SHADOW = 16;

export const Reveal: React.FC<{ letter: string; explanation: string; answer: Answer }> = ({ letter, explanation, answer }) => {
  const { w, portrait, M } = useFmt();

  if (portrait) {
    const cardX = M;
    const cardW = w - 2 * M;
    // Answer card OPTICALLY CENTERED between the pill above and the explanation
    // below: the pill's hard shadow (PILL_SHADOW, offset down) eats into the top
    // gap, so the raw top gap is opened ~PILL_SHADOW more than the bottom gap to
    // make the two VISIBLE gaps equal (~70px each). Group stays centered at 960.
    const pillCy = 450;
    const cardY = 573;
    const cardH = 236;
    const badge = 150;
    const explY = cardY + cardH + 70;
    const explH = 620;
    return (
      <AbsoluteFill style={{ backgroundColor: COLORS.mint }}>
        <div style={{ position: "absolute", left: w / 2 - PILL_SHADOW / 2, top: pillCy - PILL_SHADOW / 2, transform: "translate(-50%, -50%)" }}>
          <Pill text="CORRECT ANSWER" fill={COLORS.coral} textColor={COLORS.ink} fontSize={40} tracking={3} padX={34} padY={18} shadow={PILL_SHADOW} />
        </div>

        {/* answer card (FLAT): badge + answer centered together as a group */}
        <Card x={cardX} y={cardY} w={cardW} h={cardH} radius={30} border={9} fill={COLORS.paper} shadow={0} />
        <div
          style={{
            position: "absolute",
            left: cardX,
            top: cardY,
            width: cardW,
            height: cardH,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: answer.kind === "shape" ? 30 : 34,
            fontFamily: ANTON,
            fontSize: answer.kind === "shape" ? 70 : 84,
            lineHeight: 1,
            color: COLORS.ink,
            textTransform: "uppercase",
            padding: "0 40px",
            boxSizing: "border-box",
          }}
        >
          <LetterBadge letter={letter} size={badge} radius={18} border={7} shadow={0} />
          {answer.kind === "shape" ? (
            <>
              {answer.node}
              <span>{answer.label}</span>
            </>
          ) : (
            <span>{answer.text}</span>
          )}
        </div>

        {/* explanation card (keeps shadow) */}
        <Card x={cardX - EXPL_SHADOW / 2} y={explY} w={cardW} h={explH} radius={36} border={8} fill={COLORS.cream} shadow={EXPL_SHADOW} />
        <div
          style={{
            position: "absolute",
            left: cardX - EXPL_SHADOW / 2 + 52,
            top: explY,
            width: cardW - 104,
            height: explH,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontFamily: DM_SANS,
            fontWeight: 500,
            fontSize: 48,
            lineHeight: 1.32,
            color: COLORS.ink,
          }}
        >
          {explanation}
        </div>
      </AbsoluteFill>
    );
  }

  // landscape (unchanged from the approved master)
  const CARD = { x: 300, y: 252, w: w - 600, h: 208 };
  const INSET = 30;
  const BADGE = CARD.h - 2 * INSET; // 148
  const BADGE_X = CARD.x + INSET; // 330
  const TEXT_LEFT = BADGE_X + BADGE + 50; // 528
  const SIDE = TEXT_LEFT - CARD.x; // 228
  const CONTENT_W = CARD.w - 2 * SIDE; // 864
  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.mint }}>
      <div style={{ position: "absolute", left: w / 2 - PILL_SHADOW / 2, top: 150 - PILL_SHADOW / 2, transform: "translate(-50%, -50%)" }}>
        <Pill text="CORRECT ANSWER" fill={COLORS.coral} textColor={COLORS.ink} fontSize={38} tracking={4} padX={36} padY={18} shadow={PILL_SHADOW} />
      </div>

      <Card x={CARD.x} y={CARD.y} w={CARD.w} h={CARD.h} radius={30} border={9} fill={COLORS.paper} shadow={0} />
      <div style={{ position: "absolute", left: BADGE_X, top: CARD.y + INSET }}>
        <LetterBadge letter={letter} size={BADGE} radius={18} border={7} shadow={0} />
      </div>
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

      <Card x={M - EXPL_SHADOW / 2} y={516} w={w - 2 * M} h={386} radius={36} border={8} fill={COLORS.cream} shadow={EXPL_SHADOW} />
      <div
        style={{
          position: "absolute",
          left: M - EXPL_SHADOW / 2 + 60,
          top: 516,
          width: w - 2 * M - 120,
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
};
