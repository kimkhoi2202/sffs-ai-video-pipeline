/**
 * Brand foundation — mirrors the live site's tokens (app/globals.css @theme) and
 * the approved Python master (video/tools/render_demo_quiz.py). Colors, the
 * 1920x1080 plate layout, and the signature HARD offset shadow live here so the
 * Remotion video reuses the site's EXACT visual language.
 */

// --- Brand palette (sRGB, from app/globals.css + render_demo_quiz.py) --------
export const COLORS = {
  ink: "#000000", // --color-ink
  paper: "#ffffff", // --color-paper
  blue: "#839aff", // --color-blue
  mint: "#c6fcd0", // --color-mint
  coral: "#fd7962", // --color-coral
  yellow: "#fce552", // --color-yellow
  cream: "#f6f4ee", // --color-cream
  green: "#63c088", // --color-green (logo brain green; CTA only)
  /** Analogy-separator gray (Python (120,120,120)). */
  sepGray: "#787878",
  /** Faint "ghost" corner pips (Python (176,176,176)); unused by the Q3 slice. */
  ghostGray: "#b0b0b0",
} as const;

/** A/B/C/D letter-badge fills (render_demo_quiz.py BADGE_COLORS). */
export const BADGE_COLORS: Record<string, string> = {
  A: COLORS.blue,
  B: COLORS.mint,
  C: COLORS.coral,
  D: COLORS.yellow,
};

/**
 * Per-plate color scheme. Every question plate has four color "slots" — the
 * background, the "QUESTION X OF 15" count pill, the topic/category pill, and
 * the countdown clock — and all FOUR must be DIFFERENT brand colors (no pill/
 * clock may match the background). We rotate a 5-color palette by the question
 * index and take four CONSECUTIVE entries, which is always four mutually
 * distinct colors and shifts every plate, so consecutive plates never look the
 * same. Palette order is tuned so the two side-by-side header pills (consecutive
 * entries) always contrast (mint and green are never adjacent).
 */
export const SLOT_PALETTE = [COLORS.blue, COLORS.mint, COLORS.coral, COLORS.green, COLORS.yellow];

export type SlotColors = { bg: string; countFill: string; topicFill: string; clock: string };

export const slotColors = (idx: number): SlotColors => {
  const P = SLOT_PALETTE;
  const n = P.length;
  const i = ((idx - 1) % n + n) % n;
  return {
    bg: P[i % n],
    countFill: P[(i + 1) % n],
    topicFill: P[(i + 2) % n],
    clock: P[(i + 3) % n],
  };
};

/**
 * Analogy-separator fill for a given plate background. The `:` dots and `=` bars
 * get a BRIGHT brand fill + a thick black outline (neo-brutalist, like the tiles
 * and pills). The color is keyed to the bg so it always contrasts and never
 * blends into the plate; we also avoid BLUE, which is the filled-shape ink
 * (SHADE_FILL), so the separators stay visually distinct from the analogy shapes.
 */
export const separatorColor = (bg: string): string => {
  switch (bg) {
    case COLORS.blue:
      return COLORS.yellow;
    case COLORS.mint:
      return COLORS.coral;
    case COLORS.coral:
      return COLORS.yellow;
    case COLORS.green:
      return COLORS.yellow;
    case COLORS.yellow:
      return COLORS.coral;
    default:
      return COLORS.yellow;
  }
};

// --- Canvas + layout (logical 1920x1080, ported from the Python pipeline) ----
export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const;

/** Outer action-safe margin. */
export const M = 110;

/**
 * Countdown chip (top-right). A neat timer chip sharing the pill-row center
 * (y=100) with an even right margin (= M), sized to sit in scale with the
 * QUESTION/tier pill row rather than as a giant block. Its bottom (+shadow)
 * clears the prompt/question box below with room to spare.
 */
export const CD = { x0: 1690, y0: 46, x1: 1810, y1: 154, w: 120, h: 108, cx: 1750, cy: 100 } as const;

/** Depleting timer bar (bottom). */
export const BAR = { x: M, y: 958, w: VIDEO.width - 2 * M, h: 42, pad: 8 } as const;

/**
 * Burned-in caption band for the SMART (spoken-only) subset. A compact strip low
 * on the frame, above the progress bar (958), used only on the few plates that
 * carry a caption. Sits just below the option cards on every plate type (incl.
 * the taller number-series plates) so it never overlaps content or the bar.
 */
export const CAPTION = { top: 908, height: 44 } as const;

/** 2x2 A/B/C/D text-option grid (render_demo_quiz.py OPT_BOXES). */
export const TILE_W = (VIDEO.width - 2 * M - 48) / 2; // 826
export const TEXT_OPT_BOXES: Record<string, { x: number; y: number; w: number; h: number }> = {
  A: { x: M, y: 490, w: TILE_W, h: 150 },
  B: { x: M + TILE_W + 48, y: 490, w: TILE_W, h: 150 },
  C: { x: M, y: 676, w: TILE_W, h: 150 },
  D: { x: M + TILE_W + 48, y: 676, w: TILE_W, h: 150 },
};

/**
 * The SIGNATURE hard offset shadow: a solid black copy offset down-right with
 * ZERO blur (globals.css --shadow-hard family; Python draws it as an offset
 * filled shape). Returns a CSS box-shadow string, or `undefined` when flat.
 */
export const hardShadow = (offset: number, color: string = COLORS.ink): string | undefined =>
  offset > 0 ? `${offset}px ${offset}px 0 0 ${color}` : undefined;

/** Same hard offset, expressed as a drop-shadow() filter (for PNGs / SVGs). */
export const hardDropShadow = (offset: number, color: string = COLORS.ink): string =>
  `drop-shadow(${offset}px ${offset}px 0 ${color})`;
