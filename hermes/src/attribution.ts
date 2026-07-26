/**
 * attribution.ts — per-video short links.
 *
 * Today every visit arrives through the bio link, so a signup can be attributed to the
 * account but never to a video: there is no way to tell which reel actually converted.
 * A `/go/<videoId>` link in the caption makes that a per-post question instead.
 *
 * The id is the Hermes video id (e.g. "2026-07-27-v03") rather than a hashed code, on
 * purpose — it needs no lookup table on the site side, it is already unique, and it
 * carries the run date, so a raw access log is readable without joining anything.
 *
 * Metricool's own shortener is deliberately switched off in metricool.ts (`shortener:
 * false`); it would rewrite these and take the attribution with it.
 */
import { CONFIG } from "./config.ts";

/** The canonical short link for one video. */
export function goLink(videoId: string): string {
  const base = CONFIG.SITE_BASE_URL.replace(/\/+$/, "");
  const prefix = CONFIG.GO_LINK_PREFIX.startsWith("/") ? CONFIG.GO_LINK_PREFIX : `/${CONFIG.GO_LINK_PREFIX}`;
  return `${base}${prefix}${encodeURIComponent(videoId)}`;
}

/** True when this caption already carries this video's link (idempotent re-runs). */
export function hasAttribution(caption: string, videoId: string): boolean {
  return caption.includes(goLink(videoId));
}

/**
 * Append the video's short link to a caption, above the hashtags.
 *
 * Hashtags are kept last because that is where both platforms expect them and where
 * the brand's existing captions put them; the link goes on its own line just before,
 * so it stays visible in the truncated preview on Instagram.
 */
export function withAttribution(caption: string, videoId: string): string {
  const text = String(caption ?? "").trim();
  if (!text) return goLink(videoId);
  if (hasAttribution(text, videoId)) return text;

  const lines = text.split("\n");
  // Find the trailing block of hashtag-only lines and insert above it.
  let firstTagLine = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^#\S+(\s+#\S+)*$/.test(l)) firstTagLine = i;
    else break;
  }
  const link = goLink(videoId);
  if (firstTagLine === lines.length) return `${text}\n\n${link}`;
  return [...lines.slice(0, firstTagLine), link, "", ...lines.slice(firstTagLine)].join("\n").replace(/\n{3,}/g, "\n\n");
}
