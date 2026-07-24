import { useFmt, useHeaderConfig } from "../theme/layout";
import { Pill } from "./Pill";
import { showTierPill } from "./headerPillVisibility";

/**
 * The top header on every question plate: the "QUESTION X OF N" count pill + the
 * topic/category pill. Landscape lays them side by side; portrait stacks them
 * (the frame is narrow, and the countdown chip sits top-right) so neither pill
 * collides with the chip. Fill colors come from the rotating slot scheme, so
 * they're always distinct from each other, the background, and the clock. Both
 * keep black text/border + hard shadow.
 *
 * The count pill is prop-driven via HeaderConfig (the loop's progress-counter A/B
 * dimension): `showProgress=false` hides it; `progressStyle="short"` renders the
 * compact "Q1" instead of the full "QUESTION 1 OF 3". Defaults (shown, "full")
 * preserve the committed master / render-ab look. It is also HIDDEN on single-
 * question cuts (total <= 1), where "QUESTION 1 OF 1" is meaningless.
 */
export const HeaderPills: React.FC<{
  idx: number;
  total: number;
  tier: string;
  countFill: string;
  topicFill: string;
}> = ({ idx, total, tier, countFill, topicFill }) => {
  const { portrait, M } = useFmt();
  const { showProgress, progressStyle } = useHeaderConfig();
  const fontSize = portrait ? 32 : 34;
  const showCount = showProgress && total > 1;
  const countText = progressStyle === "short" ? `Q${idx}` : `QUESTION ${idx} OF ${total}`;
  return (
    <div
      style={{
        position: "absolute",
        left: M,
        top: portrait ? 62 : 100,
        transform: portrait ? undefined : "translateY(-50%)",
        display: "flex",
        flexDirection: portrait ? "column" : "row",
        gap: portrait ? 16 : 24,
        alignItems: "flex-start",
      }}
    >
      {showCount ? <Pill text={countText} fill={countFill} fontSize={fontSize} /> : null}
      {showTierPill(tier) ? <Pill text={tier} fill={topicFill} fontSize={fontSize} /> : null}
    </div>
  );
};
