/**
 * Viseme model — the bridge between Rhubarb's mouth-shape letters and the
 * brain-mascot's animatable SVG mouth.
 *
 * Rhubarb emits the Preston-Blair-derived shape set A–H plus X (rest). We map
 * each letter to a small set of continuous mouth parameters (openness, width,
 * roundness, teeth, tongue, smile) so the SVG mouth can both POP crisply per
 * cue AND cross-fade briefly at each boundary for an Emil-calm, non-jittery
 * read. Everything here is pure + stateless (derived only from time), so it is
 * deterministic across Remotion's independent per-frame renders.
 *
 * Rhubarb shape -> phoneme intent -> our mouth:
 *   A  closed, lips pressed          — M B P
 *   B  slightly open, teeth          — many consonants + "EE"
 *   C  medium open                   — "EH" (men), "AE" (bat)
 *   D  wide open                     — "AA" (father)
 *   E  rounded, medium               — "AO" (off), "ER"
 *   F  puckered small O              — "UW" (you), "OW", "W"
 *   G  upper teeth on lower lip      — "F" "V"
 *   H  tongue raised (L)            — "L"
 *   X  rest / idle                   — silence (gentle closed smile)
 */

export type RhubarbShape = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "X";

export type MouthCue = { start: number; end: number; value: RhubarbShape };

export type RhubarbJson = {
  metadata?: { soundFile?: string; duration?: number };
  mouthCues: MouthCue[];
};

/**
 * Continuous mouth parameters (all 0..1). The SVG mouth reads these directly.
 *  - open:   vertical aperture (0 = sealed line, 1 = wide)
 *  - width:  horizontal spread of the mouth
 *  - round:  0 = letterbox/oval, 1 = tight circle (O/OO purse)
 *  - teeth:  visibility of the upper teeth strip
 *  - tongue: visibility of the tongue (L, and floor of a wide AH)
 *  - smile:  upward curve of the mouth line/corners (life at rest)
 */
export type MouthParams = {
  open: number;
  width: number;
  round: number;
  teeth: number;
  tongue: number;
  smile: number;
};

export const SHAPE_PARAMS: Record<RhubarbShape, MouthParams> = {
  A: { open: 0.0, width: 0.68, round: 0.0, teeth: 0.0, tongue: 0.0, smile: 0.2 },
  B: { open: 0.2, width: 0.86, round: 0.0, teeth: 0.85, tongue: 0.0, smile: 0.06 },
  C: { open: 0.52, width: 0.82, round: 0.15, teeth: 0.25, tongue: 0.0, smile: 0.05 },
  D: { open: 0.95, width: 0.74, round: 0.1, teeth: 0.1, tongue: 0.55, smile: 0.0 },
  E: { open: 0.5, width: 0.56, round: 0.55, teeth: 0.0, tongue: 0.0, smile: 0.0 },
  F: { open: 0.34, width: 0.4, round: 1.0, teeth: 0.0, tongue: 0.0, smile: 0.0 },
  G: { open: 0.16, width: 0.72, round: 0.0, teeth: 1.0, tongue: 0.0, smile: 0.0 },
  H: { open: 0.5, width: 0.62, round: 0.15, teeth: 0.15, tongue: 1.0, smile: 0.0 },
  X: { open: 0.02, width: 0.52, round: 0.0, teeth: 0.0, tongue: 0.0, smile: 0.62 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};

const blendParams = (a: MouthParams, b: MouthParams, t: number): MouthParams => ({
  open: lerp(a.open, b.open, t),
  width: lerp(a.width, b.width, t),
  round: lerp(a.round, b.round, t),
  teeth: lerp(a.teeth, b.teeth, t),
  tongue: lerp(a.tongue, b.tongue, t),
  smile: lerp(a.smile, b.smile, t),
});

/** Index of the cue active at time `t` (seconds). Falls back to first/last. */
export const cueIndexAtTime = (cues: MouthCue[], t: number): number => {
  if (cues.length === 0) return -1;
  // linear scan is fine (tens of cues); keeps it dependency-free + obvious.
  for (let i = 0; i < cues.length; i++) {
    if (t < cues[i].end) return i;
  }
  return cues.length - 1;
};

export const shapeAtTime = (cues: MouthCue[], t: number): RhubarbShape => {
  const i = cueIndexAtTime(cues, t);
  return i < 0 ? "X" : cues[i].value;
};

/**
 * Blended mouth parameters at time `t`. Within `blendSec` of a cue's start we
 * cross-fade FROM the previous cue's shape INTO the current one (eased), so
 * transitions are soft rather than snapping — a subtle, premium touch that
 * still tracks the audio tightly.
 */
export const mouthParamsAtTime = (cues: MouthCue[], t: number, blendSec = 0.05): MouthParams => {
  const i = cueIndexAtTime(cues, t);
  if (i < 0) return SHAPE_PARAMS.X;
  const cur = SHAPE_PARAMS[cues[i].value];
  const start = cues[i].start;
  if (i === 0 || t - start >= blendSec) return cur;
  const prev = SHAPE_PARAMS[cues[i - 1].value];
  const t01 = smoothstep((t - start) / blendSec);
  return blendParams(prev, cur, t01);
};
