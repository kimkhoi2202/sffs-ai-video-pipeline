import { AbsoluteFill, Img, staticFile } from "remotion";
import { COLORS, hardDropShadow } from "../theme/brand";
import { titleStyle, BrandPill } from "./bits";
import { HeroShapes } from "../components/HeroShapes";
import { PerspectiveGrid } from "../components/PerspectiveGrid";

/**
 * SELF-CONTAINED thumbnail set for the intro post. Three on-brand stills, each
 * hand-framed for its ratio: 9:16 (1080x1920), 1:1 (1080x1080), 16:9
 * (1920x1080). Eyebrow "REAL IQ TEST" + the "SMART FELLA OR FART SMELLA?" hero
 * lockup + the brain. Rendered via `remotion still` at a settled frame so the
 * floating shapes have entered.
 *
 * A/B-TEST PACK: every composition takes an optional `bg` prop (a brand hex,
 * passed at render time via `--props`, e.g. `{"bg":"#839aff"}`), so the same
 * layout can be rendered on many brand backgrounds without duplicating
 * compositions. For EACH background the whole foreground is recolored from a
 * per-bg SCHEME so nothing blends into the field: the two title lines, the
 * eyebrow/OR pills, and every floating shape are chosen to contrast the bg (and
 * no shape is ever left the same color as the bg). The brain mascot keeps its
 * baked-in black outline + light rim + hard offset shadow, so it reads on any
 * brand color. Falls back to the yellow scheme for an unknown bg.
 */

const LOGO = "images/sffs-logo.png";

/** HeroShapes' six shape kinds; used to recolor shapes per background. */
type ShapeKey = "circle" | "roundSquare" | "hexagon" | "pill" | "triangle" | "diamond";

type Scheme = {
  /** Top title line ("SMART FELLA"). */
  first: string;
  /** Bottom title line ("FART SMELLA?") — never the coral default on a coral bg. */
  second: string;
  /** Eyebrow + "OR" pill fill (never the paper default on the near-white cream bg). */
  pill: string;
  /** Per-kind HeroShapes recolors so no shape is left matching the bg. */
  shapes: Partial<Record<ShapeKey, string>>;
};

/**
 * Thumbnail-only accent hue. The brand palette (theme/brand.ts) provides only
 * FOUR strong saturated hues (blue/coral/yellow/green) plus light neutrals
 * (cream/paper) and pale mint — there is no fifth *saturated* brand color. When
 * a set needs five backgrounds that all read as obviously different, punchy
 * colors (no pale/near-white field), we add this one tasteful accent: a vivid
 * magenta-pink that fills the palette's empty hue gap and is clearly distinct
 * from coral. Kept local to the thumbnails, NOT promoted to a global brand token.
 */
const PINK = "#ff5fb0";

/**
 * Legibility scheme per background. Keyed by the brand hex. Defaults for the
 * floating shapes (see HeroShapes) are circle/triangle=blue, roundSquare=mint,
 * hexagon=green, pill=paper, diamond=coral; each entry below overrides only the
 * shapes that would otherwise match (or wash out against) that background.
 */
const SCHEMES: Record<string, Scheme> = {
  [COLORS.yellow]: {
    first: COLORS.blue,
    second: COLORS.coral,
    pill: COLORS.paper,
    shapes: {}, // no default shape is yellow
  },
  [COLORS.blue]: {
    first: COLORS.yellow,
    second: COLORS.coral,
    pill: COLORS.paper,
    shapes: { circle: COLORS.coral, triangle: COLORS.yellow }, // both were blue
  },
  [COLORS.coral]: {
    first: COLORS.blue,
    second: COLORS.yellow, // NOT coral-on-coral
    pill: COLORS.paper,
    shapes: { diamond: COLORS.blue }, // was coral
  },
  [COLORS.green]: {
    first: COLORS.blue,
    second: COLORS.coral,
    pill: COLORS.paper,
    shapes: { hexagon: COLORS.yellow, roundSquare: COLORS.coral }, // hexagon was green; mint washes on green
  },
  [COLORS.cream]: {
    first: COLORS.blue,
    second: COLORS.coral,
    pill: COLORS.blue, // paper would vanish on near-white cream
    shapes: { pill: COLORS.coral, roundSquare: COLORS.blue }, // paper/mint both wash on cream
  },
  [PINK]: {
    first: COLORS.blue,
    second: COLORS.yellow, // coral would clash warm-on-pink; yellow pops
    pill: COLORS.paper, // white reads crisply on the saturated pink
    shapes: { diamond: COLORS.yellow }, // coral diamond would clash warm-on-pink
  },
};

const schemeFor = (bg: string): Scheme => SCHEMES[bg] ?? SCHEMES[COLORS.yellow];

