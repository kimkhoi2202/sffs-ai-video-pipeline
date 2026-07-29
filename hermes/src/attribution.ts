/**
 * attribution.ts — the link a caption carries, and where in the caption it sits.
 *
 * HISTORY, because the two link shapes here are not redundant.
 *
 * Originally every visit arrived through the bio link, so a signup could be attributed
 * to the account but never to a video. `/go/<videoId>` made that a per-post question:
 * the id is the Hermes video id (e.g. "2026-07-27-v03") rather than a hashed code, on
 * purpose — it needs no lookup table on the site side, it is already unique, and it
 * carries the run date, so a raw access log is readable without joining anything.
 *
 * NEW CAPTIONS NO LONGER USE IT. They carry the per-platform vanity URL instead
 * (see platformCaption.ts), which keeps platform attribution — the site answers
 * `?utm_source=<network>&utm_medium=social` — while dropping the per-post tracker.
 *
 * `goLink` AND THE `/go/` ROUTE BOTH STAY. Every already-published caption points at
 * `/go/<id>` and those links must keep working; the route still answers (302 to
 * `?utm_source=social&utm_medium=social_organic&utm_content=<videoId>`). Deleting
 * either would break live posts to tidy up code that costs nothing to keep.
 *
 * Metricool's own shortener is deliberately switched off in metricool.ts (`shortener:
 * false`); it would rewrite these links and take the attribution with it.
 */
import { CONFIG } from "./config.ts";

/** The canonical per-post short link. Legacy: published captions still point here. */
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
 * Remove any link this module or platformCaption.ts may have added on a previous pass:
 * a per-post `/go/<id>` tracker, or a vanity URL for ANY network.
 *
 * Both shapes are stripped regardless of host and regardless of scheme, so a caption
 * re-read from Metricool and rewritten for a different network does not accumulate
 * links. Nothing else in the caption is touched — an unrelated URL a human put in the
 * copy survives.
 */
export function stripTrackerLinks(caption: string): string {
  const text = String(caption ?? "");
  const stripped = text
    .replace(/https?:\/\/[^\s]*\/go\/[^\s]*/gi, "")
    .replace(/https?:\/\/[^\s]*\/(?:instagram|youtube|tiktok)(?=$|[\s?#])/gi, "");
  // Collapse the blank line the removed link was sitting on.
  return stripped.replace(/[^\S\n]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Put `link` in a caption, on its own line above the trailing hashtag block.
 *
 * Hashtags are kept last because that is where both platforms expect them and where
 * the brand's existing captions put them; the link goes just before, so it stays
 * visible in the truncated preview on Instagram. Idempotent: a caption that already
 * carries this exact link is returned unchanged.
 */
export function withLink(caption: string, link: string): string {
  const text = String(caption ?? "").trim();
  if (!text) return link;
  if (text.includes(link)) return text;

  const lines = text.split("\n");
  // Find the trailing block of hashtag-only lines and insert above it.
  let firstTagLine = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^#\S+(\s+#\S+)*$/.test(l)) firstTagLine = i;
    else break;
  }
  if (firstTagLine === lines.length) return `${text}\n\n${link}`;
  return [...lines.slice(0, firstTagLine), link, "", ...lines.slice(firstTagLine)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Append the video's per-post `/go/` link. RETAINED for the published back catalogue
 * and for anything that deliberately wants per-post attribution; the live publish path
 * uses platformCaption.captionForNetwork instead.
 */
export function withAttribution(caption: string, videoId: string): string {
  return withLink(caption, goLink(videoId));
}
