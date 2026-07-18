import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";

/**
 * The six perimeter shapes from the reworked website hero
 * (components/quiz/smart-fart-hero.tsx SHAPES + ShapeVisual), mirrored for the
 * video: same types, brand colors, home fractions, and neo-brutalist look
 * (ink border + hard offset shadow; SVG shapes use a matching hard drop-shadow).
 * VIDEO-ONLY sizes: scaled up ~1.45x from the web-hero px so they read boldly in
 * the 1920x1080 frame (the website keeps its own smaller sizes). No drag — a
 * springy staggered entrance settles into calm ambient drift (~±28px) + gentle
 * rotation. Transform + opacity only.
 *
 * `overrides` recolors a shape by type (e.g. the outro is GREEN, so the green
 * hexagon is overridden to a contrasting color there so nothing blends into bg).
 */
type ShapeType = "circle" | "roundSquare" | "hexagon" | "pill" | "triangle" | "diamond";
const BORDER = 4; // div border (svg stroke auto-scales in the 100-viewBox)
const SHADOW = 7; // hard offset shadow (~1.45x the hero's 5px)

type Def = {
  id: string;
  type: ShapeType;
  color: string;
  w: number;
  h: number;
  fx: number; // home fraction of the 1920x1080 frame
  fy: number;
  spin: number; // base tilt (deg), matches the hero rest state
  rot: number; // gentle continuous rotation (deg/s)
  ax: number; // drift amplitude x (px)
  ay: number; // drift amplitude y (px)
  hz: number; // drift frequency (Hz)
  ph: number; // drift phase
};

// Sizes ~1.45x the hero. hexagon/diamond homes nudged slightly inward so the
// bigger shapes don't clip the frame edge (perimeter framing preserved).
const SHAPES: Def[] = [
  { id: "circle", type: "circle", color: COLORS.blue, w: 185, h: 185, fx: 0.12, fy: 0.2, spin: 4, rot: 5, ax: 18, ay: 24, hz: 0.11, ph: 0.0 },
  { id: "roundsq", type: "roundSquare", color: COLORS.mint, w: 150, h: 150, fx: 0.89, fy: 0.19, spin: 6, rot: 6, ax: -16, ay: 20, hz: 0.12, ph: 1.1 },
  { id: "hexagon", type: "hexagon", color: COLORS.green, w: 168, h: 168, fx: 0.93, fy: 0.52, spin: -4, rot: -4, ax: 12, ay: 24, hz: 0.1, ph: 2.0 },
  { id: "pill", type: "pill", color: COLORS.paper, w: 217, h: 92, fx: 0.87, fy: 0.83, spin: 5, rot: 5, ax: -18, ay: 16, hz: 0.13, ph: 1.6 },
  { id: "triangle", type: "triangle", color: COLORS.blue, w: 148, h: 148, fx: 0.12, fy: 0.82, spin: -6, rot: -6, ax: 16, ay: 22, hz: 0.16, ph: 0.6 },
  { id: "diamond", type: "diamond", color: COLORS.coral, w: 162, h: 162, fx: 0.075, fy: 0.5, spin: 5, rot: 5, ax: 18, ay: 18, hz: 0.09, ph: 0.9 },
];

const POLY: Partial<Record<ShapeType, string>> = {
  triangle: "50,6 94,90 6,90",
  diamond: "50,4 96,50 50,96 4,50",
  hexagon: "50,4 91,27 91,73 50,96 9,73 9,27",
};

const ShapeVisual: React.FC<{ def: Def; color: string }> = ({ def, color }) => {
  const { type, w, h } = def;
  if (type === "circle" || type === "pill" || type === "roundSquare") {
    return (
      <div
        style={{
          width: w,
          height: h,
          boxSizing: "border-box",
          background: color,
          border: `${BORDER}px solid ${COLORS.ink}`,
          borderRadius: type === "roundSquare" ? "26%" : 9999,
          boxShadow: hardShadow(SHADOW),
        }}
      />
    );
  }
  return (
    <svg width={w} height={h} viewBox="0 0 100 100" style={{ overflow: "visible", display: "block", filter: hardDropShadow(SHADOW) }}>
      <polygon points={POLY[type]} fill={color} stroke={COLORS.ink} strokeWidth={8} strokeLinejoin="round" />
    </svg>
  );
};

export const HeroShapes: React.FC<{ overrides?: Partial<Record<ShapeType, string>> }> = ({ overrides }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const t = frame / fps;
  // The fx/fy home fractions frame the perimeter on ANY aspect; portrait is
  // narrower so the shapes are scaled down a touch to avoid crowding the title.
  const portrait = height > width;
  const sz = portrait ? 0.8 : 1;
  return (
    <>
      {SHAPES.map((s, i) => {
        const cx = s.fx * width;
        const cy = s.fy * height;
        const dx = s.ax * Math.sin(2 * Math.PI * s.hz * t + s.ph);
        const dy = s.ay * Math.sin(2 * Math.PI * s.hz * t + s.ph + 1.3);
        const angle = s.spin + s.rot * t;
        const p = spring({ frame: frame - i * 3, fps, config: { damping: 13, stiffness: 170, mass: 0.7 } });
        const scale = interpolate(p, [0, 1], [0.6, 1]) * sz;
        const opacity = interpolate(p, [0, 1], [0, 1], { extrapolateRight: "clamp" });
        return (
          <div
            key={s.id}
            style={{
              position: "absolute",
              left: cx,
              top: cy,
              transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px)`,
              opacity,
            }}
          >
            <div style={{ transform: `rotate(${angle}deg) scale(${scale})`, display: "flex" }}>
              <ShapeVisual def={s} color={overrides?.[s.type] ?? s.color} />
            </div>
          </div>
        );
      })}
    </>
  );
};
