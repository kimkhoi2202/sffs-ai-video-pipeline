/**
 * platformCaption.ts — the ONE place a caption is adapted to the network it is about
 * to be posted on.
 *
 * WHY THIS EXISTS. The batch designer (design.ts) writes ONE caption per video and the
 * same string was sent to Instagram, TikTok and YouTube. That is right for the brand —
 * one voice, one place to change it — and wrong for the platforms, because some of the
 * words only mean something on one network:
 *
 *   - "follow for more" is the nudge on Instagram and TikTok. On YouTube the verb is
 *     SUBSCRIBE. The rendered video already knew this (Outro.tsx picks the SUBSCRIBE
 *     pill and outro-youtube.mp3 for platform "youtube", see render.ts endKeyForCard),
 *     so the caption was the only surface still saying the wrong word.
 *   - "#fyp" / "#foryou" are For-You-Page vernacular. They are native on TikTok, read
 *     as noise on YouTube, and "#shorts" is the tag that actually does that job there.
 *   - "#puzzletok" carries TikTok's "-tok" suffix onto a channel that has no such page.
 *
 * WHAT THIS IS NOT. It is deliberately NOT three caption systems. There is one caption,
 * written once in the brand's voice, and a small dictionary of per-network
 * substitutions applied on the way out. Adding a platform means adding rows to the
 * tables below, not forking the generator. Nothing here invents copy: every rule is a
 * word-for-word swap, so the brand rules the caption already passed (no em dashes, at
 * most one emoji, always a nudge) survive the substitution by construction.
 *
 * THE SUBSTITUTION IS SYMMETRIC on the follow/subscribe axis. The base caption is
 * written in Instagram/TikTok voice, so the YouTube direction is the one that fires in
 * practice — but a caption that arrives saying "subscribe" is corrected to "follow" on
 * Instagram and TikTok too. The mirror of a bug is a bug.
 */
import { CONFIG } from "./config.ts";
import { withLink, stripTrackerLinks } from "./attribution.ts";

/** The networks a caption can be adapted for. Matches postingPolicy.Network. */
export type CaptionNetwork = "instagram" | "youtube" | "tiktok";

/**
 * The per-platform landing page a caption points at.
 *
 * This REPLACES the per-post `/go/<videoId>` tracker in new captions. The `/go/` route
 * itself is untouched and still live — every already-published caption points at it and
 * those links must keep working (see attribution.ts).
 *
 * The vanity path is the point: it keeps platform attribution (the site answers
 * `?utm_source=<network>&utm_medium=social`) while dropping the per-post tracker, so
 * it is NOT collapsed to the bare apex.
 */
export function vanityUrl(network: CaptionNetwork): string {
  const base = CONFIG.SITE_VANITY_BASE.replace(/\/+$/, "");
  return `${base}/${network}`;
}

/**
 * The comment Metricool auto-posts as the account the moment the post publishes
 * (`ScheduledPost.firstCommentText`), or undefined on a network where we do not use one.
 *
 * YOUTUBE ONLY, and specifically because of SHORTS. On YouTube the caption already IS
 * the description, so the link is technically there — but a Shorts description is
 * hidden behind a tap on the title and most viewers never learn it exists, while the
 * comment button is always on screen and opening it is ordinary Shorts behaviour. Same
 * link, somewhere a viewer actually looks.
 *
 * WHY NOT THE OTHER TWO. Instagram is documented for FEED posts and this account posts
 * Reels, so it would likely be silently dropped. TikTok does support it and is the
 * obvious next one, but nothing here has been proven against a live post yet and an
 * unverified comment on a second network is not worth more than a verified one on the
 * first.
 *
 * It carries the same per-network vanity path as the caption, so a click arriving from
 * the comment is still attributable to the network that produced it. Note the loop
 * creates ONE POST PER NETWORK (loopPublish `networks: [input.network]`), so this
 * top-level field can never leak onto a network it was not written for.
 */
export function firstCommentFor(network: CaptionNetwork): string | undefined {
  if (network !== "youtube") return undefined;
  return `Take the full test, free \uD83D\uDC49 ${vanityUrl(network)}`;
}

