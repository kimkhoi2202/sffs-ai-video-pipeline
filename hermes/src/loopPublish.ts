/**
 * loopPublish.ts — the autonomous cycle's publish phase, on Metricool.
 *
 * The cycle was written against Publer and still imported its media-import/job-poll
 * dance. Publer now 403s on every content endpoint, so an armed loop would have
 * rendered a full batch and then failed at the first upload — the exact shape of the
 * 2026-07-25 failure. This is the replacement, and it deliberately reuses the modules
 * the controlled path (ops/resume_posting.mjs) already proved against the live account
 * rather than re-deriving any of it.
 *
 * THREE THINGS IT DOES THAT THE PUBLER PATH DID NOT
 *
 * 1. IT CREATES DRAFTS, NOT LIVE POSTS. Everything the loop generates lands as
 *    `draft: true, autoPublish: false`, which is the human approval gate expressed at
 *    the platform level rather than in our own bookkeeping: an unapproved post is
 *    physically incapable of publishing, even if this process, the dashboard and the
 *    box all disappear. Approval flips those two fields; see approval.ts.
 *
 * 2. IT RESPECTS THE POSTING POLICY, including the TikTok pause. A re-armed loop that
 *    ignored CONFIG.PLATFORM_POLICY.tiktok.paused would silently undo a deliberate
 *    hold, so the policy is consulted here rather than assumed.
 *
 * 3. IT SCHEDULES INTO THE FIRST DAY WITH ROOM. nextSlots() allocates forward from
 *    "now", which means a Wednesday-morning run piles onto a Wednesday that is already
 *    full instead of filling an empty Thursday. planSlots() below finds the first day
 *    under the per-day cap and starts there, and feeds every existing same-platform
 *    time in as `avoid` so the 56-minute floor holds across batches, not just within one.
 */
import { CONFIG } from "./config.ts";
import { info, warn } from "./log.ts";
import { nextSlots, WINDOW_OPEN_HOUR } from "./scheduler.ts";
import { decide, type Network } from "./postingPolicy.ts";
import { createPost, listPosts, type McPost } from "./metricool.ts";
import { hostedCoverUrlFor, coverMomentMs } from "./covers.ts";
import { withAttribution } from "./attribution.ts";
import { publishGate } from "./publishGate.ts";
import { uploadToS3 } from "./s3.ts";
import type { HermesQ } from "./state.ts";

/** How many days ahead planSlots will look for a day with room. */
const HORIZON_DAYS = 7;

/** A post the loop created and a human has not yet approved. */
export interface LoopDraft {
  uuid: string;
  id: number;
  videoId: string;
  network: Network;
  at: string;
  coverMs: number | null;
}

/** Existing scheduled times per network, as ISO instants, for gap avoidance. */
export function timesByNetwork(rows: McPost[]): Record<string, string[]> {
  const out: Record<string, string[]> = { instagram: [], tiktok: [] };
  for (const p of rows) {
    const dt = p.publicationDate?.dateTime;
    const tz = p.publicationDate?.timezone || CONFIG.METRICOOL_TZ;
    if (!dt) continue;
    // Metricool reports naive local time; the scheduler wants an instant.
    const iso = new Date(`${dt}${offsetFor(tz)}`).toISOString();
    for (const pr of p.providers ?? []) {
      if (out[pr.network]) out[pr.network].push(iso);
    }
  }
  return out;
}

/** Chicago is the only zone this campaign uses; -05:00 in July, -06:00 otherwise. */
function offsetFor(_tz: string): string {
  const jan = new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset();
  const now = new Date();
  const isDst = now.getTimezoneOffset() < jan;
  return isDst ? "-05:00" : "-06:00";
}

/** How many posts a given network already has on a given local day. */
export function countOnDay(rows: McPost[], network: string, dayISO: string): number {
  let n = 0;
  for (const p of rows) {
    if (!String(p.publicationDate?.dateTime ?? "").startsWith(dayISO)) continue;
    if ((p.providers ?? []).some((x) => x.network === network)) n++;
  }
  return n;
}

/** Local YYYY-MM-DD, `plus` days from today, in the brand timezone. */
export function localDay(plus = 0, now: Date = new Date()): string {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.METRICOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date(now.getTime() + plus * 86_400_000));
}

/**
 * Slot times for `count` posts on `network`, placed in the FIRST day that has room.
 *
 * This is the collision-awareness the brief calls for: without it a run fired on a day
 * whose quota is already spent stacks its batch on top of that day and leaves the next
 * one empty. `avoid` carries every existing same-platform instant so the 56-minute
 * floor holds against posts a previous batch placed, not merely within this one.
 */
