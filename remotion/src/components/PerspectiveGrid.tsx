import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "../theme/brand";

/**
 * Synthwave "receding floor" grid backdrop — a 1:1 port of the website hero's
 * perspective grid (components/quiz/smart-fart-hero.tsx + app/globals.css
 * .fella-floor). A 48px black grid painted on a rotateX(70deg) plane inside a
 * 560px perspective wrapper foreshortens the cells into trapezoids receding to a
 * horizon (perspective-origin 50% 34%), faint (opacity 0.09), drifting toward
 * the viewer at 336px (7 cells) / 30s = 11.2 px/s, with a horizon fade into the
 * base color. Behind the shapes + content; pointer-events none.
 */
const CELL = 48;
const TRAVEL = 336; // 7 cells -> seamless loop
const DURATION_S = 30;
const SPEED = TRAVEL / DURATION_S; // 11.2 px/s (matches the hero drift)

export const PerspectiveGrid: React.FC<{ base?: string; opacity?: number }> = ({
  base = COLORS.yellow,
  opacity = 0.09,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dy = ((frame / fps) * SPEED) % CELL; // drift toward viewer (pattern repeats every cell)

  return (
    <AbsoluteFill style={{ overflow: "hidden", pointerEvents: "none", perspective: 560, perspectiveOrigin: "50% 34%" }}>
      {/* tilted floor plane */}
      <div
        style={{
          position: "absolute",
          left: "-50%",
          right: "-50%",
          top: "34%",
          bottom: "-45%",
          overflow: "hidden",
          transform: "rotateX(70deg)",
          transformOrigin: "50% 0%",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: "-120%",
            opacity,
            backgroundImage:
              "linear-gradient(#000 1px, transparent 1px), linear-gradient(90deg, #000 1px, transparent 1px)",
            backgroundSize: `${CELL}px ${CELL}px`,
            transform: `translate3d(0, ${dy}px, 0)`,
            willChange: "transform",
          }}
        />
      </div>

      {/* fade the far convergence into the base color for a clean horizon */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: "56%",
          backgroundImage: `linear-gradient(to bottom, ${base} 0%, ${base} 24%, ${base}00 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
