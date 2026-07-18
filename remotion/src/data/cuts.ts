import type { Platform, SfxSet } from "../full/timeline";
import { ALL_IDS } from "../full/timeline";

/**
 * The repurposing plan: one source of truth for every published cut of Round 15.
 * A "cut" is a question subset + platform + aspect. Rendering passes `ids` +
 * `platform` to the FullVideo (16:9) or Short (9:16) composition via --props;
 * this file also drives the per-video questions.json / info.md / sidecars.
 *
 * Curation goals:
 *  - YouTube 10: the best/hardest 10 with a spread across CogAT types (verbal,
 *    quantitative, nonverbal) — drops the 5 easiest items, keeps all 3 visual
 *    (nonverbal) items, ramps to a hard finale.
 *  - 5 shorts (3 Qs each): balanced mixes, NOT sequential — each blends types +
 *    difficulty and ends on the hardest of its three. All 15 used once, no
 *    repeats. The 3 nonverbal items seed shorts 1-3.
 */
export type CutFormat = "16:9" | "9:16";
export type Cut = {
  slug: string;
  dir: string; // path under renders/videos/
  file: string; // mp4 filename
  platform: Platform;
  format: CutFormat;
  ids: number[];
  title: string;
  note?: string;
  /** Single looped music bed under public/audio/music/ (shorts only; the YouTube
   *  cuts use the fanfare->parade->winner arc). Distinct per short. */
  music?: string;
  /** Per-cut SFX set under public/audio/sfx/ (shorts only; distinct per short). */
  sfx?: SfxSet;
};

/** Distinct SFX set folder per short (public/audio/sfx/<slug>/…). */
const sfxSet = (slug: string): SfxSet => ({
  whoosh: `${slug}/whoosh.mp3`,
  ding: `${slug}/ding.mp3`,
  sting: `${slug}/sting.mp3`,
});

/** CogAT category + rough difficulty per question id (for docs / info.md). */
export const COG: Record<number, "verbal" | "quantitative" | "nonverbal"> = {
  1: "verbal", 2: "quantitative", 3: "nonverbal", 4: "verbal", 5: "quantitative",
  6: "verbal", 7: "quantitative", 8: "verbal", 9: "quantitative", 10: "verbal",
  11: "nonverbal", 12: "verbal", 13: "nonverbal", 14: "quantitative", 15: "quantitative",
};
export const DIFF: Record<number, "easy" | "medium" | "hard"> = {
  1: "easy", 2: "easy", 3: "medium", 4: "easy", 5: "easy",
  6: "medium", 7: "hard", 8: "easy", 9: "medium", 10: "medium",
  11: "medium", 12: "hard", 13: "medium", 14: "medium", 15: "hard",
};

/** The full 15-question YouTube master (already rendered; moved into the tree). */
export const FULL_15: Cut = {
  slug: "full-15",
  dir: "youtube/full-15",
  file: "round-15-remotion-master.mp4",
  platform: "youtube",
  format: "16:9",
  ids: ALL_IDS,
  title: "Round 15 — Full 15 (YouTube)",
};

/** Curated 10-question YouTube cut (spread + hard finale, not Q1-10). */
export const YOUTUBE_10: Cut = {
  slug: "cut-10",
  dir: "youtube/cut-10",
  file: "youtube-10.mp4",
  platform: "youtube",
  format: "16:9",
  ids: [3, 6, 9, 13, 10, 7, 11, 14, 12, 15],
  title: "Round 15 — Best 10 (YouTube)",
};

/** 5 vertical shorts (3 Qs each, ~2:10). The canonical render lives under
 *  instagram/ and is mirrored byte-for-byte into tiktok/ (identical 9:16 "follow
 *  for more" cut). Each has a DISTINCT music bed + SFX set so they don't sound
 *  the same when repurposed. */
export const SHORTS: Cut[] = [
  { slug: "short-1", dir: "instagram/short-1", file: "short-1.mp4", platform: "instagram", format: "9:16", ids: [1, 3, 7], title: "Short 1 — Odd Bird, Shapes, Tricky Series", music: "gameshow-fanfare.mp3", sfx: sfxSet("short-1") },
  { slug: "short-2", dir: "instagram/short-2", file: "short-2.mp4", platform: "instagram", format: "9:16", ids: [4, 9, 11], title: "Short 2 — Analogy, Fibonacci, Polygons", music: "prize-wheel-parade.mp3", sfx: sfxSet("short-2") },
  { slug: "short-3", dir: "instagram/short-3", file: "short-3.mp4", platform: "instagram", format: "9:16", ids: [6, 13, 14], title: "Short 3 — Analogy, Position, Number Analogy", music: "winner-spin.mp3", sfx: sfxSet("short-3") },
  { slug: "short-4", dir: "instagram/short-4", file: "short-4.mp4", platform: "instagram", format: "9:16", ids: [2, 10, 15], title: "Short 4 — Doubling, Odd One Out, Puzzle", music: "bonus-round-bounce.mp3", sfx: sfxSet("short-4") },
  { slug: "short-5", dir: "instagram/short-5", file: "short-5.mp4", platform: "instagram", format: "9:16", ids: [5, 8, 12], title: "Short 5 — Countdown, Analogy, Sentence", music: "final-round-fanfare.mp3", sfx: sfxSet("short-5") },
];

/** Sub-60-second teaser cuts: intro + ONE question (its best/shortest) + a quick
 *  binary result + outro, all under 60s for Shorts/Reels/TikTok. Each reuses its
 *  parent short's distinct music bed + SFX set. */
export const SHORTS_60: Cut[] = [
  { slug: "short-1-60", dir: "shorts-60/short-1-60", file: "short-1-60.mp4", platform: "instagram", format: "9:16", ids: [1], title: "Short 1 (under 60s) — Odd One Out", music: "gameshow-fanfare.mp3", sfx: sfxSet("short-1"), note: "Sub-60s teaser; serves IG + TikTok" },
  { slug: "short-2-60", dir: "shorts-60/short-2-60", file: "short-2-60.mp4", platform: "instagram", format: "9:16", ids: [9], title: "Short 2 (under 60s) — Fibonacci Series", music: "prize-wheel-parade.mp3", sfx: sfxSet("short-2"), note: "Sub-60s teaser; serves IG + TikTok" },
  { slug: "short-3-60", dir: "shorts-60/short-3-60", file: "short-3-60.mp4", platform: "instagram", format: "9:16", ids: [13], title: "Short 3 (under 60s) — Dot Position", music: "winner-spin.mp3", sfx: sfxSet("short-3"), note: "Sub-60s teaser; serves IG + TikTok" },
  { slug: "short-4-60", dir: "shorts-60/short-4-60", file: "short-4-60.mp4", platform: "instagram", format: "9:16", ids: [10], title: "Short 4 (under 60s) — Odd One Out", music: "bonus-round-bounce.mp3", sfx: sfxSet("short-4"), note: "Sub-60s teaser; serves IG + TikTok" },
  { slug: "short-5-60", dir: "shorts-60/short-5-60", file: "short-5-60.mp4", platform: "instagram", format: "9:16", ids: [5], title: "Short 5 (under 60s) — Number Series", music: "final-round-fanfare.mp3", sfx: sfxSet("short-5"), note: "Sub-60s teaser; serves IG + TikTok" },
];

export const ALL_CUTS: Cut[] = [FULL_15, YOUTUBE_10, ...SHORTS, ...SHORTS_60];

/** Resolve a cut by slug (used by the compositions to render a named cut). */
export const bySlug = (slug: string): Cut | undefined => ALL_CUTS.find((c) => c.slug === slug);
