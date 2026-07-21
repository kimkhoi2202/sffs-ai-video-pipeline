import { useCurrentFrame, useVideoConfig } from "remotion";
import type { MouthParams } from "./visemes";

/**
 * The talking brain-mascot, drawn as a first-class vector so it stays perfectly
 * on-brand (matches public/decor/mascot/*.png: a lobed salmon-pink brain, bold
 * black ink outline, gentle wrinkles, big friendly eyes + brows, two nub arms,
 * two little legs) AND lip-syncs crisply. The MOUTH is a fully parametric SVG
 * that reads continuous MouthParams (mapped from Rhubarb visemes upstream), so
 * it swaps between the ~9 shapes with sub-frame precision.
 *
 * Idle life (blink + a tiny bob/tilt) is transform-only and gentle — Emil-calm,
 * deterministic per frame, and disable-able via `idle={false}` (reduced-motion).
 */

// --- brand tokens (mirrors the sticker-sheet mascot + theme/brand.ts) --------
const BODY = "#ef958c"; // salmon-pink brain (sampled from wave.png)
const BODY_DK = "#e07f74"; // subtle belly shade
const INK = "#000000"; // brand ink outline
const SCLERA = "#ffffff";
const PUPIL = "#141414";
const MOUTH_IN = "#6f1f2e"; // dark interior
const TONGUE = "#f4919c"; // pink tongue
const TEETH = "#ffffff";

// --- geometry ----------------------------------------------------------------
const VB = { w: 240, h: 250 };
const HEAD = { cx: 120, cy: 120, rx: 86, ry: 82 };
const EYE = { dx: 30, cy: 104, rx: 20, ry: 23 };
const MOUTH = { cx: 120, cy: 152 };

/** Smooth closed curve (Catmull-Rom -> cubic bezier) through `pts`. */
const closedSpline = (pts: [number, number][]): string => {
  const n = pts.length;
  const f = (v: number) => v.toFixed(2);
  let d = `M ${f(pts[0][0])} ${f(pts[0][1])} `;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C ${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])} `;
  }
  return d + "Z";
};

/** Lobed brain/cloud silhouette — a radius gently modulated by cosine to make
 *  rounded bumps (kept smooth + even so it reads as the brand cloud-brain). */
const brainPath = ((): string => {
  const { cx, cy, rx, ry } = HEAD;
  const lobes = 11;
  const amp = 0.06;
  const n = 96;
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 - Math.PI / 2; // start at top
    // flatten the bottom a touch (where the legs attach) for a grounded stance
    const bottomBias = 1 - 0.07 * Math.max(0, Math.sin(a));
    const m = 1 + amp * Math.cos(lobes * a);
    pts.push([cx + Math.cos(a) * rx * m, cy + Math.sin(a) * ry * m * bottomBias]);
  }
  return closedSpline(pts);
})();

// Brain wrinkles (folds) — short arcs scattered clear of the eyes + mouth.
const WRINKLES = [
  "M120 44 C 129 55 111 63 120 76", // central hemisphere seam
  "M74 74 q 15 9 3 25",
  "M166 74 q -15 9 -3 25",
  "M60 118 q 17 8 5 24",
  "M180 118 q -17 8 -5 24",
  "M78 168 q 13 9 2 21",
  "M162 168 q -13 9 -2 21",
];

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The parametric mouth. Closed shapes render as a friendly smile stroke; open
 *  shapes render a filled aperture with optional teeth + tongue (both clipped). */
const Mouth: React.FC<{ m: MouthParams }> = ({ m }) => {
  const { cx, cy } = MOUTH;
  const halfW = 14 + 20 * m.width;
  const openPx = 44 * m.open;
  const rx = round2(halfW * (1 - 0.5 * m.round));
  const ry = round2((openPx / 2) * (1 + 0.9 * m.round) + 6 * m.round);

  if (openPx < 4) {
    // Sealed — a soft upturned smile (the resting/"X" and "A" read).
    const smile = 12 * m.smile;
    const d = `M ${cx - halfW} ${cy} Q ${cx} ${cy + smile} ${cx + halfW} ${cy}`;
    return <path d={d} fill="none" stroke={INK} strokeWidth={7} strokeLinecap="round" />;
  }

  const clipId = `mouth-clip-${Math.round(rx)}-${Math.round(ry)}`;
  return (
    <g>
      <defs>
        <clipPath id={clipId}>
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry} />
        </clipPath>
      </defs>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={MOUTH_IN} stroke={INK} strokeWidth={7} />
      <g clipPath={`url(#${clipId})`}>
        {m.tongue > 0.01 && (
          <ellipse
            cx={cx}
            cy={cy + ry * (0.5 - 0.35 * m.tongue)}
            rx={rx * 0.72}
            ry={ry * 0.6}
            fill={TONGUE}
            opacity={m.tongue}
          />
        )}
        {m.teeth > 0.01 && (
          <rect
            x={cx - rx * 0.82}
            y={cy - ry}
            width={rx * 1.64}
            height={Math.max(4, ry * 0.5)}
            rx={3}
            fill={TEETH}
            opacity={m.teeth}
          />
        )}
      </g>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={INK} strokeWidth={7} />
    </g>
  );
};

