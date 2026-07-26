import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardShadow } from "../theme/brand";

/**
 * Hook — the motion opening for the `opening: "motion-hook"` A/B arm.
 *
 * THE PROBLEM IT EXISTS TO SOLVE
 * The loop renders cold-open shorts, so frame one is a STATIC question plate: 8 to 12
 * words of prompt plus four option tiles. That is a reading task placed exactly where
 * the audience leaves. Measured on the 33 Instagram reels in this campaign, the median
 * reel is already down 78.3% of viewers by second three and even the best loses 52.5%.
 *
 * THE DESIGN RULE
 * Nothing in this scene may require reading. There is no copy in it at all — not a
 * word, not a letter. The only glyph is "?", which is understood pre-literately. Every
 * beat is motion, colour and shape, and the whole thing resolves INTO the plate so the
 * cut to the question is continuous rather than a jump.
 *
 * THE BEATS (66 frames, 2.2s at 30fps)
 *   0      FRAME ONE IS ALREADY FULL-BLEED COLOUR. The four brand panels are on screen
 *          at frame zero, overshot and tilted, and snap square over the next few
 *          frames. An earlier cut slid them in from off-screen and frame one came out
 *          BLACK, which is a worse opening than the static plate it replaces — an
 *          empty first frame is the one thing this scene cannot afford.
 *   2-24   an oversized "?" slams in over the seam with an overshoot, then breathes
 *   18-46  three shapes (circle, triangle, square — the quiz's visual vocabulary) pop
 *          in around it on the beat, so the viewer learns "visual puzzle" without words
 *   46-66  a hard-edged wipe of the FIRST PLATE'S OWN background colour expands from
 *          the centre and takes the frame, so the question plate appears to be
 *          underneath the hook rather than cutting to it. A crossfade was tried and
 *          read as muddy grey where yellow blended over blue and coral; brand rule is
 *          solid fills and hard edges, so the transition is a wipe.
 *
 * It is deliberately QUESTION-AGNOSTIC: it renders identically for any shape question,
 * so the arm adds no per-question plumbing that could fail on one kind and not another.
 *
 * Brand: solid fills, thick black strokes, the signature hard offset shadow, zero blur
 * and zero gradients.
 */
export const HOOK_SECONDS = 2.2;

/** Quadrant panels. They are on screen from frame zero and only SNAP into square. */
const PANELS = [
  { color: COLORS.blue, qx: 0, qy: 0, tilt: -3 },
  { color: COLORS.coral, qx: 1, qy: 0, tilt: 3 },
  { color: COLORS.yellow, qx: 0, qy: 1, tilt: 2.5 },
  { color: COLORS.mint, qx: 1, qy: 1, tilt: -2.5 },
] as const;

type ShapeKind = "circle" | "triangle" | "square";
/** Placed clear of the centre "?" so nothing collides at any point in the beat. */
const SHAPES: Array<{ kind: ShapeKind; color: string; x: number; y: number; at: number; rot: number }> = [
  { kind: "circle", color: COLORS.mint, x: -330, y: -520, at: 18, rot: -12 },
  { kind: "triangle", color: COLORS.yellow, x: 330, y: -430, at: 26, rot: 10 },
  { kind: "square", color: COLORS.coral, x: 300, y: 520, at: 34, rot: -8 },
  { kind: "circle", color: COLORS.blue, x: -320, y: 470, at: 40, rot: 6 },
];

const Shape: React.FC<{ kind: ShapeKind; color: string; size: number }> = ({ kind, color, size }) => {
  const stroke = 14;
  if (kind === "circle") {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: color,
          border: `${stroke}px solid ${COLORS.ink}`,
          boxShadow: hardShadow(18),
        }}
      />
    );
  }
  if (kind === "square") {
    return (
      <div
        style={{
          width: size,
          height: size,
          background: color,
          border: `${stroke}px solid ${COLORS.ink}`,
          boxShadow: hardShadow(18),
        }}
      />
    );
  }
  // Triangle: an SVG so it can carry a real stroke and a hard offset shadow copy.
  const p = `${size / 2},${stroke} ${size - stroke},${size - stroke} ${stroke},${size - stroke}`;
  return (
    <svg width={size + 18} height={size + 18} style={{ overflow: "visible" }}>
      <polygon points={p} fill={COLORS.ink} transform="translate(18,18)" />
      <polygon points={p} fill={color} stroke={COLORS.ink} strokeWidth={stroke} strokeLinejoin="round" />
    </svg>
  );
};

