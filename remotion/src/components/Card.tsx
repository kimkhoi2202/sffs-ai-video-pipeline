import type { CSSProperties, ReactNode } from "react";
import { COLORS, hardShadow } from "../theme/brand";

/**
 * A neo-brutalist bordered, rounded box — the base of every plate surface
 * (prompt box, tiles, option cards, explanation card). Thick black border +
 * flat fill, with an OPTIONAL hard offset shadow. Set `shadow={0}` for FLAT
 * chrome (the approved plate spec: prompt boxes, tiles + badges read flat).
 */
export const Card: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
  border: number;
  fill: string;
  shadow?: number;
  shadowColor?: string;
  borderColor?: string;
  style?: CSSProperties;
  children?: ReactNode;
}> = ({ x, y, w, h, radius, border, fill, shadow = 0, shadowColor = COLORS.ink, borderColor = COLORS.ink, style, children }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      boxSizing: "border-box",
      background: fill,
      border: `${border}px solid ${borderColor}`,
      borderRadius: radius,
      boxShadow: hardShadow(shadow, shadowColor),
      ...style,
    }}
  >
    {children}
  </div>
);
