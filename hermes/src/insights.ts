/**
 * insights.ts — matured post analytics, from Metricool. ALL THREE networks.
 *
 * The 3-SECOND SKIP RATE is the only metric on this account that predicts reach, and it
 * exists here and nowhere else. It is INSTAGRAM-ONLY, which is a real limit rather than
 * an oversight: Metricool declares four TikTok watch-time fields and returns null on
 * every row, and the YouTube payload has no drop-off field at all. Both contribute
 * views, reach and engagement; neither can ever contribute a skip rate.
 */
import { instagramReels, tiktokPosts, youtubePosts, type McMetrics } from "./metricool.ts";
import { CONFIG } from "./config.ts";
import { instantFromWallClock, isoInZone } from "./scheduler.ts";
import { info, warn } from "./log.ts";

export interface FlatInsight {
  post_id: string;
  account_id: string;
  network?: string;
  scheduled_at?: string;
  post_link?: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  engagement: number | null;
  engagement_rate: number | null;
  /** Percentage gone before ~3s. LOWER IS BETTER. The metric promotion judges on. */
  skip_rate: number | null;
  average_watch_time: number | null;
  /** The video's own length. Pulled every cycle and, until now, thrown away. */
  duration_seconds: number | null;
}

/**
 * Metricool is not consistent about the published timestamp across networks: TikTok
 * rows carry a plain ISO string, Instagram rows carry `{dateTime, timezone}`. The
 * FlatInsight contract says `string`, and a leaked object is not harmless — reconcile
 * can fall back to this value for `posted_at`, and rollup.ts's timeBucket() would then
 * stringify it to "[object Object]", fail to parse, and silently drop the post from the
 * time-of-day rollup. Normalised here, at the one place both shapes arrive.
 *
 * THE ZONE IS PART OF THE VALUE (fixed 2026-08-03). Until today this returned the bare
 * `dateTime`, and that naive string is NOT in the account's zone. We ask the analytics
 * endpoints for CONFIG.METRICOOL_TZ, but Metricool answers in the BRAND's own zone and
 * says so in the row: on this account every reel comes back tagged "Europe/Madrid",
 * seven hours ahead of the America/Chicago clock the posting window is written in.
 * Verified against the controlled poster's ledger on 2026-08-03 — all 20 posts that
 * could still be joined by uuid sat at +7.02..+7.07h, with no exceptions.
 *
 * Dropping the zone therefore corrupted both readings of the field:
 *   - rollup.ts timeBucket() reads the hour AS WRITTEN, so a reel published 00:21
 *     Chicago was filed under "morning (6-12)" from its 07:21 Madrid stamp. Every
 *     by_time_bucket row was shifted a third of a day, which is more than enough to
 *     relabel an evening post as a morning one — and it did produce a best-time-to-post
 *     reading that the underlying posts do not support.
 *   - Date.parse() resolves a naive string against the BOX's zone (UTC here), so
 *     score.ts's analytics snapshot and the goal window were a further two hours out.
 *
 * So resolve the pair to a real instant using the zone the row declares, then re-render
 * it in the account's POSTING zone with that offset attached. Both readings then agree:
 * the written hour is the hour the account actually posted, and the parsed instant is
 * the true one. A string that already carries an offset is re-rendered the same way, so
 * every network's rows end up on one clock.
 */
