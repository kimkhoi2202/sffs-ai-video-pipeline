import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, hardShadow } from "../theme/brand";

/**
 * Hook — the motion opening for the `opening: "motion-hook"` A/B arm.
 *
 * THE PROBLEM IT EXISTS TO SOLVE
 * The loop renders cold-open shorts, so frame one of the control is a STATIC question
 * plate: 8 to 12 words of prompt plus four option tiles. That is a reading task placed
 * exactly where the audience leaves. Measured on this campaign's Instagram reels, the
 * median reel is already down 78.3% of viewers by second three and even the best loses
 * 52.5%.
 *
 * TWO DESIGN RULES, AND THEY PULL AGAINST EACH OTHER
 *   1. Frame zero must be CLEAN. Not black, and not distorted.
 *   2. Frame zero must not be a STILL. If this arm opens square and then holds for a
 *      beat, it quietly becomes a second control arm and the experiment measures
 *      nothing.
 *
 * Both rules were learned the hard way, in opposite directions. The first cut slid the
 * panels in from off-screen and frame one came out BLACK — an empty first frame is
 * worse than the plate it replaces. The fix overshot and tilted the panels at rest, and
 * that read as a RENDERING GLITCH: a viewer who thinks the video is broken swipes for a
 * different reason than one who is bored, which is a worse failure than boredom because
 * it looks like our fault.
 *
 * So the panels are now PERFECTLY SQUARE AND STATIONARY for the whole scene — no skew,
 * no overshoot, no rotation, ever. The motion comes from things that move ON the grid
 * rather than from deforming it.
 *
 * THE BEATS (66 frames, 2.2s at 30fps)
 *   0      a clean, even 2x2 grid of four brand colours with hard black seams. Square.
 *   0-15   the four colours HARD-CUT around the grid on a 3-frame beat. Frame one is
 *          already moving, the movement is unmistakable, and nothing is distorted —
 *          flat colour swapping is also exactly the brand's visual language.
 *   0-22   an oversized "?" punches in over the seam from frame ZERO, pure scale with an
 *          overshoot and
 *          NO rotation, so it lands square too.
 *   20-46  four shapes pop into the quadrants on the beat, teaching "visual puzzle"
 *          without a word of copy.
 *   46-66  a hard-edged wipe of the FIRST PLATE'S OWN background colour takes the frame,
 *          so the question appears from underneath rather than cutting in. A crossfade
 *          was tried and read as muddy grey where yellow blended over blue and coral.
 *
 * There is no dead beat: the "?" is growing by frame 1, colour swaps carry 0-15, shapes carry
 * 20-46, and the wipe carries 46-66.
 *
 * Question-agnostic on purpose, so it renders identically for every shape kind and adds
 * no per-question plumbing that could fail on one and not another.
 */
export const HOOK_SECONDS = 2.2;

/** Quadrant positions. Fixed and axis-aligned — these never move, tilt or scale. */
const QUADRANTS = [
  { qx: 0, qy: 0 },
  { qx: 1, qy: 0 },
  { qx: 0, qy: 1 },
  { qx: 1, qy: 1 },
] as const;

/** The colour cycle. Each hard cut rotates the palette one step around the grid. */
const PALETTE = [COLORS.blue, COLORS.coral, COLORS.yellow, COLORS.mint] as const;
/** Frames between hard cuts, and how many cuts happen before the grid settles. */
const CUT_EVERY = 3;
const CUT_COUNT = 5;

type ShapeKind = "circle" | "triangle" | "square";
/** One shape per quadrant, clear of the centre "?" at every point in the beat. */
const SHAPES: Array<{ kind: ShapeKind; color: string; x: number; y: number; at: number; rot: number }> = [
  { kind: "circle", color: COLORS.mint, x: -330, y: -520, at: 20, rot: -10 },
  { kind: "triangle", color: COLORS.yellow, x: 330, y: -430, at: 27, rot: 8 },
  { kind: "square", color: COLORS.coral, x: 300, y: 520, at: 34, rot: -7 },
  { kind: "circle", color: COLORS.blue, x: -320, y: 470, at: 41, rot: 5 },
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

  // Beat 1: which palette rotation is showing right now. Hard cuts, never a fade, and
  // it stops after CUT_COUNT so the grid is settled well before the wipe.
  const step = Math.min(Math.floor(frame / CUT_EVERY), CUT_COUNT);

  // Beat 4: the plate colour wipes in from the centre with a hard edge.
  const out = interpolate(frame, [total - 20, total - 5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const clusterScale = interpolate(out, [0, 1], [1, 0.5]);
  const clusterVisible = out <= 0.35; // hard cut, not a fade — no muddy blend

  // Beat 2: the "?" punches in. Scale only; it must land square like everything else.
  // Starts at frame ZERO, not later: frame 0 is the clean square grid with the "?" at
  // scale 0, and frame 1 already shows it growing. That is what keeps this an opening
  // that MOVES rather than a square still that sits for a beat — which would quietly
  // turn this arm into a second control arm and measure nothing.
  const qIn = spring({ frame, fps, config: { damping: 11, mass: 0.7, stiffness: 150 } });
  const breathe = 1 + 0.035 * Math.sin(frame / 5);
  const qScale = interpolate(qIn, [0, 1], [0, 1]) * (frame > 22 ? breathe : 1);

  return (
    <AbsoluteFill style={{ backgroundColor: COLORS.ink, overflow: "hidden" }}>
      {/* Beat 1: a clean, even, PERFECTLY SQUARE 2x2 grid. These panels never move —
          the motion is the colour rotating around them on a hard 4-frame beat. */}
      {QUADRANTS.map((q, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: q.qx * (width / 2),
            top: q.qy * (height / 2),
            width: width / 2,
            height: height / 2,
            background: PALETTE[(i + step) % PALETTE.length],
            // The hard black seam between quadrants, drawn inward so the grid stays
            // exactly half-and-half and the outer edge never shows a border.
            boxSizing: "border-box",
            borderRight: q.qx === 0 ? `6px solid ${COLORS.ink}` : undefined,
            borderBottom: q.qy === 0 ? `6px solid ${COLORS.ink}` : undefined,
          }}
        />
      ))}

      {/* Beat 4: the question plate's own colour wipes over the grid. */}
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
      {clusterVisible ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", transform: `scale(${clusterScale})` }}>
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
                    transform: `scale(${t}) rotate(${s.rot}deg)`,
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
                transform: `scale(${qScale})`,
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
      ) : null}
    </AbsoluteFill>
  );
};
