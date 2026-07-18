import { useFmt } from "../theme/layout";
import { Pill } from "./Pill";

/**
 * The top header on every question plate: the "QUESTION X OF N" count pill + the
 * topic/category pill. Landscape lays them side by side; portrait stacks them
 * (the frame is narrow, and the countdown chip sits top-right) so neither pill
 * collides with the chip. Fill colors come from the rotating slot scheme, so
 * they're always distinct from each other, the background, and the clock. Both
 * keep black text/border + hard shadow.
 */
export const HeaderPills: React.FC<{
  idx: number;
  total: number;
  tier: string;
  countFill: string;
  topicFill: string;
}> = ({ idx, total, tier, countFill, topicFill }) => {
  const { portrait, M } = useFmt();
  const fontSize = portrait ? 32 : 34;
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
      <Pill text={`QUESTION ${idx} OF ${total}`} fill={countFill} fontSize={fontSize} />
      <Pill text={tier} fill={topicFill} fontSize={fontSize} />
    </div>
  );
};