export function publishedAtString(v: unknown): string | undefined {
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    // Already an absolute instant (…Z or ±hh:mm) — restate it on the account's clock.
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? isoInZone(ms) : s;
    }
    // Naive, with nothing declaring its zone. THIS BRANCH IS A GUESS and is labelled
    // as one: the only zone available is the one we ASKED for, which is not necessarily
    // the one Metricool answered in — that mismatch is the whole reason this function
    // exists. Live Instagram rows never reach here (they arrive as the {dateTime,
    // timezone} pair below) and live TikTok rows carry an explicit +hhmm offset, so on
    // this account the branch is reached only by the two naive YouTube rows per cycle
    // and by historical strings written before this fix. If a future network starts
    // sending naive stamps, its hour will silently be a request-zone hour.
    const ms = instantFromWallClock(s, CONFIG.METRICOOL_TZ);
    return Number.isFinite(ms) ? isoInZone(ms) : s;
  }
  if (v && typeof v === "object") {
    const o = v as { dateTime?: unknown; timezone?: unknown };
    const dt = typeof o.dateTime === "string" ? o.dateTime.trim() : "";
    if (!dt) return undefined;
    const tz = typeof o.timezone === "string" && o.timezone.trim() ? o.timezone.trim() : CONFIG.METRICOOL_TZ;
    const ms = instantFromWallClock(dt, tz);
    return Number.isFinite(ms) ? isoInZone(ms) : dt;
  }
  return undefined;
}

function toFlat(m: McMetrics): FlatInsight {
  const denom = m.reach ?? m.views ?? 0;
  const eng = (m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0);
  return {
    post_id: m.platformPostId,
    account_id: CONFIG.ACCOUNTS[m.network] ?? "",
    network: m.network,
    scheduled_at: publishedAtString(m.publishedAt),
    post_link: m.url,
    views: m.views,
    reach: m.reach,
    likes: m.likes,
    comments: m.comments,
    shares: m.shares,
    saves: m.saves,
    engagement: eng || null,
    engagement_rate: denom > 0 ? (eng / denom) * 100 : null,
    skip_rate: m.skipRate,
    average_watch_time: m.averageWatchTime,
    duration_seconds: m.durationSeconds,
  };
}

/**
 * The analytics endpoints reject a bare date with an unhelpful HTTP 400 and want a NAIVE
 * local datetime — not a date, and not an ISO offset either, both of which 400. Callers
 * pass whatever they have and this normalises it, so the format cannot be got wrong twice.
 */
function stamp(d: string, endOfDay: boolean): string {
  const t = String(d).trim();
  if (/T\d{2}:\d{2}:\d{2}$/.test(t)) return t;
  const day = t.slice(0, 10);
  return `${day}T${endOfDay ? "23:59:59" : "00:00:00"}`;
}

/**
 * Everything matured in the window, across ALL THREE networks.
 *
 * Each network is pulled independently and a failure in one is warned and skipped, so
 * one network's outage never costs the cycle the other two. That per-network isolation
 * is also why YouTube's absence went unnoticed for so long: nothing failed, there was
 * simply no third block here to fail.
 */
export async function pullInsights(fromRaw: string, toRaw: string): Promise<FlatInsight[]> {
  const from = stamp(fromRaw, false);
  const to = stamp(toRaw, true);
  const out: FlatInsight[] = [];
  try {
    const reels = await instagramReels(from, to);
    out.push(...reels.map(toFlat));
    const withSkip = reels.filter((r) => r.skipRate !== null).length;
    info("metricool insights: instagram", { rows: reels.length, with_skip_rate: withSkip });
  } catch (e) {
    warn("metricool insights: instagram pull failed", { err: e instanceof Error ? e.message.slice(0, 140) : String(e) });
  }
  try {
    const tt = await tiktokPosts(from, to);
    out.push(...tt.map(toFlat));
    if (tt.length) info("metricool insights: tiktok", { rows: tt.length, note: "no skip rate exists for TikTok" });
  } catch (e) {
    warn("metricool insights: tiktok pull failed", { err: e instanceof Error ? e.message.slice(0, 140) : String(e) });
  }
  try {
    const yt = await youtubePosts(from, to);
    out.push(...yt.map(toFlat));
    info("metricool insights: youtube", { rows: yt.length, note: "no skip rate exists for YouTube; reach mirrors views" });
  } catch (e) {
    warn("metricool insights: youtube pull failed", { err: e instanceof Error ? e.message.slice(0, 140) : String(e) });
  }
  return out;
}
