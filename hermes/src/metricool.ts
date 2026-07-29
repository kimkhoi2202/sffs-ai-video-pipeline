/**
 * metricool.ts — the Metricool REST client that replaces Publer.
 *
 * Publer returns 403 on every content endpoint ("Please upgrade to Business to access
 * our API"), which is what stopped the campaign. Metricool is verified working on this
 * account: reads, writes, updates and deletes all return 200.
 *
 * WHY REST AND NOT THE MCP
 * The hosted Metricool MCP is a lossy wrapper. It rebuilds the payload from its own
 * narrower schema, silently discards keys it does not know, and still answers 200 — it
 * dropped `videoThumbnailUrl` and `videoCoverMilliseconds` entirely, which would have
 * been written off as a lost branded-cover feature on MCP evidence alone. Every write
 * goes through REST.
 *
 * THE FOUR THINGS THAT FAIL SILENTLY (all confirmed live; see
 * docs/hermes/metricool-migration-plan.md section 0)
 *
 *  1. `userId` and `blogId` are MANDATORY but declared on none of the 497 spec paths.
 *     A client generated from the swagger 401s on every call, or worse resolves against
 *     the wrong brand. They are injected here in the transport and nowhere else.
 *
 *  2. The numeric `id` is REASSIGNED on every update; `uuid` is stable. Observed live:
 *     one post reported 353913385 -> 353913396 -> 353913406 while its uuid never moved.
 *     Everything we persist keys on uuid. The uuid is a signed 64-bit integer rendered
 *     as a string and CAN BE NEGATIVE, so it is TEXT everywhere and never a JS number.
 *
 *  3. `DELETE` REJECTS THE UUID and accepts only the numeric id — and it reports the
 *     rejection as HTTP 500, not 400. So (a) every mutation re-reads the current id
 *     first via resolveId(), and (b) 5xx is NOT retryable on the mutation routes, or a
 *     generic "5xx means retry" would spin forever against a permanent type error.
 *
 *  4. TikTok `reach` is null on EVERY row (confirmed: 37 of 37). Mapping TikTok reach
 *     to `reach` compiles, runs, returns null forever, and the replication and scoring
 *     engines simply never fire — no exception, no log line. TikTok reach maps to
 *     `viewCount`, which is what Publer's TikTok "reach" always was anyway.
 *
 * VOLUME. Metricool's Fair Use cap is 700 published posts per brand per month and
 * breaching it triggers a manual human review during which NO posting is possible at
 * all. That is campaign-ending, so budget() guards against the documented 600 base
 * threshold rather than the 700 ceiling, and warns at 80% of it.
 *
 * A FAN-OUT COSTS ONE RECORD PER NETWORK. Metricool splits a multi-network post into
 * one row per provider, so posting the same video to Instagram and YouTube spends TWO
 * of the 600, not one. `monthPublishedPostsByBrand` counts those rows, which is why
 * the guard here and the per-day caps in postingPolicy.ts have to be read together —
 * see postingPolicy.budgetForecast().
 *
 * This module NEVER logs the token and never puts it in a query string.
 */
import { CONFIG } from "./config.ts";
import { info, warn } from "./log.ts";

const V2 = "/v2";

export interface McPublicationDate {
  /** Naive local datetime, NO trailing Z and NO offset: "2026-07-28T18:30:00". */
  dateTime: string;
  /** IANA zone, e.g. "America/Chicago". */
  timezone: string;
}

export interface McProvider {
  network: string;
  status?: string;
  detailedStatus?: string;
  /** The NATIVE platform post id, present once published. Our analytics join key. */
  id?: string;
  publicUrl?: string;
}

export interface McPost {
  id: number;
  /** STABLE key. Signed 64-bit int as a string, can be negative. Always TEXT. */
  uuid: string;
  text?: string;
  publicationDate?: McPublicationDate;
  providers?: McProvider[];
  media?: string[];
  videoThumbnailUrl?: string | null;
  videoCoverMilliseconds?: number | null;
  draft?: boolean;
  autoPublish?: boolean;
  plannerUrl?: string;
  [k: string]: unknown;
}