/** Full brand backdrop with explicit per-bg shape recolors: solid field +
 *  drifting perspective grid + floating hero shapes, content above (zIndex 1).
 *  Mirrors bits' Stage but takes the shape overrides directly so every bg
 *  (incl. cream) gets contrast-safe shapes. */
const ThumbStage: React.FC<{
  bg: string;
  shapes: Partial<Record<ShapeKey, string>>;
  shapePos?: Record<string, { fx?: number; fy?: number }>;
  children: React.ReactNode;
}> = ({ bg, shapes, shapePos, children }) => (
  <AbsoluteFill style={{ backgroundColor: bg }}>
    <PerspectiveGrid base={bg} />
    <HeroShapes overrides={shapes} posOverrides={shapePos} />
    <AbsoluteFill style={{ zIndex: 1 }}>{children}</AbsoluteFill>
  </AbsoluteFill>
);

const Brain: React.FC<{ w: number; rot: number; left: number; top: number }> = ({ w, rot, left, top }) => (
  <div style={{ position: "absolute", left, top, transform: "translate(-50%, -50%)" }}>
    <Img src={staticFile(LOGO)} style={{ width: w, height: "auto", display: "block", transform: `rotate(${rot}deg)`, filter: hardDropShadow(14) }} />
  </div>
);

const Center: React.FC<{ cx: number; cy: number; children: React.ReactNode }> = ({ cx, cy, children }) => (
  <div style={{ position: "absolute", left: cx, top: cy, transform: "translate(-50%, -50%)", width: "max-content", display: "flex", alignItems: "center", justifyContent: "center" }}>
    {children}
  </div>
);

/** Brand hero title: "SMART FELLA" / "OR" badge / "FART SMELLA?" stacked and
 *  centered at (cx, cy), with the signature ink stroke + hard offset shadow.
 *  `first`/`second` color the two lines and `pill` the "OR" badge, all chosen
 *  per background so no element blends into that background. */
const BrandTitle: React.FC<{ cx: number; cy: number; size: number; orSize: number; rowGap: number; first: string; second: string; pill: string }> = ({
  cx,
  cy,
  size,
  orSize,
  rowGap,
  first,
  second,
  pill,
}) => (
  <div
    style={{
      position: "absolute",
      left: cx,
      top: cy,
      transform: "translate(-50%, -50%)",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: rowGap,
      zIndex: 3, // paint the big title ABOVE the floating shapes where they overlap
    }}
  >
    <div style={titleStyle(size, first)}>SMART FELLA</div>
    <BrandPill fill={pill} size={orSize} pad={`${Math.round(orSize * 0.16)}px ${Math.round(orSize * 0.55)}px`} shadow={7}>
      OR
    </BrandPill>
    <div style={titleStyle(size, second)}>FART SMELLA?</div>
  </div>
);

// ---- 9:16 (1080x1920) ----------------------------------------------------
export const ThumbV: React.FC<{ bg?: string }> = ({ bg = COLORS.yellow }) => {
  const s = schemeFor(bg);
  return (
    <ThumbStage bg={bg} shapes={s.shapes} shapePos={{ diamond: { fy: 0.585 }, hexagon: { fy: 0.595 } }}>
      <Center cx={540} cy={300}>
        <BrandPill fill={s.pill} size={44} pad="16px 40px" shadow={9} maxWidth={900}>
          REAL IQ TEST · GRADES K-12
        </BrandPill>
      </Center>
      <BrandTitle cx={540} cy={760} size={172} orSize={70} rowGap={22} first={s.first} second={s.second} pill={s.pill} />
      <Brain w={540} rot={-6} left={540} top={1470} />
    </ThumbStage>
  );
};

// ---- 1:1 (1080x1080) -----------------------------------------------------
export const ThumbSq: React.FC<{ bg?: string }> = ({ bg = COLORS.blue }) => {
  const s = schemeFor(bg);
  return (
    <ThumbStage bg={bg} shapes={s.shapes}>
      <BrandTitle cx={540} cy={402} size={158} orSize={62} rowGap={16} first={s.first} second={s.second} pill={s.pill} />
      <Brain w={372} rot={-6} left={540} top={838} />
    </ThumbStage>
  );
};

// ---- 16:9 (1920x1080) ----------------------------------------------------
export const ThumbWide: React.FC<{ bg?: string }> = ({ bg = COLORS.green }) => {
  const s = schemeFor(bg);
  return (
    <ThumbStage bg={bg} shapes={s.shapes}>
      <BrandTitle cx={620} cy={452} size={156} orSize={62} rowGap={16} first={s.first} second={s.second} pill={s.pill} />
      <Center cx={648} cy={824}>
        <BrandPill fill={s.pill} size={40} pad="14px 34px" shadow={9} maxWidth={860}>
          A REAL IQ TEST · ACTUALLY FUN
        </BrandPill>
      </Center>
      <Brain w={560} rot={8} left={1470} top={520} />
    </ThumbStage>
  );
};
