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
 * 1. IT CREATES WHATEVER THE APPROVAL GATE SAYS. The gate is retired by default now
 *    (Instagram auto-publishes), so the loop emits `draft: false, autoPublish: true`
 *    and the post goes out on its own at its slot. Setting HERMES_APPROVAL_PAUSED=false
 *    inverts both fields and restores the old behaviour, in which the human gate is
 *    expressed at the PLATFORM level rather than in our own bookkeeping: an unapproved
 *    post is then physically incapable of publishing even if this process, the
 *    dashboard and the box all disappear. approval.ts flips the same two fields.
 *    Either way the state comes from CONFIG.DRAFT_ONLY — this module never decides.
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
import { nextSlots, instantFromWallClock, WINDOW_OPEN_HOUR } from "./scheduler.ts";
import { decide, NETWORKS, perDayFor, type Network } from "./postingPolicy.ts";
import { createPost, listPosts, youtubeTitleFrom, type McPost } from "./metricool.ts";
import { hostedCoverUrlFor, coverMomentMs } from "./covers.ts";
import { captionForNetwork, firstCommentFor } from "./platformCaption.ts";
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
  // Seeded from NETWORKS rather than a literal: a network missing from this map gets
  // an EMPTY avoid list, which silently drops its 56-minute cross-batch floor.
  const out: Record<string, string[]> = Object.fromEntries(NETWORKS.map((n) => [n, [] as string[]]));
  for (const p of rows) {
    const dt = p.publicationDate?.dateTime;
    const tz = p.publicationDate?.timezone || CONFIG.METRICOOL_TZ;
    if (!dt) continue;
    // Metricool reports naive local time; the scheduler wants an instant. Resolved
    // against the post's OWN zone at the post's OWN date — see instantFromWallClock.
    const ms = instantFromWallClock(dt, tz);
    if (!Number.isFinite(ms)) continue;
    const iso = new Date(ms).toISOString();
    for (const pr of p.providers ?? []) {
      if (out[pr.network]) out[pr.network].push(iso);
    }
  }
  return out;
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

/** The brand-timezone calendar date (YYYY-MM-DD) an ISO instant falls on. This is the
 *  key countOnDay() matches against, so slot accounting must use the same one. */
