import { COLORS, M, VIDEO } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { Card } from "./Card";

/**
 * The FLAT prompt bar used by the numseries / figure question types
 * ([M,300,W-M,416], Python pbox). Thick border + white fill, NO shadow.
 */
export const PromptBox: React.FC<{ text: string; fontSize?: number }> = ({ text, fontSize = 64 }) => (
  <>
    <Card x={M} y={200} w={VIDEO.width - 2 * M} h={116} radius={36} border={9} fill={COLORS.paper} shadow={0} />
    <div
      style={{
        position: "absolute",
        left: M,
        top: 200,
        width: VIDEO.width - 2 * M,
        height: 116,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: ANTON,
        fontSize,
        lineHeight: 1,
        color: COLORS.ink,
        textTransform: "uppercase",
      }}
    >
      {text}
    </div>
  </>
);
