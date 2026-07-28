/**
 * covers.ts — the branded "SMART FELLA OR FART SMELLA?" post cover, wired into the
 * live posting step (cycle.ts) so EVERY post cold-opens on the branded title card
 * (rotating brand color) instead of the raw video first frame. The 5 per-color covers
 * are Remotion ThumbV stills, direct-uploaded to Publer ONCE and recorded in the
 * tracked ab-testing/covers-manifest.json (so this survives box rebuilds). The video
 * bytes are never touched — the cover is a poster thumbnail only, so the short still
 * cold-opens on its first question. BEST-EFFORT: a missing/corrupt manifest yields
 * null and posting proceeds UNCOVERED (a cover problem must never block a post).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CoverMedia {
  id: string;
  path: string;
  thumbnail: string;
}
export interface CoverManifest {
  covers: Record<string, CoverMedia>;
  colors?: Record<string, string>;
  /**
   * Durable PUBLIC cover URLs, one per colour, on static.metricool.com.
   *
   * `covers` above holds the PUBLER-era media ids and cdn.publer.com paths. Those are
   * useless to Metricool: that CDN is hotlink-protected and 403s without Publer's own
   * Referer, so neither Metricool nor Instagram can fetch one. And unlike `media`,
   * which Metricool copies onto its own CDN at schedule time, `videoThumbnailUrl` is
   * stored VERBATIM — verified by read-back — so the URL has to stay valid for the
   * whole life of the scheduled post. Written by ops/host_covers.mjs.
   */
  hosted?: Record<string, string>;
}

/** The 5 punchy brand-cover colors, in rotation order (matches the a502d87d covers). */
export const COVER_COLOR_ORDER = ["yellow", "coral", "blue", "green", "pink"] as const;
export type CoverColor = (typeof COVER_COLOR_ORDER)[number];

/** Tracked manifest path (env override for tests). REPO_DIR = hermes/src -> ../.. */
const MANIFEST_PATH =
  process.env.HERMES_COVERS_MANIFEST ||
  join(resolve(import.meta.dirname, "..", ".."), "ab-testing", "covers-manifest.json");

let _cache: CoverManifest | null | undefined;
/** Load + cache the cover manifest. Returns null when absent/corrupt (=> uncovered). */
export function loadCoverManifest(): CoverManifest | null {
  if (_cache !== undefined) return _cache;
  try {
    if (!existsSync(MANIFEST_PATH)) return (_cache = null);
    const j = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    _cache = j && typeof j === "object" && j.covers && typeof j.covers === "object" ? (j as CoverManifest) : null;
  } catch {
    _cache = null;
  }
  return _cache;
}

/** Stable non-negative hash of a string (per-run rotation seed). */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Deterministic rotating cover color: cycles all 5 colors across a batch, the two
 * platform twins of a video differ (TikTok offset +2), consecutive videos differ, and
 * the starting color rotates per run so consecutive days don't repeat.
 */
export function coverColorFor(runId: string, videoIndex: number, platform: "instagram" | "tiktok"): CoverColor {
  const n = COVER_COLOR_ORDER.length;
  const base = hashStr(String(runId || "")) % n;
  const off = platform === "tiktok" ? 2 : 0;
  return COVER_COLOR_ORDER[(((base + videoIndex + off) % n) + n) % n];
}

/** The branded cover media for a post (best-effort). null => no manifest => uncovered. */
export function coverMediaFor(
  runId: string,
  videoIndex: number,
  platform: "instagram" | "tiktok",
): (CoverMedia & { color: CoverColor }) | null {
  const m = loadCoverManifest();
  if (!m) return null;
  const color = coverColorFor(runId, videoIndex, platform);
  const c = m.covers[color];
  return c && c.id ? { ...c, color } : null;
}

/**
 * Build the media_object for the video with the branded cover appended as the
 * DEFAULT thumbnail (so the post's poster is the branded title card). The video media
 * id is reused unchanged, so the short still cold-opens on Q1. `existingThumbnails` is
 * [] for a freshly-imported media (cover becomes index 0 = default); for a backfill it
 * is the live post's thumbnails (cover appended at the end + made default).
 */
export function videoMediaObjectWithCover(
  mediaId: string,
  cover: CoverMedia,
  existingThumbnails: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const thumbnails = [...existingThumbnails, { id: cover.id, small: cover.thumbnail, real: cover.path }];
  return { id: mediaId, type: "video", thumbnails, default_thumbnail: thumbnails.length - 1 };
}

/**
 * The durable PUBLIC cover URL for a post, or null when the manifest has none.
 *
 * This is the Metricool path's entry point. Colour selection is the SAME deterministic
 * rotation the Publer era used (coverColorFor), so covers keep cycling across a batch
 * and consecutive videos still differ.
 *
 * Applied identically to BOTH opening arms on purpose. The alternative,
 * videoCoverMilliseconds, would pick a frame out of the video itself — but the two
 * arms' timelines are offset by the 2.2s hook, so any single millisecond value lands
 * on different content per arm (mid-wipe on one, mid-question on the other). That
 * would reintroduce, in a subtler form, exactly the poster-quality confound this is
 * fixing. A fixed branded still is identical treatment by construction.
 */
export function hostedCoverUrlFor(
  runId: string,
  videoIndex: number,
  platform: "instagram" | "tiktok",
): { url: string; color: CoverColor } | null {
  const m = loadCoverManifest();
  if (!m || !m.hosted) return null;
  const color = coverColorFor(runId, videoIndex, platform);
  const url = m.hosted[color];
  return typeof url === "string" && url ? { url, color } : null;
}

/** Frames per second the pipeline renders at, and the fixed hook length. */
const FPS = 30;
const HOOK_FRAMES = Math.round(2.2 * FPS);
const SHORT_LEAD = 0.12;
const SHORT_TRAIL = 0.4;
const SILENT_READ_S = 1.5;

/**
 * The millisecond at which a render's FIRST question plate is unambiguously on screen:
 * one second into its countdown segment.
 *
 * This is the cover the campaign uses — the post's own first question, taken with
 * Metricool's videoCoverMilliseconds. On a profile grid a visible puzzle gives a
 * scroller a reason to stop, where an identical branded card on every post says nothing.
 *
 * It is computed PER RENDER from that render's own measured VO durations and its own
 * opening arm, which is what keeps it out of the confound trap. A single fixed
 * millisecond across both arms would land mid-wipe on the motion-hook arm and
 * mid-question on the control, because their timelines differ by the 2.2s hook. Here
 * both arms show the same THING at different timestamps.
 *
 * The moment sits inside the COUNTDOWN rather than the read segment on purpose: by then
 * the plate has finished any entrance animation and the timer is visibly running, so it
 * cannot resolve to a transition frame or a half-animated state.
 */
export function coverMomentMs(props: {
  opening?: string;
  readVO?: string;
  durs?: Record<string, number>;
  questions?: Array<{ idx?: number }>;
}): number | null {
  const q0 = (props.questions ?? [])[0];
  if (!q0) return null;
  const durs = props.durs ?? {};
  const start = props.opening === "motion-hook" ? HOOK_FRAMES : 0;
  const readDur =
    props.readVO === "none"
      ? Math.round(SILENT_READ_S * FPS)
      : Math.round((SHORT_LEAD + (durs[`q${q0.idx}`] ?? 0) + SHORT_TRAIL) * FPS);
  return Math.round(((start + readDur + FPS) / FPS) * 1000);
}
