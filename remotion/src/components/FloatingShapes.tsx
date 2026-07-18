import type { CSSProperties } from "react";
import { COLORS, hardDropShadow, hardShadow } from "../theme/brand";

/**
 * The five decorative neo-brutalist shapes that frame the intro title on the
 * yellow field — a blue circle, coral rounded-square, mint blob, coral triangle,
 * and a paper pill. Each has the signature thick black border + HARD offset
 * shadow (these KEEP their shadow — they match the website hero,
 * components/quiz/smart-fart-hero.tsx). Positions/motion port
 * render_cogat_round_15.py HERO_SHAPES: each slowly ROTATES (tilt + rot*t) and
 * BOBS (amp*sin) on its own speed. `t` is seconds since the intro started.
 */
type ShapeCfg = {
  kind: "circle" | "rsquare" | "blob" | "triangle" | "pill";
  cx: number;
  cy: number;
  size?: number;
  w?: number;
  h?: number;
  color: string;
  border: number;
  shadow: number;
  radius?: number;
  tilt: number;
  rot: number;
  amp: number;
  hz: number;
  ph: number;
};

const SHAPES: ShapeCfg[] = [
  { kind: "circle", cx: 232, cy: 212, size: 252, color: COLORS.blue, border: 14, shadow: 19, tilt: 0, rot: 6, amp: 20, hz: 0.13, ph: 0.0 },
  { kind: "rsquare", cx: 1698, cy: 206, size: 196, color: COLORS.coral, border: 11, shadow: 15, radius: 29, tilt: -10, rot: 9, amp: 16, hz: 0.12, ph: 1.1 },
  { kind: "blob", cx: 250, cy: 880, size: 300, color: COLORS.mint, border: 17, shadow: 23, tilt: 0, rot: -7, amp: 22, hz: 0.1, ph: 2.0 },
  { kind: "triangle", cx: 176, cy: 556, size: 168, color: COLORS.coral, border: 9, shadow: 13, tilt: 8, rot: 11, amp: 15, hz: 0.16, ph: 0.6 },
  { kind: "pill", cx: 1690, cy: 906, w: 250, h: 104, color: COLORS.paper, border: 14, shadow: 19, radius: 52, tilt: 8, rot: -8, amp: 17, hz: 0.13, ph: 1.6 },
];

const shapeInner = (sp: ShapeCfg): React.ReactNode => {
  const base: CSSProperties = {
    border: `${sp.border}px solid ${COLORS.ink}`,
    background: sp.color,
    boxSizing: "border-box",
    boxShadow: hardShadow(sp.shadow),
  };
  if (sp.kind === "circle") {
    return <div style={{ ...base, width: sp.size, height: sp.size, borderRadius: "50%" }} />;
  }
  if (sp.kind === "rsquare") {
    return <div style={{ ...base, width: sp.size, height: sp.size, borderRadius: sp.radius }} />;
  }
  if (sp.kind === "blob") {
    // Organic border-radius lifted straight from the site hero's mint blob.
    return <div style={{ ...base, width: sp.size, height: sp.size, borderRadius: "62% 38% 55% 45% / 55% 52% 48% 45%" }} />;
  }
  if (sp.kind === "pill") {
    return <div style={{ ...base, width: sp.w, height: sp.h, borderRadius: sp.radius }} />;
  }
  // triangle — SVG polygon with a hard drop-shadow (matches the site's coral triangle)
  const s = (sp.size ?? 0) / 2;
  const w = 1.96 * s;
  const h = 1.72 * s;
  const p = sp.border;
  const svgW = w + 2 * p;
  const svgH = h + 2 * p;
  const pts = `${p + 0.98 * s},${p} ${p + w},${p + h} ${p},${p + h}`;
  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} style={{ overflow: "visible", filter: hardDropShadow(sp.shadow) }}>
      <polygon points={pts} fill={sp.color} stroke={COLORS.ink} strokeWidth={sp.border} strokeLinejoin="round" />
    </svg>
  );
};

export const FloatingShapes: React.FC<{ t: number }> = ({ t }) => (
  <>
    {SHAPES.map((sp, i) => {
      const angle = sp.tilt + sp.rot * t;
      const bob = sp.amp * Math.sin(2 * Math.PI * sp.hz * t + sp.ph);
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: sp.cx,
            top: sp.cy + bob,
            transform: "translate(-50%, -50%)",
          }}
        >
          <div style={{ transform: `rotate(${angle}deg)`, display: "flex" }}>{shapeInner(sp)}</div>
        </div>
      );
    })}
  </>
);