export class MetricoolError extends Error {
  status: number;
  body: string;
  /** True when the status is worth another attempt. A 500 from a mutation route is not. */
  retryable: boolean;
  // Plain field assignment, not parameter properties: the box runs these .ts files
  // directly under Node's strip-only type removal, which rejects `constructor(readonly x)`.
  constructor(message: string, status: number, body: string, retryable: boolean) {
    super(message);
    this.name = "MetricoolError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

function requireConfig(): { base: string; token: string; userId: string; blogId: string } {
  const base = CONFIG.METRICOOL_BASE_URL;
  const token = CONFIG.METRICOOL_USER_TOKEN;
  const userId = CONFIG.METRICOOL_USER_ID;
  const blogId = CONFIG.METRICOOL_BLOG_ID;
  if (!token) throw new Error("METRICOOL_USER_TOKEN is not set (expected in /etc/hermes/hermes.env)");
  if (!userId || !blogId) throw new Error("METRICOOL_USER_ID / METRICOOL_BLOG_ID are not set");
  return { base, token, userId, blogId };
}

interface CallOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Mutation routes report a bad path id as 500. Never retry those. */
  retryOn5xx?: boolean;
  attempts?: number;
}

/**
 * The one place userId/blogId are injected and the one place the token is attached.
 * Call sites pass a bare path. Retries 429 and (only where safe) 5xx with backoff.
 */
async function call<T>(path: string, opts: CallOpts = {}): Promise<T> {
  const { base, token, userId, blogId } = requireConfig();
  const method = opts.method ?? "GET";
  const retryOn5xx = opts.retryOn5xx ?? method === "GET";
  const attempts = opts.attempts ?? 3;

  const qs = new URLSearchParams();
  qs.set("userId", userId);
  qs.set("blogId", blogId);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }
  const url = `${base}${path}?${qs.toString()}`;

  let lastErr: MetricoolError | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "X-Mc-Auth": token, // header only — the docs allow a query param, which leaks into logs
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      lastErr = new MetricoolError(`network error: ${e instanceof Error ? e.message : String(e)}`, 0, "", true);
      if (attempt < attempts) { await sleep(backoffMs(attempt)); continue; }
      throw lastErr;
    }

    if (res.ok) {
      const txt = await res.text();
      if (!txt) return undefined as T;
      const parsed = JSON.parse(txt);
      // /v2/* wraps as {metadata, page, data}; legacy /stats/* and /admin/* are bare.
      return (parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed) as T;
    }

    const body = (await res.text().catch(() => "")).slice(0, 400);
    const retryable = res.status === 429 || (res.status >= 500 && retryOn5xx);
    lastErr = new MetricoolError(`${method} ${path} -> HTTP ${res.status}`, res.status, body, retryable);
    if (!retryable || attempt === attempts) throw lastErr;
    await sleep(backoffMs(attempt));
  }
  throw lastErr ?? new Error("unreachable");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number): number => Math.min(30_000, 1_000 * 2 ** (attempt - 1));

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Scheduled + draft posts in a date range. Metricool has no state filter; filter here.
 *
 * `extendedRange` DEFAULTS OFF, and that matters more than it looks. With it on the
 * date range becomes advisory: a three-hour window returned 13 rows spread across a
 * whole day, versus 1 with it off. This client used to hardcode it to true, so every
 * narrow query silently returned neighbours — which nearly caused 13 real scheduled
 * posts to be deleted as "duplicates in this slot". Only ever turn it on when you
 * actually want the fuzzy edges.
 */