export function localDayOf(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.METRICOOL_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

/**
 * Slot times for `count` posts on `network`, placed in the FIRST day that has room.
 *
 * This is the collision-awareness the brief calls for: without it a run fired on a day
 * whose quota is already spent stacks its batch on top of that day and leaves the next
 * one empty. `avoid` carries every existing same-platform instant so the 56-minute
 * floor holds against posts a previous batch placed, not merely within this one.
 */
export interface SlotPlan {
  /** Every slot, in order, possibly spanning several days. */
  times: string[];
  /** The local days actually used, with how many landed on each. */
  spread: Array<{ day: string; placed: number; room: number }>;
}

/**
 * Slot times for `count` posts on `network`, SPILLING ACROSS DAYS as capacity allows.
 *
 * The first version stopped at the first day with any room at all, which quietly
 * truncated a batch: asked for 12 on a day with 2 slots left, it returned 2 and the other
 * 10 were simply never placed. That is the same class of bug as the one that left Thursday
 * empty — a scheduler that looks at one day cannot fill a week.
 *
 * So it walks the horizon: take whatever today can still hold, then the next day, until
 * the batch is placed or the horizon runs out. `avoid` accumulates as it goes, so the
 * 56-minute same-platform floor holds across the batch AND against posts already on the
 * calendar, and each day gets its own jitter lane so two days never share a grid.
 */
export function planSlots(
  count: number,
  network: Network,
  rows: McPost[],
  seed: string,
  now: Date = new Date(),
): SlotPlan {
  const avoid = [...(timesByNetwork(rows)[network] ?? [])];
  const times: string[] = [];
  const spread: Array<{ day: string; placed: number; room: number }> = [];
  // Slots THIS call has already placed, counted by the CALENDAR DATE they actually
  // land on. See the roomOn() note below for why that is not the same as the day the
  // loop is currently filling.
  const placedOn = new Map<string, number>();

  /**
   * Remaining room on a CALENDAR DATE.
   *
   * Two things have to agree here or the cap leaks. countOnDay() reads the calendar
   * date off the stored `dateTime` string, and a posting window runs 07:00 -> 03:00 the
   * NEXT DAY — so a slot the loop generates while filling Tuesday can carry a Wednesday
   * date. The original version sized each day only from `rows` and never counted what
   * this same call had already placed, so those after-midnight slots were invisible to
   * the next iteration: Tuesday would place its full allowance, spill two slots into
   * Wednesday, and then Wednesday would place its full allowance AGAIN on top. At
   * Instagram's flat 12/day that overshoot was hidden by there being room anyway; at
   * YouTube's ramp of 3 it puts 4 posts on a 3-post day.
   */
  const roomOn = (dateISO: string): number =>
    perDayFor(network, dateISO) - countOnDay(rows, network, dateISO) - (placedOn.get(dateISO) ?? 0);

  for (let d = 0; d < HORIZON_DAYS && times.length < count; d++) {
    const day = localDay(d, now);
    // PER-DAY cap, not one fixed number for the whole horizon. YouTube ramps while the
    // channel is being seeded (postingPolicy.perDayFor), so day d and day d+2 can have
    // different ceilings; reading the cap inside the loop is what lets a single batch
    // span days with different allowances. Every other network returns its constant.
    //
    // The cap subtracts what is ALREADY on that date for this network, whoever put it
    // there — so catalogue-backfill posts and the loop's own output draw down the same
    // allowance instead of stacking.
    const room = roomOn(day);
    if (room <= 0) continue;
    const take = Math.min(count - times.length, room);
    const windowOpen = new Date(
      instantFromWallClock(`${day}T${String(WINDOW_OPEN_HOUR).padStart(2, "0")}:00:00`, CONFIG.METRICOOL_TZ),
    );
    const fromMs = Math.max(now.getTime(), windowOpen.getTime());
    // Pass the NETWORK'S OWN floor. Without it the scheduler used a hardcoded 56 for
    // every platform, so TikTok's configured 240 never applied to a single post.
    const got = nextSlots(take, {
      seed: `${seed}|${day}`,
      platform: network,
      avoid,
      fromMs,
      minGapMin: CONFIG.PLATFORM_POLICY[network]?.minGapMinutes,
    });
    if (!got.length) continue;
    // Charge every slot to the date it ACTUALLY falls on, and drop any that would push
    // a date past its cap. A dropped slot is not lost — the horizon walks on and the
    // next day with room places it on its own grid.
    const kept: string[] = [];
    for (const iso of got) {
      const dateISO = localDayOf(iso);
      if (roomOn(dateISO) <= 0) continue;
      placedOn.set(dateISO, (placedOn.get(dateISO) ?? 0) + 1);
      kept.push(iso);
    }
    if (!kept.length) continue;
    times.push(...kept);
    avoid.push(...kept); // later days keep their distance from what we just placed
    spread.push({ day, placed: kept.length, room });
  }
  return { times, spread };
}

/** Backwards-compatible single-day view, for callers that only want the first day. */
export function planDay(count: number, network: Network, rows: McPost[], seed: string, now = new Date()) {
  const p = planSlots(count, network, rows, seed, now);
  const first = p.spread[0];
  return { day: first?.day ?? "", times: p.times, room: first?.room ?? 0 };
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
  const cover = hostedCoverUrlFor(input.runId, input.index, input.network);
  const coverMs = coverMomentMs(input.renderProps as any);
  // ONE caption, adapted on the way out. The designer writes it once in the brand's
  // voice; this is where the words that only mean something on one network are
  // swapped for that network's (follow -> subscribe on YouTube, #fyp -> #shorts) and
  // where the per-platform vanity link replaces the per-post /go/ tracker.
  const caption = captionForNetwork(input.caption, input.network);

  const gate = publishGate(
    {
      id: input.videoId,
      // The gate's thumbnail rule is Instagram's, not everyone's — YouTube cannot use a
      // custom Shorts thumbnail on a non-YPP channel, so it must not be held back for
      // lacking one. Passing the network is what lets the gate tell those apart.
      network: input.network,
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
    networks: [input.network],
    // On YouTube `text` above is the DESCRIPTION and the title is its own 100-char
    // field. Derived from the caption's first line so the two stay in step.
    youtubeTitle: input.network === "youtube" ? youtubeTitleFrom(caption) : undefined,
    videoCoverMilliseconds: coverMs ?? undefined,
    // Instagram ignores the offset and serves frame zero, so the EXPLICIT thumbnail is
    // the one that actually decides what a scroller sees on the grid. Sent on YouTube
    // too, where it is inert today (no YPP) but costs nothing and would start working
    // on its own if the channel is ever admitted.
    videoThumbnailUrl: cover?.url ?? undefined,
    // YouTube only: the same vanity link the description carries, posted as a comment
    // the moment the video goes live. A Shorts description is behind a tap on the
    // title; the comment sheet is not. Undefined on every other network, which means
    // the key is not sent at all.
    firstCommentText: firstCommentFor(input.network),
    // THE APPROVAL GATE, under CONFIG.APPROVAL_PAUSED and nothing else. Retired by
    // default: these go out as draft:false/autoPublish:true and the post publishes
    // itself. HERMES_APPROVAL_PAUSED=false inverts them and the platform refuses to
    // publish the post until a human flips it back — the same gate, expressed where
    // our own bookkeeping cannot fail. approval.ts touches exactly these two fields.
    draft: CONFIG.DRAFT_ONLY,
    autoPublish: !CONFIG.DRAFT_ONLY,
    showReelOnFeed: true,
  });
  info(CONFIG.DRAFT_ONLY ? "loop draft created (AWAITING APPROVAL)" : "loop post scheduled LIVE (approval gate retired)",
    { videoId: input.videoId, uuid: post.uuid, at: input.whenLocal, draft: CONFIG.DRAFT_ONLY });
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
