/**
 * insights.ts — matured post analytics, from Metricool.
 *
 * Promotion judges on 3-SECOND SKIP RATE, which is the hook-quality signal the whole
 * hook experiment is measured on, and it only exists here.
 *
 * INSTAGRAM ONLY, and that is a real limit rather than an oversight: Metricool declares
 * four TikTok watch-time fields and returns null on every row, so TikTok contributes
 * reach and views but can never contribute a skip rate. With TikTok paused this costs
 * nothing today, and when it resumes its arms simply will not be scoreable on hook
 * quality — which is worth knowing before anyone reads a TikTok skip number as real.
 */
import { instagramReels, tiktokPosts, type McMetrics } from "./metricool.ts";
import { CONFIG } from "./config.ts";
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
}

/**
 * Metricool is not consistent about the published timestamp across networks: TikTok
 * rows carry a plain ISO string, Instagram rows carry `{dateTime, timezone}`. The
 * FlatInsight contract says `string`, and a leaked object is not harmless — reconcile
 * can fall back to this value for `posted_at`, and rollup.ts's timeBucket() would then
 * stringify it to "[object Object]", fail to parse, and silently drop the post from the
 * time-of-day rollup. Normalised here, at the one place both shapes arrive.
 */
function publishedAtString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const dt = (v as { dateTime?: unknown }).dateTime;
    if (typeof dt === "string") return dt;
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
    saves: null,
    engagement: eng || null,
    engagement_rate: denom > 0 ? (eng / denom) * 100 : null,
    skip_rate: m.skipRate,
    average_watch_time: m.averageWatchTime,
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

/** Everything matured in the window, across both networks. */
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
  return out;
}