/** Give `replacement` the capitalisation the text it replaces was wearing. */
function matchCase(sample: string, replacement: string): string {
  if (sample.length > 1 && sample === sample.toUpperCase() && /[A-Za-z]/.test(sample)) return replacement.toUpperCase();
  if (sample[0] === sample[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

/**
 * Prose substitutions, per network. Longest form first: "followers" has to be spent
 * before "follow" can match the front of it.
 *
 * Only whole words, and only words whose meaning is genuinely network-bound. Note what
 * is NOT here: "reel" and "short" are left alone, because "short" is an ordinary
 * adjective ("short answer") and a blind swap would mangle real copy for a product
 * name that has never appeared in a caption. Hashtags are handled separately below,
 * where the "#" makes the product-name reading unambiguous.
 */
const PROSE: Record<CaptionNetwork, Array<[RegExp, string]>> = {
  youtube: [
    [/\bfollowers\b/gi, "subscribers"],
    [/\bfollower\b/gi, "subscriber"],
    [/\bfollowing\b/gi, "subscribing"],
    [/\bfollowed\b/gi, "subscribed"],
    [/\bfollows\b/gi, "subscribes"],
    [/\bfollow\b/gi, "subscribe"],
    // A YouTube description carries its links inline, so "bio" is Instagram's furniture.
    [/\blink in (?:my |the )?bio\b/gi, "link below"],
  ],
  instagram: [
    [/\bsubscribers\b/gi, "followers"],
    [/\bsubscriber\b/gi, "follower"],
    [/\bsubscribing\b/gi, "following"],
    [/\bsubscribed\b/gi, "followed"],
    [/\bsubscribes\b/gi, "follows"],
    [/\bsubscribe\b/gi, "follow"],
  ],
  tiktok: [
    [/\bsubscribers\b/gi, "followers"],
    [/\bsubscriber\b/gi, "follower"],
    [/\bsubscribing\b/gi, "following"],
    [/\bsubscribed\b/gi, "followed"],
    [/\bsubscribes\b/gi, "follows"],
    [/\bsubscribe\b/gi, "follow"],
  ],
};

/**
 * Hashtag substitutions, per network, keyed WITHOUT the leading "#" and lowercased.
 *
 * A tag that maps to "" is dropped rather than replaced. Nothing currently maps to ""
 * — every platform-native tag has a native counterpart on the other side, and keeping
 * the tag COUNT stable keeps the caption shape consistent across networks.
 */
const HASHTAGS: Record<CaptionNetwork, Record<string, string>> = {
  youtube: {
    fyp: "shorts",
    foryou: "youtubeshorts",
    foryoupage: "youtubeshorts",
    puzzletok: "puzzles",
  },
  instagram: {
    // #shorts is YouTube furniture; #reels is the Instagram equivalent surface.
    shorts: "reels",
    youtubeshorts: "reels",
  },
  tiktok: {
    shorts: "fyp",
    youtubeshorts: "foryou",
  },
};

/**
 * Tags ending in TikTok's "-tok" suffix are TikTok vernacular by construction, so on
 * YOUTUBE the suffix is stripped even when the tag is not in the table above.
 * This is the class fix: a future "#quiztok" from the hashtag rotation is handled
 * without another code change.
 *
 * Guarded, because a blind strip is how you get "#tik": the literal "#tiktok" is a
 * product name and is left alone, and a stem shorter than four characters is refused
 * rather than emitted as a stub.
 */
function stripTokSuffix(tag: string): string | null {
  const lower = tag.toLowerCase();
  if (lower === "tiktok" || !lower.endsWith("tok")) return null;
  const stem = lower.slice(0, -3);
  return stem.length >= 4 ? stem : null;
}

/** Apply one network's hashtag table (plus the -tok rule) to a single "#tag" token. */
function substituteHashtag(tag: string, network: CaptionNetwork): string | null {
  const table = HASHTAGS[network];
  const lower = tag.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(table, lower)) return table[lower];
  // YouTube ONLY. Instagram is not TikTok either, but "-tok" tags are in wide use
  // there and Instagram's caption wording is deliberately out of scope for this
  // layer's hashtag rules — the brand's Instagram voice is the base voice.
  if (network === "youtube") {
    const stripped = stripTokSuffix(tag);
    if (stripped) return stripped;
  }
  return null;
}

/**
 * Adapt caption COPY (prose + hashtags) to `network`. Does not touch links.
 *
 * Hashtags are substituted first and then held out of the prose pass, so a tag like
 * "#followme" is never rewritten by the prose rule that owns the bare verb "follow".
 */
export function substituteFor(caption: string, network: CaptionNetwork): string {
  const held: string[] = [];
  // Park every hashtag behind a placeholder the prose rules cannot match.
  let text = String(caption ?? "").replace(/#([\p{L}\p{N}_]+)/gu, (_m, tag: string) => {
    const swapped = substituteHashtag(tag, network);
    const kept = swapped === null ? `#${tag}` : swapped === "" ? "" : `#${swapped}`;
    held.push(kept);
    return `\u0000${held.length - 1}\u0000`;
  });
  for (const [re, to] of PROSE[network]) text = text.replace(re, (m) => matchCase(m, to));
  // Put the hashtags back.
  text = text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => held[Number(i)]);
  // A dropped tag can leave a double space or a dangling blank line behind.
  return text.replace(/[^\S\n]{2,}/g, " ").replace(/[^\S\n]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The full outbound transform: adapt the copy to `network`, drop any per-post tracker
 * link the caption arrived with, and point it at that network's vanity URL.
 *
 * Idempotent. Running it twice is the same as running it once, which matters because
 * the backfill re-reads and rewrites live posts.
 */
export function captionForNetwork(caption: string, network: CaptionNetwork): string {
  const copy = substituteFor(stripTrackerLinks(String(caption ?? "")), network);
  return withLink(copy, vanityUrl(network));
}
