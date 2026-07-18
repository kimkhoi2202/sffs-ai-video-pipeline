import { M } from "../theme/brand";
import { Pill } from "./Pill";

/**
 * The top-left header row on every question plate: the "QUESTION X OF 15" count
 * pill + the topic/category pill. Fill colors are supplied per-plate (from the
 * rotating slot scheme) so they're always distinct from each other, from the
 * background, and from the clock. Both keep black text/border + hard shadow.
 */
export const HeaderPills: React.FC<{
  idx: number;
  total: number;
  tier: string;
  countFill: string;
  topicFill: string;
}> = ({ idx, total, tier, countFill, topicFill }) => (
  <div
    style={{
      position: "absolute",
      left: M,
      top: 100,
      transform: "translateY(-50%)",
      display: "flex",
      gap: 24,
      alignItems: "center",
    }}
  >
    <Pill text={`QUESTION ${idx} OF ${total}`} fill={countFill} fontSize={34} />
    <Pill text={tier} fill={topicFill} fontSize={34} />
  </div>
);
