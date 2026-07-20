/**
 * SELF-CONTAINED intro timing. NOT imported by Root.tsx / the running render.
 * Durations are the ffprobe-measured lengths of the cloned-voice VO mp3s under
 * public/sffs-intro/ (generated via voice/voice_pipeline.py, voice_id
 * lZcmpVLaoXF4v0uz4l6Q, eleven_v3). Each section holds for its VO + a short tail.
 * The 3 demo plates use short TEASER VO that does NOT read the on-screen question;
 * each plate is a snappy montage beat that holds only its teaser + DEMO_TAIL, then
 * hard-cuts to the next. The CTA ends promptly after "Follow for more" (CTA_TAIL).
 */
export const FPS = 30;

export type SectionId = "hook" | "what" | "demo1" | "demo2" | "demo3" | "mission" | "cta";

export const SECTIONS: { id: SectionId; vo: number }[] = [
  { id: "hook", vo: 4.30 },
  { id: "what", vo: 6.84 },
  { id: "demo1", vo: 1.65 },
  { id: "demo2", vo: 2.21 },
  { id: "demo3", vo: 2.79 },
  { id: "mission", vo: 3.95 },
  { id: "cta", vo: 3.86 },
];

/** Frames before the VO starts inside a section (lets the entrance land first).
 *  VO clips are atempo 1.12 (faster/energetic); tails tightened for a brisk pace. */
export const LEAD = 3;
const TAIL = 3; // breathing frames after VO on a normal section (tightened)
const CTA_TAIL = 12; // end promptly after "Follow for more" (no dead air)
const DEMO_TAIL = 6; // short hold after each demo teaser, then hard-cut (snappy montage)

export const secFrames = (i: number): number => {
  const s = SECTIONS[i];
  if (s.id.startsWith("demo")) {
    return LEAD + Math.ceil(s.vo * FPS) + DEMO_TAIL;
  }
  const tail = s.id === "cta" ? CTA_TAIL : TAIL;
  return LEAD + Math.ceil(s.vo * FPS) + tail;
};

export const TOTAL = SECTIONS.reduce((sum, _s, i) => sum + secFrames(i), 0);
