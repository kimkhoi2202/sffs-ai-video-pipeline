/**
 * music.ts — the alternate music bed: one licensed-music track cut into 12
 * distinct entry points so the day's batch does not all open on the same bar.
 *
 * STATUS: PREPARED, NOT SHIPPED. Selection is OFF unless HERMES_MUSIC_APT=1 and
 * is Instagram-only even then (see CONFIG.MUSIC_APT + render.ts shortProps). With
 * the switch off, nothing here runs and the committed CONFIG.MUSIC_TRACKS beds
 * remain the shipped default.
 *
 * RIGHTS RISK — READ BEFORE FLIPPING THE SWITCH. The source is a commercial
 * major-label recording. Baking it into the MP4 and uploading through the Publer
 * API is an unlicensed sync use, not the platform's licensed in-app music. The
 * realistic outcomes are the audio being muted, the post being regionally blocked
 * or removed, or account-level reach suppression. That last one is the reason this
 * ships off: we are already investigating what looks like TikTok distribution
 * suppression. Attaching platform-native licensed audio is the lower-risk path.
 * Enabling this is a human rights decision, not a code change.
 *
 * WHAT THE 12 SEGMENTS ACTUALLY ARE. The source is 489.8 s long but it is one
 * 64.36 s chorus loop (40 bars at 149.15 BPM) repeated 7.6 times, measured at
 * r=0.979. There are only ~64 seconds of unique music in the file. So these are
 * 12 distinct ENTRY POINTS into one loop, not 12 different pieces of music: each
 * video opens on a different bar of the same chorus. Bars 8-15 are a stripped
 * breakdown roughly 8 dB down with the bass gone, so no segment starts there.
 * See ab-testing/music-manifest.json for the full analysis and per-segment notes.
 *
 * Levels are baked into the assets (-7.0 dB at cut time, landing at -15.1 LUFS to
 * match the existing beds at -14.1..-15.3 LUFS), so the FullVideo duck/swell
 * envelope (shortMusicVolume -> musicLevel, DUCKED 0.38 / SWELL 0.9, parade gain)
 * is untouched and the voiceover keeps exactly the same headroom over the bed.
 */

/** The 12 cut segments, relative to remotion/public/audio/music/. Order is the
 *  rotation order; index is the value the per-video hash resolves to. */
export const APT_SEGMENTS: readonly string[] = [
  "apt/apt-01.mp3", // bar 16 — silence then the full band slams back in
  "apt/apt-02.mp3", // bar 0  — top of the loop, bass-forward chant hook
  "apt/apt-03.mp3", // bar 24 — driving bass-heavy stretch
  "apt/apt-04.mp3", // bar 36 — most vocal-forward entry
  "apt/apt-05.mp3", // bar 4  — second phrase of the chant hook
  "apt/apt-06.mp3", // bar 28 — vocal-forward, hard kick on one
  "apt/apt-07.mp3", // bar 32 — loudest bar in the loop
  "apt/apt-08.mp3", // bar 22 — strongest transient in the chorus body
  "apt/apt-09.mp3", // bar 30 — clean isolated kick
  "apt/apt-10.mp3", // bar 6  — most bass-dominant, least vocal
  "apt/apt-11.mp3", // bar 26 — balanced bass and vocal
  "apt/apt-12.mp3", // bar 34 — late-chorus, vocal leaning
];

/** FNV-1a, and the seeded Fisher-Yates from design.ts. Same shape, so a run id
 *  seeds a music order the same way it seeds the day's dimension order. */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) (h ^= s.charCodeAt(i)), (h = Math.imul(h, 16777619));
  return h >>> 0;
}
function seededOrder<T>(arr: readonly T[], seed: number): T[] {
  const a = arr.slice();
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Split a video id (`<runId>-v<NN>`) into its run and its 0-based slot. */
function parseVideoId(id: string): { runId: string; index: number } | undefined {
  const m = /^(.*)-v(\d+)$/.exec(id);
  if (!m) return undefined;
  const index = Number(m[2]) - 1;
  return index >= 0 ? { runId: m[1], index } : undefined;
}

/**
 * Deterministic per-video segment pick. Same id in, same segment out, so a
 * re-render of a video produces byte-identical audio.
 *
 * A batch is up to 12 videos and there are exactly 12 segments, so this shuffles
 * the segment list with the RUN id as the seed and hands slot i the i-th entry:
 * every video in a day's batch gets a DIFFERENT entry point, and the order
 * changes from run to run. A per-video hash cannot promise that (it collided on
 * 3 of 12 slots). Mirrors seededOrder(catalog, seedOf(runId)) in design.ts.
 *
 * Ids that are not `<runId>-v<NN>` (ad-hoc renders, samples) fall back to a plain
 * salted hash of the whole id, which is still stable per id.
 */
export function aptSegmentFor(id: string): string {
  const parsed = parseVideoId(id);
  if (parsed) {
    return seededOrder(APT_SEGMENTS, seedOf(`apt:${parsed.runId}`))[parsed.index % APT_SEGMENTS.length];
  }
  return APT_SEGMENTS[seedOf(`apt:${id}`) % APT_SEGMENTS.length];
}
