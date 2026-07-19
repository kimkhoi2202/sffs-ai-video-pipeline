/**
 * SELF-CONTAINED intro timing. NOT imported by Root.tsx / the running render.
 * Durations are the ffprobe-measured lengths of the cloned-voice VO mp3s under
 * public/sffs-intro/ (generated via voice/voice_pipeline.py, voice_id
 * lZcmpVLaoXF4v0uz4l6Q, eleven_v3). Each section holds for its VO + a short tail.
 */
export const FPS = 30;

export type SectionId = "hook" | "what" | "demo1" | "demo2" | "demo3" | "mission" | "cta";

export const SECTIONS: { id: SectionId; vo: number }[] = [
  { id: "hook", vo: 4.8 },
  { id: "what", vo: 9.68 },
  { id: "demo1", vo: 4.08 },
  { id: "demo2", vo: 3.44 },
  { id: "demo3", vo: 3.52 },
  { id: "mission", vo: 8.24 },
  { id: "cta", vo: 8.64 },
];

/** Frames before the VO starts inside a section (lets the entrance land first). */
export const LEAD = 3;
const TAIL = 5; // breathing frames after VO on a normal section
const CTA_TAIL = 18; // let the closing line + follow pill ring out

export const secFrames = (i: number): number => {
  const s = SECTIONS[i];
  const tail = s.id === "cta" ? CTA_TAIL : TAIL;
  return LEAD + Math.ceil(s.vo * FPS) + tail;
};

export const TOTAL = SECTIONS.reduce((sum, _s, i) => sum + secFrames(i), 0);