export const Hook: React.FC<{ bg?: string }> = ({ bg = COLORS.blue }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const total = Math.round(HOOK_SECONDS * fps);

  // Beat 4: a hard-edged wipe of the plate colour takes the frame.
  const out = interpolate(frame, [total - 20, total - 5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const clusterScale = interpolate(out, [0, 1], [1, 0.5]);
  const clusterOpacity = out > 0.35 ? 0 : 1; // hard cut, not a fade — no muddy blend

  // Beat 2: the "?" slams in with an overshoot, then breathes.
  const qIn = spring({ frame: frame - 2, fps, config: { damping: 11, mass: 0.7, stiffness: 150 } });
  const breathe = 1 + 0.035 * Math.sin((frame - 2) / 5);
  const qScale = interpolate(qIn, [0, 1], [0, 1]) * (frame > 22 ? breathe : 1);
  const qRot = interpolate(qIn, [0, 1], [-24, 0]);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden" }}>
      {/* Beat 1: the panels are ALREADY on screen at frame zero, overshot and tilted,
          and snap square. Full-bleed brand colour on frame one, moving immediately. */}
      {PANELS.map((p, i) => {
        const t = spring({ frame: frame - i, fps, config: { damping: 13, mass: 0.5, stiffness: 200 } });
        const scale = interpolate(t, [0, 1], [1.14, 1]);
        const tilt = interpolate(t, [0, 1], [p.tilt, 0]);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: p.qx * (width / 2),
              top: p.qy * (height / 2),
              width: width / 2,
              height: height / 2,
              background: p.color,
              transform: `scale(${scale}) rotate(${tilt}deg)`,
              transformOrigin: `${p.qx ? "right" : "left"} ${p.qy ? "bottom" : "top"}`,
            }}
          />
        );
      })}

      {/* Beat 4: the question plate's own colour wipes in from the centre with a hard
          edge, so the plate reads as sliding out from under the hook. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          width: width * 1.6,
          height: height * 1.6,
          marginLeft: -width * 0.8,
          marginTop: -height * 0.8,
          background: bg,
          transform: `scale(${out})`,
        }}
      />

      {/* Beats 2-3: the cluster. */}
      <AbsoluteFill
        style={{
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${clusterScale})`,
          opacity: clusterOpacity,
        }}
      >
        <div style={{ position: "relative", width: 0, height: 0 }}>
          {SHAPES.map((s, i) => {
            const t = spring({ frame: frame - s.at, fps, config: { damping: 12, mass: 0.6, stiffness: 170 } });
            const size = 230;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: s.x - size / 2,
                  top: s.y - size / 2,
                  transform: `scale(${t}) rotate(${interpolate(t, [0, 1], [s.rot * 4, s.rot])}deg)`,
                }}
              >
                <Shape kind={s.kind} color={s.color} size={size} />
              </div>
            );
          })}

          <div
            style={{
              position: "absolute",
              left: -400,
              top: -430,
              width: 800,
              height: 860,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: `scale(${qScale}) rotate(${qRot}deg)`,
            }}
          >
            <span
              style={{
                fontFamily: "Bungee, system-ui, sans-serif",
                fontSize: 760,
                lineHeight: 1,
                color: COLORS.paper,
                WebkitTextStroke: `22px ${COLORS.ink}`,
                paintOrder: "stroke fill",
                textShadow: `26px 26px 0 ${COLORS.ink}`,
              }}
            >
              ?
            </span>
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