export async function listPosts(
  start: string,
  end: string,
  timezone = CONFIG.METRICOOL_TZ,
  extendedRange = false,
): Promise<McPost[]> {
  const rows = await call<McPost[]>(`${V2}/scheduler/posts`, {
    query: { start, end, timezone, extendedRange },
  });
  return Array.isArray(rows) ? rows : [];
}

export async function getPost(id: number): Promise<McPost> {
  return call<McPost>(`${V2}/scheduler/posts/${id}`);
}

/**
 * The CURRENT numeric id for a stable uuid.
 *
 * Mandatory before every GET/PUT/PATCH/DELETE by path id: the numeric id is reassigned
 * on every update, so any id we stored is stale by default. Wrapping it here means no
 * call site can get this wrong.
 */
export async function resolveId(uuid: string, start?: string, end?: string): Promise<number | null> {
  const from = start ?? "2020-01-01T00:00:00";
  const to = end ?? "2030-12-31T23:59:59";
  const rows = await listPosts(from, to);
  const hit = rows.find((p) => String(p.uuid) === String(uuid));
  return hit ? Number(hit.id) : null;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** The networks this client can address. Matches postingPolicy.Network. */
export type McNetwork = "instagram" | "youtube" | "tiktok";

/** YouTube's hard title ceiling. Over this and the upload is rejected. */
export const YT_TITLE_MAX = 100;

/**
 * A YouTube title from the post text.
 *
 * The caption is written for a feed — it opens with a hook, carries emoji, and ends in
 * hashtags and an attribution link, all of which read badly as a title and waste the
 * 100 characters. So the title is the FIRST LINE only, stripped of trailing hashtags,
 * collapsed to one line, and cut on a word boundary. Falls back to the brand line
 * rather than ever producing an empty title, which YouTube also rejects.
 */
export function youtubeTitleFrom(text: string, max = YT_TITLE_MAX): string {
  const firstLine = String(text ?? "").split(/\r?\n/).find((l) => l.trim()) ?? "";
  let t = firstLine
    .replace(/\s*#[\p{L}\p{N}_]+/gu, " ") // drop hashtags anywhere on the line
    .replace(/https?:\/\/\S+/g, " ") // and any bare url
    .replace(/\s+/g, " ")
    .trim();
  if (!t) t = "Smart Fella or Fart Smella?";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

export interface CreatePostInput {
  text: string;
  /** Public/presigned URL. Metricool fetches and rehosts at schedule time. */
  mediaUrl: string;
  publicationDate: McPublicationDate;
  networks: McNetwork[];
  /**
   * Branded cover. Confirmed to persist through REST (and to be dropped by the MCP).
   *
   * Instagram honours it; YouTube does NOT — a custom Shorts thumbnail is a YouTube
   * Partner Programme feature and this channel has no videos, so it is not in the
   * programme. We still send it: it is already computed, it is inert where it is not
   * honoured, and it starts working by itself if the channel is ever admitted.
   */
  videoThumbnailUrl?: string;
  videoCoverMilliseconds?: number;
  /** TikTok requires a title; also used as the TikTok caption headline. */
  tiktokTitle?: string;
  tiktokPrivacy?: string;
  /**
   * YouTube title — a SEPARATE field from `text`. On a YouTube post `text` becomes the
   * DESCRIPTION (5,000 chars) and this is the title (100). Truncated, never trusted to
   * be short: YouTube rejects an over-length title outright.
   */
  youtubeTitle?: string;
  draft?: boolean;
  autoPublish?: boolean;
  showReelOnFeed?: boolean;
}

export function buildCreateBody(input: CreatePostInput): Record<string, unknown> {
  const providers = input.networks.map((network) => ({ network }));
  const body: Record<string, unknown> = {
    publicationDate: input.publicationDate,
    text: input.text,
    providers,
    media: [input.mediaUrl],
    mediaAltText: [],
    saveExternalMediaFiles: true,
    autoPublish: input.autoPublish ?? true,
    draft: input.draft ?? false,
    // Our own /go/<id> links carry attribution; Metricool's shortener would rewrite them.
    shortener: false,
    smartLinkData: { ids: [] },
    descendants: [],
    hasNotReadNotes: false,
  };
  if (input.videoThumbnailUrl) body.videoThumbnailUrl = input.videoThumbnailUrl;
  if (typeof input.videoCoverMilliseconds === "number") body.videoCoverMilliseconds = input.videoCoverMilliseconds;
  if (input.networks.includes("instagram")) {
    body.instagramData = {
      type: "REEL",
      // Metricool's blog says this defaults off, the MCP schema says on, the spec
      // declares no default. Always send it explicitly.
      showReelOnFeed: input.showReelOnFeed ?? true,
      collaborators: [],
      autoPublish: input.autoPublish ?? true,
    };
  }
  if (input.networks.includes("youtube")) {
    // EVERY field explicit. Metricool's ScheduledPostYoutubeData declares seven plain
    // properties and not one default (checked against the live swagger, not the docs),
    // so an omitted field is whatever the server decides — the same shape of silent
    // difference that made showReelOnFeed worth pinning down on Instagram.
    body.youtubeData = {
      // The post text is the DESCRIPTION on YouTube; the title is its own field.
      title: (input.youtubeTitle ?? youtubeTitleFrom(input.text)).slice(0, YT_TITLE_MAX),
      // "short" is what puts it in the Shorts shelf. Metricool's own videoType enum
      // (video|short|unknown) is lowercase, so this is too.
      type: CONFIG.YOUTUBE.type,
      privacy: CONFIG.YOUTUBE.privacy,
      category: CONFIG.YOUTUBE.category,
      // COPPA. YouTube requires a self-declaration on every upload and the swagger
      // shows NO default to inherit, so this is stated on every post rather than
      // left to whatever Metricool happens to send. General-audience => false.
      madeForKids: CONFIG.YOUTUBE.madeForKids,
      tags: [],
    };
  }
  if (input.networks.includes("tiktok")) {
    body.tiktokData = {
      privacyOption: input.tiktokPrivacy ?? "PUBLIC_TO_EVERYONE",
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      commercialContentThirdParty: false,
      commercialContentOwnBrand: false,
      title: (input.tiktokTitle ?? input.text).slice(0, 90),
      autoAddMusic: false,
    };
  }
  return body;
}

/** Create a scheduled post. Returns synchronously with id + uuid — no job polling. */
export async function createPost(input: CreatePostInput): Promise<McPost> {
  const post = await call<McPost>(`${V2}/scheduler/posts`, {
    method: "POST",
    body: buildCreateBody(input),
    retryOn5xx: false, // a 5xx here may still have created the post; never blind-retry a write
  });
  info("metricool post created", {
    uuid: post?.uuid,
    id: post?.id,
    networks: input.networks.join("+"),
    at: input.publicationDate.dateTime,
  });
  return post;
}

/** Pure reschedule. PATCH is purpose-built for this and does not rewrite the body. */
export async function reschedule(uuid: string, when: McPublicationDate): Promise<boolean> {
  const id = await resolveId(uuid);
  if (id === null) throw new Error(`reschedule: no live post for uuid ${uuid}`);
  await call<boolean>(`${V2}/scheduler/posts/${id}`, {
    method: "PATCH",
    query: { fields: "publicationDate" },
    body: { publicationDate: when },
    retryOn5xx: false,
  });
  return true;
}

/**
 * Fields PUT will accept back. Everything else on a read post is server-owned.
 *
 * This whitelist is not tidiness, it is damage control. PUT is a full replace, and
 * echoing the read object straight back returns HTTP 500 with
 * "Type definition error: [simple type, class ...PublicationStatusCode]" — the read
 * shape carries providers[].status ("PENDING") which the write side cannot
 * deserialize. That 500 is NOT a clean rejection: it destroyed the post it was applied
 * to. One scheduled post was lost that way (id 404, and NOT in the recycle bin,
 * because it was never a user delete). So the body is built from scratch here and
 * providers are reduced to {network} only.
 */
const PUT_WRITABLE = [
  "publicationDate", "text", "media", "mediaAltText", "autoPublish", "draft",
  "shortener", "instagramData", "tiktokData", "youtubeData", "firstCommentText",
  "videoThumbnailUrl", "videoCoverMilliseconds", "uuid",
] as const;

/** Reduce a live post to a body PUT will accept, with `patch` applied on top. */
export function buildUpdateBody(current: McPost, patch: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const k of PUT_WRITABLE) {
    if (current[k] !== undefined && current[k] !== null) body[k] = current[k];
  }
  // Providers come back with status/detailedStatus; the write side wants network only.
  body.providers = (current.providers ?? []).map((p) => ({ network: p.network }));
  return { ...body, ...patch };
}

/**
 * Raw PUT of an already-built body. Callers MUST build that body with
 * buildUpdateBody: PUT is a full replace, and echoing a read post straight back
 * returns HTTP 500 and DESTROYS the post rather than rejecting it cleanly.
 */
export async function putPost(id: number, body: Record<string, unknown>): Promise<McPost> {
  return call<McPost>(`${V2}/scheduler/posts/${id}`, { method: "PUT", body, retryOn5xx: false });
}

/**
 * Retire a numeric id left behind by a PUT. Best-effort: a 404 means it was already
 * replaced in place, which is the normal case. A surviving stale id is not cosmetic —
 * the account has a hard ceiling on scheduled rows and a stray row evicts a real post.
 */
export async function retireStaleId(staleId: number, expectUuid?: string): Promise<boolean> {
  // NEVER delete a numeric id without first confirming it still belongs to the post we
  // think it does. Metricool REASSIGNS numeric ids, so a "stale" id is frequently
  // already owned by a DIFFERENT post — retiring one unverified deleted five innocent
  // published rows on 2026-07-28. When the caller knows the uuid, the id is re-read and
  // the delete is refused unless the uuid matches; without a uuid we refuse outright,
  // because an unverified delete here is exactly the destructive case.
  if (!expectUuid) return false;
  try {
    const leftover = await getPost(staleId);
    if (String(leftover?.uuid ?? "") !== String(expectUuid)) return false; // someone else's row
    await call<boolean>(`${V2}/scheduler/posts/${staleId}`, { method: "DELETE", retryOn5xx: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the branded cover on an EXISTING post.
 *
 * PATCH cannot do this — ScheduledPostUpdateRequest models exactly one property and
 * rejects anything else with "Valid field names are: 'publicationDate'". So this is a
 * read-modify-write through PUT, built from the writable whitelist above so the
 * schedule time, caption, providers and media are carried through untouched.
 *
 * The numeric id is re-resolved from the stable uuid first, because the id is
 * reassigned on update and any cached one is stale by default.
 */
export async function setCover(uuid: string, coverUrl: string): Promise<{ updated: boolean; id: number | null; retired: number | null }> {
  const staleId = await resolveId(uuid);
  if (staleId === null) return { updated: false, id: null, retired: null };
  const current = await getPost(staleId);
  const body = buildUpdateBody(current, { videoThumbnailUrl: coverUrl });
  const updated = await call<McPost>(`${V2}/scheduler/posts/${staleId}`, { method: "PUT", body, retryOn5xx: false });

  // PUT does not replace the record in place, it mints a NEW numeric id and LEAVES the
  // old one addressable, so the post appears twice in the calendar listing. That is not
  // cosmetic: the account holds a hard ceiling on scheduled rows, and every stray row
  // silently EVICTS a real pending post — two were lost that way before this was
  // understood. Retiring the stale id keeps the row count flat.
  const newId = Number(updated?.id);
  let retired: number | null = null;
  if (Number.isFinite(newId) && newId !== staleId) {
    try {
      await call<boolean>(`${V2}/scheduler/posts/${staleId}`, { method: "DELETE", retryOn5xx: false });
      retired = staleId;
    } catch (e) {
      warn("metricool: stale post id survived the cover update — calendar has a duplicate row", {
        uuid, staleId, newId, err: e instanceof Error ? e.message.slice(0, 120) : String(e),
      });
    }
  }
  info("metricool cover set", { uuid, id: newId || staleId, retired });
  return { updated: true, id: Number.isFinite(newId) ? newId : staleId, retired };
}

/**
 * Rewrite the TEXT of an existing post, in place, touching nothing else.
 *
 * WHY A PUT AND NOT A DELETE-AND-RECREATE. A caption fix does not need to cost the post
 * its identity. PATCH cannot do it (ScheduledPostUpdateRequest models exactly one
 * property, `publicationDate`, and rejects anything else), so this is a
 * read-modify-write through PUT built from the PUT_WRITABLE whitelist, in which `text`
 * is a member. Media is the field that makes PUT dangerous: a body whose `media`
 * DIFFERS from the live row returns HTTP 500, while the identical body with media
 * unchanged returns 200. buildUpdateBody carries `media` straight through from the read
 * post, so it is byte-identical by construction and never re-sent as something new.
 *
 * THIS FUNCTION NEVER DELETES ANYTHING, AND THAT IS THE WHOLE POINT.
 *
 * setCover() and approve() both follow a PUT with `retireStaleId(oldId)`, on the theory
 * that a PUT mints a new numeric id and leaves the old one addressable as a duplicate
 * row. Retiring that stale id DESTROYED AN INNOCENT PUBLISHED POST on 2026-07-29: the
 * caption backfill PUT one YouTube post (id 355134984 -> 355166520), retireStaleId
 * re-read 355134984, saw the expected uuid, deleted it, and the row that actually went
 * away was a published Instagram reel from 08:22 that same day (uuid
 * 7336925031927533355) whose own id had been reassigned onto 355134984 in between. The
 * uuid check does not close that window, because Metricool re-indexes ids across the
 * WHOLE BRAND on every write and the check is a read followed by a separate delete.
 *
 * The same run also disproved the premise: the board held 46 rows before the PUT and 46
 * after it. The PUT REPLACED THE RECORD IN PLACE and minted no duplicate at all. There
 * was nothing to retire; the retirement was pure loss.
 *
 * So the contract here is census, not cleanup. The row count is measured before and
 * after, and:
 *   - unchanged  -> the normal case, nothing to do;
 *   - one fewer  -> something was destroyed, THROW so the caller stops;
 *   - one more   -> a real duplicate, THROW so a human decides which row dies.
 * Deleting by a numeric id we are not certain about is the one thing this account has
 * proven it cannot survive, and a stray row is cheaper than a wrong delete.
 *
 * The numeric id is re-resolved from the stable uuid first, because Metricool
 * reassigns the id on every update and any cached one is stale by default.
 *
 * Returns `changed: false` without writing when the text is already what was asked for,
 * so a re-run of a backfill is free rather than another mutation.
 */
export async function setText(uuid: string, text: string): Promise<{ updated: boolean; changed: boolean; id: number | null; rows: number }> {
  const rowsBefore = (await listPosts("2020-01-01T00:00:00", "2030-12-31T23:59:59")).length;
  const staleId = await resolveId(uuid);
  if (staleId === null) return { updated: false, changed: false, id: null, rows: rowsBefore };
  const current = await getPost(staleId);
  if (String(current.text ?? "") === text) return { updated: true, changed: false, id: staleId, rows: rowsBefore };

  const patch: Record<string, unknown> = { text };
  // On YouTube `text` is the DESCRIPTION and the title is its own field. Re-derive it
  // from the corrected caption so the two cannot drift apart; leave every other
  // youtubeData property exactly as the live row has it.
  const isYouTube = (current.providers ?? []).some((p) => p.network === "youtube");
  if (isYouTube && current.youtubeData && typeof current.youtubeData === "object") {
    patch.youtubeData = { ...(current.youtubeData as Record<string, unknown>), title: youtubeTitleFrom(text).slice(0, YT_TITLE_MAX) };
  }

  const updated = await putPost(staleId, buildUpdateBody(current, patch));
  const newId = Number(updated?.id);

  const rowsAfterList = await listPosts("2020-01-01T00:00:00", "2030-12-31T23:59:59");
  const rowsAfter = rowsAfterList.length;
  const mine = rowsAfterList.filter((p) => String(p.uuid) === String(uuid));
  if (rowsAfter < rowsBefore) {
    throw new Error(`setText(${uuid}): the board LOST a row (${rowsBefore} -> ${rowsAfter}). Something was destroyed; stopping.`);
  }
  if (rowsAfter > rowsBefore) {
    throw new Error(`setText(${uuid}): the PUT left a duplicate row (${rowsBefore} -> ${rowsAfter}, ${mine.length} rows carry this uuid). Refusing to guess which id to delete.`);
  }
  if (mine.length !== 1) {
    throw new Error(`setText(${uuid}): expected exactly one row for this uuid after the write, found ${mine.length}.`);
  }

  info("metricool text set", { uuid, id: newId || staleId, rows: rowsAfter });
  return { updated: true, changed: true, id: Number.isFinite(newId) ? newId : staleId, rows: rowsAfter };
}

/**
 * Delete ONE post, resolved from its uuid.
 *
 * Single id only, deliberately: Metricool has no bulk-delete route in any of its 497
 * paths, and we keep the single-id shape as defence in depth so a future refactor
 * cannot reintroduce the Publer accident that once wiped every draft.
 */
export async function deletePost(uuid: string): Promise<{ deleted: boolean; id: number | null }> {
  if (Array.isArray(uuid)) throw new Error("deletePost takes ONE uuid; bulk delete is not supported");
  const id = await resolveId(uuid);
  if (id === null) return { deleted: false, id: null };
  await call<boolean>(`${V2}/scheduler/posts/${id}`, { method: "DELETE", retryOn5xx: false });
  info("metricool post deleted (soft; restorable)", { uuid, id });
  return { deleted: true, id };
}

/**
 * Put a SOFT-deleted post back. Metricool's delete is reversible and the media survives
 * it, so a delete-then-create sequence can always roll its own delete back if the
 * create fails. Note this is only possible for a real user delete — a post destroyed by
 * a 500 mid-write never reaches the recycle bin.
 */
export async function restoreDeleted(id: number): Promise<boolean> {
  try {
    await call<boolean>(`${V2}/scheduler/posts/deleted/${id}`, { method: "PUT", retryOn5xx: false });
    return true;
  } catch {
    return false;
  }
}

// ── Analytics ────────────────────────────────────────────────────────────────

/** One post's metrics, normalised across networks. */
export interface McMetrics {
  // NOTE: there is no YouTube reader yet — instagramReels() and the TikTok reader are
  // the only producers. YouTube analytics (and the dashboard goal rollup that consumes
  // them) still have to be built before YouTube posts can be scored.
  network: "instagram" | "tiktok";
  /** Native platform post id — the join key we already store as platform_post_id. */
  platformPostId: string;
  url?: string;
  publishedAt?: string;
  reach: number | null;
  views: number | null;
  interactions: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Percentage of viewers gone before ~3s. Instagram only; the hook-quality metric. */
  skipRate: number | null;
  averageWatchTime: number | null;
  durationSeconds: number | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export async function instagramReels(from: string, to: string, timezone = CONFIG.METRICOOL_TZ): Promise<McMetrics[]> {
  const rows = await call<any[]>(`${V2}/analytics/reels/instagram`, { query: { from, to, timezone } });
  return (rows ?? []).map((r) => ({
    network: "instagram" as const,
    platformPostId: String(r.reelId ?? ""),
    url: r.url,
    publishedAt: r.publishedAt,
    reach: num(r.reach),
    // `views`, NOT `videoViews`/`videoViewsTotal` — Metricool labels both deprecated.
    views: num(r.views),
    interactions: num(r.interactions),
    likes: num(r.likes),
    comments: num(r.comments),
    shares: num(r.shares),
    skipRate: num(r.reelsSkipRate),
    averageWatchTime: num(r.averageWatchTime),
    durationSeconds: num(r.durationSeconds),
  }));
}

export async function tiktokPosts(from: string, to: string, timezone = CONFIG.METRICOOL_TZ): Promise<McMetrics[]> {
  const rows = await call<any[]>(`${V2}/analytics/posts/tiktok`, { query: { from, to, timezone } });
  return (rows ?? []).map((r) => {
    // TRAP 4: `reach` is null on every TikTok row. viewCount (plays) is the true
    // successor to what Publer reported as TikTok "reach" — in ab-database.json every
    // TikTok record has reach exactly equal to video_views. Mapping reach->reach here
    // would silently stop replication and scoring from ever firing on TikTok.
    const views = num(r.viewCount);
    return {
      network: "tiktok" as const,
      platformPostId: String(r.videoId ?? ""),
      url: r.shareUrl,
      publishedAt: r.createTime,
      reach: views,
      views,
      interactions: null,
      likes: num(r.likeCount),
      comments: num(r.commentCount),
      shares: num(r.shareCount),
      // Metricool exposes no usable TikTok watch-time data: the four declared fields
      // are null on all rows, so the hook experiment can only be measured on Instagram.
      skipRate: null,
      averageWatchTime: null,
      durationSeconds: num(r.duration),
    };
  });
}

// ── Volume guard ─────────────────────────────────────────────────────────────

export interface McBudget {
  used: number;
  /** The documented Fair Use base threshold we plan against (600), not the 700 ceiling. */
  budget: number;
  hardCap: number;
  remaining: number;
  pctOfBudget: number;
  alert: boolean;
  blocked: boolean;
}

/**
 * Live publication budget. Breaching Fair Use does not return a 429 — it triggers a
 * manual human review during which the account cannot post at all, so this fails
 * CLOSED at the budget rather than warning and carrying on.
 */
export async function budget(): Promise<McBudget> {
  const c = await call<Record<string, number>>(`${V2}/scheduler/counters`);
  const used = Number(c?.monthPublishedPostsByBrand ?? 0);
  const b = CONFIG.MC_MONTHLY_POST_BUDGET;
  const pct = b > 0 ? used / b : 0;
  const out: McBudget = {
    used,
    budget: b,
    hardCap: CONFIG.MC_MONTHLY_HARD_CAP,
    remaining: Math.max(0, b - used),
    pctOfBudget: pct,
    alert: pct >= CONFIG.MC_MONTHLY_ALERT_AT,
    blocked: used >= b,
  };
  if (out.blocked) {
    warn("metricool publication budget EXHAUSTED — refusing to schedule", { used, budget: b });
  } else if (out.alert) {
    warn(`metricool publication budget at ${(pct * 100).toFixed(0)}% of ${b}`, { used, remaining: out.remaining });
  }
  return out;
}

/** Brand sanity check used by preflight: proves auth + the right blogId. */
export async function ping(): Promise<{ ok: boolean; brand?: string; timezone?: string }> {
  const brands = await call<any[]>(`${V2}/settings/brands`, { query: { blogId: undefined } });
  const mine = (brands ?? []).find((b) => String(b.id) === String(CONFIG.METRICOOL_BLOG_ID));
  return { ok: !!mine, brand: mine?.label ?? mine?.title, timezone: mine?.timezone };
}
