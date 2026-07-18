/**
 * Slice timeline — segment durations, audio placement, and the music-ducking
 * envelope, all derived from the EXISTING narration durations (ffprobe of
 * video/voice/narration/*.mp3) and the Python pacing constants (LEAD/TRAIL,
 * countdown + "time's up" tail). Keeping this math in one place means the
 * segment boundaries, VO windows, and ducking all stay in lockstep.
 */
export const FPS = 30;
export const LEAD = 0.35; // silence before VO on a plate (Python LEAD)
export const TRAIL = 0.8; // silence after VO on a plate (Python TRAIL)

/** Existing ElevenLabs narration durations (seconds), from ffprobe. */
export const DUR = { intro: 6.32, q3: 22.4, r3: 13.36, timesup: 2.24 };
export const Q3_COUNTDOWN = 6;

export const frames = (s: number): number => Math.round(s * FPS);

export const SEG = {
  intro: frames(LEAD + DUR.intro + TRAIL),
  q3read: frames(LEAD + DUR.q3 + TRAIL),
  // countdown video (count + 1s hold on 0), extended so "time's up" rings out
  countdown: Math.max(frames(Q3_COUNTDOWN + 1), frames(Q3_COUNTDOWN + DUR.timesup + 0.3)),
  reveal: frames(LEAD + DUR.r3 + TRAIL),
};

export const START = {
  intro: 0,
  q3read: SEG.intro,
  countdown: SEG.intro + SEG.q3read,
  reveal: SEG.intro + SEG.q3read + SEG.countdown,
};

export const TOTAL = SEG.intro + SEG.q3read + SEG.countdown + SEG.reveal;
export const LEAD_FRAMES = frames(LEAD);

/** VO active windows [start, end] in GLOBAL frames — used to duck the music. */
export const VO_WINDOWS: [number, number][] = [
  [START.intro + LEAD_FRAMES, START.intro + LEAD_FRAMES + frames(DUR.intro)],
  [START.q3read + LEAD_FRAMES, START.q3read + LEAD_FRAMES + frames(DUR.q3)],
  [START.countdown + frames(Q3_COUNTDOWN), START.countdown + frames(Q3_COUNTDOWN) + frames(DUR.timesup)],
  [START.reveal + LEAD_FRAMES, START.reveal + LEAD_FRAMES + frames(DUR.r3)],
];

// --- Music ducking (Remotion-native approximation of the Python sidechain) ---
// Base level in the gaps; ducked ~12 dB under during VO; short attack/release.
const BASE = 0.55; // ~ -5 dB
const DUCKED = 0.15; // ~ -16 dB (≈ 11 dB under the gaps)
const RAMP = 8; // frames (~0.27s) attack/release

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** 0 in the gaps -> 1 fully under VO, with ramped edges. */
export const duckGate = (frame: number): number => {
  let g = 0;
  for (const [s, e] of VO_WINDOWS) {
    const rise = clamp01((frame - s) / RAMP);
    const fall = clamp01((e + RAMP - frame) / RAMP);
    g = Math.max(g, Math.min(rise, fall));
  }
  return g;
};

export const musicLevel = (frame: number): number => BASE + (DUCKED - BASE) * duckGate(frame);

// Fanfare -> Prize Wheel Parade crossfade around 12-14s.
const XF_A = frames(12);
const XF_B = frames(14);
export const fanfareBed = (frame: number): number => 1 - clamp01((frame - XF_A) / (XF_B - XF_A));
export const paradeBed = (frame: number): number => clamp01((frame - XF_A) / (XF_B - XF_A));