export const BrainMascot: React.FC<{
  mouth: MouthParams;
  idle?: boolean;
  /** Phase offset (s) so multiple mascots don't blink/bob in unison. */
  blinkSeed?: number;
}> = ({ mouth, idle = true, blinkSeed = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps + blinkSeed;

  // Idle bob + micro-tilt (transform-only, gentle).
  const bobY = idle ? Math.sin(t * 1.7) * 3 : 0;
  const tilt = idle ? Math.sin(t * 1.1 + 0.6) * 1.2 : 0;

  // Blink: a quick close roughly every 3.3s.
  const period = 3.3;
  const bt = ((t % period) + period) % period;
  const blinkDur = 0.13;
  let eyeOpen = 1;
  if (idle && bt < blinkDur) {
    const p = bt / blinkDur; // 0..1 across the blink
    eyeOpen = 1 - Math.sin(p * Math.PI) * 0.92; // dip to ~0.08 and back
  }

  return (
    <svg viewBox={`0 0 ${VB.w} ${VB.h}`} width="100%" height="100%" style={{ overflow: "visible" }}>
      <g transform={`translate(0 ${bobY}) rotate(${tilt} ${HEAD.cx} ${HEAD.cy})`}>
        {/* legs (behind body) — outlined capsule stubs; round caps read as feet */}
        {[-22, 22].map((dx) => {
          const d = `M ${HEAD.cx + dx} 186 L ${HEAD.cx + dx} 220`;
          return (
            <g key={dx}>
              <path d={d} fill="none" stroke={INK} strokeWidth={24} strokeLinecap="round" />
              <path d={d} fill="none" stroke={BODY} strokeWidth={14} strokeLinecap="round" />
            </g>
          );
        })}

        {/* arms (behind body) — outlined capsule stubs; the round cap reads as a
            little hand, and the inner half is covered by the body for a clean join */}
        {["M56 150 q -22 12 -32 36", "M184 150 q 22 12 32 36"].map((d, i) => (
          <g key={i}>
            <path d={d} fill="none" stroke={INK} strokeWidth={22} strokeLinecap="round" />
            <path d={d} fill="none" stroke={BODY} strokeWidth={12} strokeLinecap="round" />
          </g>
        ))}

        {/* body */}
        <path d={brainPath} fill={BODY} stroke={INK} strokeWidth={8} strokeLinejoin="round" />
        {/* subtle belly shade */}
        <ellipse cx={HEAD.cx} cy={HEAD.cy + 50} rx={54} ry={26} fill={BODY_DK} opacity={0.22} />

        {/* wrinkles */}
        {WRINKLES.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={INK} strokeWidth={3.4} strokeLinecap="round" />
        ))}

        {/* brows — gentle symmetric raised arcs (friendly/curious) */}
        <path d={`M ${HEAD.cx - EYE.dx - 18} 82 Q ${HEAD.cx - EYE.dx} 70 ${HEAD.cx - EYE.dx + 18} 82`} fill="none" stroke={INK} strokeWidth={5} strokeLinecap="round" />
        <path d={`M ${HEAD.cx + EYE.dx - 18} 82 Q ${HEAD.cx + EYE.dx} 70 ${HEAD.cx + EYE.dx + 18} 82`} fill="none" stroke={INK} strokeWidth={5} strokeLinecap="round" />

        {/* eyes (blink via scaleY about each eye centre) */}
        {[-EYE.dx, EYE.dx].map((dx) => {
          const ex = HEAD.cx + dx;
          return (
            <g key={dx} transform={`translate(${ex} ${EYE.cy}) scale(1 ${round2(eyeOpen)})`}>
              <ellipse cx={0} cy={0} rx={EYE.rx} ry={EYE.ry} fill={SCLERA} stroke={INK} strokeWidth={5} />
              <circle cx={0} cy={4} r={9.5} fill={PUPIL} />
              <circle cx={dx < 0 ? -5 : 5} cy={-4} r={3} fill={SCLERA} />
            </g>
          );
        })}

        {/* mouth */}
        <Mouth m={mouth} />
      </g>
    </svg>
  );
};