export function planSlots(
  count: number,
  network: Network,
  rows: McPost[],
  seed: string,
  now: Date = new Date(),
): { day: string; times: string[]; room: number } {
  const perDay = CONFIG.PLATFORM_POLICY[network]?.perDay ?? 0;
  const avoid = timesByNetwork(rows)[network] ?? [];
  for (let d = 0; d < HORIZON_DAYS; d++) {
    const day = localDay(d, now);
    const room = perDay - countOnDay(rows, network, day);
    if (room <= 0) continue;
    const take = Math.min(count, room);
    // Start from the later of "now" and this day's window opening, so today's run
    // never tries to schedule into a slot that has already passed.
    const windowOpen = new Date(`${day}T${String(WINDOW_OPEN_HOUR).padStart(2, "0")}:00:00${offsetFor(CONFIG.METRICOOL_TZ)}`);
    const fromMs = Math.max(now.getTime(), windowOpen.getTime());
    const times = nextSlots(take, { seed: `${seed}|${day}`, platform: network, avoid, fromMs });
    if (times.length) return { day, times, room };
  }
  return { day: "", times: [], room: 0 };
}

export interface LoopPublishInput {
  runId: string;
  videoId: string;
  index: number;
  caption: string;
  hashtagSet?: string;
  questions: HermesQ[];
  explanations: string[];
  answerLabels: string[];
  renderPath: string;
  /** The saved render props, for the question-plate cover moment. */
  renderProps: Record<string, unknown>;
  whenLocal: string;
  network: Network;
}

/**
 * Create ONE loop post as an UNAPPROVED draft.
 *
 * The publish gate runs here as well as in the controlled path, because this is the
 * other door into the calendar and a gate only one door has is not a gate.
 */
export async function publishAsDraft(input: LoopPublishInput): Promise<LoopDraft> {
  const cover = hostedCoverUrlFor(input.runId, input.index, input.network as "instagram" | "tiktok");
  const coverMs = coverMomentMs(input.renderProps as any);
  const caption = withAttribution(input.caption, input.videoId);

  const gate = publishGate(
    {
      id: input.videoId,
      caption,
      hashtag_set: input.hashtagSet,
      questions: input.questions,
      explanations: input.explanations,
      answerLabels: input.answerLabels,
      cover_ms: coverMs,
      cover_url: cover?.url ?? null,
      thumbnail_url: cover?.url ?? null,
    },
    [],
  );
  if (!gate.pass) throw new Error(`publish gate refused: ${gate.reason}`);

  const mediaUrl = uploadToS3(input.renderPath, `hermes/${input.runId}/${input.videoId}.mp4`);
  const post = await createPost({
    text: caption,
    mediaUrl,
    publicationDate: { dateTime: input.whenLocal, timezone: CONFIG.METRICOOL_TZ },
    networks: [input.network as "instagram" | "tiktok"],
    videoCoverMilliseconds: coverMs ?? undefined,
    // Instagram ignores the offset and serves frame zero, so the EXPLICIT thumbnail is
    // the one that actually decides what a scroller sees on the grid.
    videoThumbnailUrl: cover?.url ?? undefined,
    // THE APPROVAL GATE. Not a flag in our own store — the platform itself will not
    // publish a draft, so an unapproved video cannot go out even if everything on our
    // side fails. approval.ts flips exactly these two fields and nothing else.
    draft: true,
    autoPublish: false,
    showReelOnFeed: true,
  });
  info("loop draft created (AWAITING APPROVAL)", { videoId: input.videoId, uuid: post.uuid, at: input.whenLocal });
  return {
    uuid: String(post.uuid),
    id: Number(post.id),
    videoId: input.videoId,
    network: input.network,
    at: input.whenLocal,
    coverMs,
  };
}

/**
 * Which networks may take posts this run, and how many. Wraps decide() so the cycle
 * cannot accidentally bypass the pause: a paused network reports zero and says why.
 */
export async function allocatable(budgetRemaining: number): Promise<Array<{ network: Network; slots: number; reason: string }>> {
  const out = decide(budgetRemaining).map((d) => ({ network: d.network, slots: d.slots, reason: d.reason }));
  for (const d of out) if (!d.slots) warn(`loop: ${d.network} takes no slots — ${d.reason}`);
  return out;
}

/** Everything currently on the calendar, for capacity and gap maths. */
export async function calendarRows(): Promise<McPost[]> {
  return listPosts(`${localDay(-1)}T00:00:00`, `${localDay(HORIZON_DAYS + 1)}T23:59:59`);
}
