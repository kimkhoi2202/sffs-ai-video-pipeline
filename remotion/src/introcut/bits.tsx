import type { ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardShadow } from "../theme/brand";
import { ANTON } from "../theme/fonts";
import { HeroShapes } from "../components/HeroShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";

/**
 * SELF-CONTAINED brand kit for the intro cut. Nothing here is imported by the
 * running render; it only READS the shared brand tokens + hero components so the
 * intro matches the site + the existing videos exactly (neo-brutalist: Anton
 * caps, ink outline, hard offset shadow, floating shapes, synthwave grid).
 */

type ShapeType = "circle" | "roundSquare" | "hexagon" | "pill" | "triangle" | "diamond";

/** Per-background HeroShapes recolors so no shape blends into the field. */
const SHAPE_OVERRIDES: Record<string, Partial<Record<ShapeType, string>>> = {
  [COLORS.yellow]: {},
  [COLORS.blue]: { circle: COLORS.coral, triangle: COLORS.yellow },
  [COLORS.coral]: { diamond: COLORS.blue },
  [COLORS.green]: { hexagon: COLORS.yellow },
};

/** Full brand backdrop: solid field + drifting perspective grid + floating hero
 *  shapes, with all foreground content rendered above (zIndex 1). */
export const Stage: React.FC<{ bg: string; children: ReactNode; shapePos?: Record<string, { fx?: number; fy?: number }> }> = ({ bg, children, shapePos }) => (
  <AbsoluteFill style={{ backgroundColor: bg }}>
    <PerspectiveGrid base={bg} />
    <HeroShapes overrides={SHAPE_OVERRIDES[bg]} posOverrides={shapePos} />
    <AbsoluteFill style={{ zIndex: 1 }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);

/** Anton display line with the signature ink stroke + hard offset shadow. */
export const titleStyle = (size: number, color: string): React.CSSProperties => ({
  fontFamily: ANTON,
  fontSize: size,
  lineHeight: 1.02,
  color,
  WebkitTextStroke: `${Math.max(2, size * 0.02)}px ${COLORS.ink}`,
  textShadow: `${size * 0.045}px ${size * 0.045}px 0 ${COLORS.ink}`,
  textTransform: "uppercase",
  textAlign: "center",
  margin: 0,
  letterSpacing: "0.005em",
  whiteSpace: "nowrap",
});

/** Rounded neo-brutalist pill (brand fill, ink border, hard shadow). Never a
 *  black fill (brand rule): default fill is paper. */
export const BrandPill: React.FC<{
  children: ReactNode;
  fill?: string;
  size?: number;
  pad?: string;
  shadow?: number;
  maxWidth?: number;
}> = ({ children, fill = COLORS.paper, size = 46, pad = "18px 40px", shadow = 9, maxWidth }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      background: fill,
      color: COLORS.ink,
      border: `6px solid ${COLORS.ink}`,
      borderRadius: 9999,
      padding: pad,
      boxShadow: hardShadow(shadow),
      fontFamily: ANTON,
      fontSize: size,
      lineHeight: 1.05,
      textTransform: "uppercase",
      letterSpacing: "0.01em",
      maxWidth,
    }}
  >
    {children}
  </div>
);

/** Spring pop + rise + fade entrance. Positioned absolutely by center point. */
export const PopIn: React.FC<{
  delay: number;
  cx: number;
  cy: number;
  from?: number;
  rise?: number;
  children: ReactNode;
}> = ({ delay, cx, cy, from = 0.6, rise = 26, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 13, stiffness: 180, mass: 0.6 } });
  const scale = interpolate(p, [0, 1], [from, 1]);
  const opacity = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
  const dy = interpolate(p, [0, 1], [rise, 0]);
  return (
    <div
      style={{
        position: "absolute",
        left: cx,
        top: cy + dy,
        transform: "translate(-50%, -50%)",
        opacity,
        width: "max-content",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div style={{ transform: `scale(${scale})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {children}
      </div>
    </div>
  );
};
