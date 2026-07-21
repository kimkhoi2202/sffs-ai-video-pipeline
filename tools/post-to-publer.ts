#!/usr/bin/env node
/**
 * post-to-publer.ts — dependency-light Publer REST API v1 client.
 *
 * WHY THIS EXISTS
 *   The SFFS posting loop needs to import rendered shorts into Publer and create
 *   posts (drafts, then eventually scheduled/live) across Instagram + TikTok — from
 *   a plain Node runtime with NO npm dependencies and NO MCP server (the cloud loop
 *   won't have the Publer MCP available). This is that client: Node built-ins +
 *   global fetch only.
 *
 * AUTHORITATIVE ENDPOINTS
 *   Verified against the `alexkess/publer-mcp-server` package (the same wrapper this
 *   repo already uses) and https://publer.com/docs. Base = https://app.publer.com/api/v1.
 *     - POST /media/from-url   -> async, returns { job_id }        (import media by URL)
 *     - GET  /job_status/{id}  -> { status, payload }              (poll async jobs)
 *     - POST /posts/schedule   -> async, returns { job_id }        (create post; state=draft here)
 *     - GET  /accounts         -> [{ id, provider, ... }]          (map account -> network provider)
 *     - GET  /posts?...        -> posts list                       (find created drafts by media/caption)
 *   Auth headers on EVERY call:
 *     Authorization: Bearer-API <PUBLER_API_KEY>
 *     Publer-Workspace-Id: <PUBLER_WORKSPACE_ID>
 *     Accept: application/json
 *
 * ASYNC + RATE LIMITS
 *   Media import and post creation are ASYNC: they return a job_id you must poll to
 *   completion. Publer allows only ONE "download media from URL" job at a time —
 *   parallel imports return HTTP 403 — so callers MUST import media sequentially
 *   (import -> poll to complete -> next). This module never fires imports in parallel.
 *
 * USAGE (module)
 *   import { uploadMediaFromUrl, getJobStatus, createPost, importMediaFromUrl,
 *            listAccounts, listPosts, pollJob } from "./post-to-publer.ts";
 *
 * USAGE (CLI, for probing/debugging)
 *   node tools/post-to-publer.ts accounts
 *   node tools/post-to-publer.ts list-posts draft
 *   node tools/post-to-publer.ts job <job_id>
 *   node tools/post-to-publer.ts import <public-url> <name>
 *
 * ENV (from video/.env — sourced automatically via process.loadEnvFile)
 *   PUBLER_API_KEY, PUBLER_WORKSPACE_ID
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "https://app.publer.com/api/v1";

// ── Types ──
export type PostState = "draft" | "draft_private" | "draft_public" | "scheduled";
export type ContentType = "status" | "photo" | "video" | "link" | "carousel" | "pdf";

export interface PublerAccount {
  id: string;
  provider?: string; // e.g. "instagram", "tiktok"
  name?: string;
  [k: string]: unknown;
}

export interface JobStatus {
  status: string; // "working" | "complete"/"completed" | "failed" | ...
  payload: unknown;
  raw: unknown; // the full unmodified job_status response
}

export interface CreatePostArgs {
  account_ids: string[];
  text: string;
  media_ids?: string[];
  state?: PostState; // defaults to "draft"
  type?: ContentType; // defaults to "video" (these are video shorts)
  scheduled_at?: string; // ISO 8601; only for state="scheduled"
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------
/**
 * Load PUBLER_* (and any other) vars from video/.env if not already in the
 * environment. Uses Node's built-in process.loadEnvFile (Node >= 21.7) — no
 * dotenv dependency. Safe to call repeatedly; never throws.
 */
export function loadEnv(): string | null {
  const candidates = [
    process.env.ENV_FILE,
    join(process.cwd(), ".env"),
    // tools/ lives directly under the repo root (video/), so ../.env is video/.env.
    join(import.meta.dirname, "..", ".env"),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        process.loadEnvFile(p);
        return p;
      }
    } catch {
      // ignore and try the next candidate; vars may already be exported.
    }
  }
  return null;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env var: ${name}`);
  return v.trim();
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer-API ${requireEnv("PUBLER_API_KEY")}`,
    "Publer-Workspace-Id": requireEnv("PUBLER_WORKSPACE_ID"),
    Accept: "application/json",
  };
}

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------
async function publerRequest<T = any>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  loadEnv();
  const headers = authHeaders();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface Publer's error body verbatim (never contains our key) so callers
    // get the exact HTTP status + reason (e.g. 403 on a parallel media import).
    throw new Error(`Publer API ${method} ${path} -> HTTP ${res.status}: ${text}`);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Publer API ${method} ${path} -> non-JSON response: ${text.slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Extractors (tolerant to Publer's response-shape variations)
// ---------------------------------------------------------------------------
function extractJobId(res: any): string | null {
  if (!res || typeof res !== "object") return null;
  return (
    res.job_id ??
    res.jobId ??
    res.id ??
    res.job?.id ??
    res.data?.job_id ??
    null
  );
}

/** Pull media IDs out of a completed media-import job payload, whatever its shape. */
export function extractMediaIds(payload: any): string[] {
  const ids: string[] = [];
  const pushId = (obj: any) => {
    if (obj && typeof obj === "object" && (obj.id || obj._id)) ids.push(String(obj.id ?? obj._id));
  };
  if (!payload) return ids;
  if (Array.isArray(payload)) {
    payload.forEach(pushId);
  } else if (Array.isArray(payload.media)) {
    payload.media.forEach(pushId);
  } else if (typeof payload === "object") {
    // numeric-keyed map { "0": {..}, "1": {..} } or a single media object.
    if (payload.id || payload._id) {
      pushId(payload);
    } else {
      for (const v of Object.values(payload)) pushId(v);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
/** GET /job_status/{id} -> normalized { status, payload, raw }. */
export async function getJobStatus(jobId: string): Promise<JobStatus> {
  const raw = await publerRequest<any>("GET", `/job_status/${encodeURIComponent(jobId)}`);
  return { status: raw?.status ?? "unknown", payload: raw?.payload ?? raw, raw };
}

function isTerminalSuccess(status: string): boolean {
  const s = status.toLowerCase();
  return s === "complete" || s === "completed" || s === "success" || s === "succeeded";
}
function isTerminalFailure(status: string): boolean {
  const s = status.toLowerCase();
  return s === "failed" || s === "error" || s === "errored";
}

/**
 * Poll a job until it terminates. Resolves with the terminal JobStatus on
 * success, throws on failure or timeout.
 */
export async function pollJob(
  jobId: string,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<JobStatus> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const label = opts.label ?? "job";
  const deadline = Date.now() + timeoutMs;
  let last: JobStatus | null = null;
  while (Date.now() < deadline) {
    last = await getJobStatus(jobId);
    if (isTerminalSuccess(last.status)) return last;
    if (isTerminalFailure(last.status)) {
      throw new Error(`Publer ${label} ${jobId} FAILED: ${JSON.stringify(last.payload).slice(0, 800)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Publer ${label} ${jobId} timed out after ${timeoutMs}ms (last status: ${last?.status ?? "n/a"})`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
/** GET /accounts -> array of connected social accounts. */
export async function listAccounts(): Promise<PublerAccount[]> {
  const res = await publerRequest<any>("GET", "/accounts");
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.accounts)) return res.accounts;
  if (Array.isArray(res?.data)) return res.data;
  return [];
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------
/**
 * POST /media/from-url — import a public media URL into Publer. ASYNC: returns a
 * job_id to poll. Publer permits only one URL-import job at a time (parallel
 * imports 403) so callers must not run these concurrently.
 */
export async function uploadMediaFromUrl(url: string, name: string, caption?: string): Promise<string> {
  const body = {
    media: [{ url, name, ...(caption ? { caption } : {}) }],
    type: "single",
    in_library: true,
    direct_upload: true,
  };
  const res = await publerRequest<any>("POST", "/media/from-url", body);
  const jobId = extractJobId(res);
  if (!jobId) throw new Error(`No job_id in /media/from-url response: ${JSON.stringify(res).slice(0, 500)}`);
  return jobId;
}

/** Convenience: import a media URL and poll to completion, returning the media_id. */
export async function importMediaFromUrl(
  url: string,
  name: string,
  opts: { caption?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ mediaId: string; job: JobStatus }> {
  const jobId = await uploadMediaFromUrl(url, name, opts.caption);
  const job = await pollJob(jobId, {
    timeoutMs: opts.timeoutMs ?? 240_000,
    intervalMs: opts.intervalMs ?? 2_500,
    label: "media-import",
  });
  const ids = extractMediaIds(job.payload);
  if (ids.length === 0) {
    throw new Error(`media-import ${jobId} completed but no media id found in payload: ${JSON.stringify(job.payload).slice(0, 800)}`);
  }
  return { mediaId: ids[0], job };
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
/**
 * POST /posts/schedule — create a post. Defaults to state="draft" so nothing goes
 * live. ASYNC: returns a job_id to poll. Content is shared per-network-provider
 * (Instagram + TikTok are different providers, so each gets its own networks entry
 * carrying the same text + media). Mirrors the publer-mcp-server bulk body exactly.
 */
export async function createPost(args: CreatePostArgs): Promise<string> {
  const { account_ids, text, media_ids, scheduled_at } = args;
  const state: PostState = args.state ?? "draft";
  const type: ContentType = args.type ?? "video";
  if (!account_ids?.length) throw new Error("createPost: account_ids is required");

  // Map each account id to its network provider so networks{} is keyed correctly.
  const accounts = await listAccounts();
  const providerById = new Map(accounts.map((a) => [a.id, a.provider]));

  const networks: Record<string, any> = {};
  for (const id of account_ids) {
    const provider = providerById.get(id);
    if (!provider) {
      throw new Error(
        `createPost: account ${id} not found among connected accounts (or missing provider). ` +
          `Known: ${accounts.map((a) => `${a.id}:${a.provider}`).join(", ")}`,
      );
    }
    if (!networks[provider]) {
      const content: any = { type, text };
      if (media_ids?.length) content.media = media_ids.map((mid) => ({ id: mid }));
      networks[provider] = content;
    }
  }

  const post: any = {
    accounts: account_ids.map((id) => ({ id, ...(scheduled_at ? { scheduled_at } : {}) })),
    networks,
  };
  const body = { bulk: { state, posts: [post] } };
  const res = await publerRequest<any>("POST", "/posts/schedule", body);
  const jobId = extractJobId(res);
  if (!jobId) throw new Error(`No job_id in /posts/schedule response: ${JSON.stringify(res).slice(0, 500)}`);
  return jobId;
}

/**
 * PUT /posts/{id} — update an existing post's text/media/scheduled_at.
 * NOTE: Publer's PUT does NOT change a post's state (draft->scheduled) and does NOT
 * reschedule (confirmed by publer.com/docs + the publer-mcp-server author). To move a
 * draft to scheduled, use schedulePost() to recreate then deletePost() the original.
 * Kept for completeness / caption edits.
 */
export async function updatePost(postId: string | number, body: Record<string, unknown>): Promise<any> {
  return publerRequest("PUT", `/posts/${encodeURIComponent(String(postId))}`, body);
}

/**
 * DELETE /posts?post_ids[]=... — delete one or more posts (bulk query-param route).
 * IMPORTANT: Publer's delete is this bulk route; `DELETE /posts/{id}` 404s (confirmed
 * via publer.com/docs + the publer-mcp-server deletion fix). Returns { deleted_ids: [...] }.
 */
export async function deletePosts(postIds: Array<string | number>): Promise<any> {
  if (!postIds.length) return { deleted_ids: [] };
  const qs = new URLSearchParams();
  for (const id of postIds) qs.append("post_ids[]", String(id));
  return publerRequest("DELETE", `/posts?${qs.toString()}`);
}

/** Convenience: delete a single post by id (wraps the bulk deletePosts route). */
export async function deletePost(postId: string | number): Promise<any> {
  return deletePosts([postId]);
}

/**
 * Schedule a post for future auto-publish. Thin wrapper over createPost with
 * state defaulting to "scheduled"; scheduled_at (ISO 8601 w/ tz, >=1 min future)
 * is applied per-account by createPost. Returns a job_id to poll.
 *
 * Because Publer has no in-place draft->scheduled transition, the loop's
 * "publish a draft at time T" = schedulePost(...) to recreate + deletePost(oldId).
 */
export async function schedulePost(
  args: Omit<CreatePostArgs, "state"> & { state?: PostState },
): Promise<string> {
  return createPost({ ...args, state: args.state ?? "scheduled" });
}

/** Media ids attached to a post object (list shape), tolerant of variations. */
export function mediaIdsOfPost(post: any): string[] {
  if (!post || !Array.isArray(post.media)) return [];
  return post.media
    .map((m: any) => (m && (m.id ?? m._id) != null ? String(m.id ?? m._id) : ""))
    .filter(Boolean);
}

/**
 * Find posts carrying a given media_id for specific accounts, in a given state,
 * paging through results (scheduled/draft lists can span multiple pages). Returns
 * at most one post per account (the match).
 */
export async function findPostsByMedia(
  mediaId: string,
  accountIds: string[],
  opts: { state?: string; maxPages?: number } = {},
): Promise<any[]> {
  const state = opts.state ?? "scheduled";
  const maxPages = opts.maxPages ?? 8;
  const wanted = new Set(accountIds);
  const byAccount = new Map<string, any>();
  for (let page = 0; page < maxPages; page++) {
    const posts = await listPosts({ state, page });
    if (!posts.length) break;
    for (const p of posts) {
      if (wanted.has(p.account_id) && mediaIdsOfPost(p).includes(mediaId)) {
        if (!byAccount.has(p.account_id)) byAccount.set(p.account_id, p);
      }
    }
    if (byAccount.size >= accountIds.length) break;
  }
  return [...byAccount.values()];
}

export interface ListPostsParams {
  state?: string; // "draft" | "scheduled" | "published" | "all" | ...
  from?: string;
  to?: string;
  page?: number;
  account_ids?: string[];
  query?: string;
  postType?: string;
}

/** GET /posts — list/filter posts. Returns the raw posts array (shape-tolerant). */
export async function listPosts(params: ListPostsParams = {}): Promise<any[]> {
  const qs = new URLSearchParams();
  if (params.state) qs.set("state", params.state);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.page !== undefined) qs.set("page", String(params.page));
  if (params.query) qs.set("query", params.query);
  if (params.postType) qs.set("postType", params.postType);
  if (params.account_ids?.length) {
    for (const id of params.account_ids) qs.append("account_ids[]", id);
  }
  const q = qs.toString();
  const res = await publerRequest<any>("GET", `/posts${q ? `?${q}` : ""}`);
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.posts)) return res.posts;
  if (Array.isArray(res?.data)) return res.data;
  return [];
}

// ---------------------------------------------------------------------------
// CLI (probing / debugging only)
// ---------------------------------------------------------------------------
async function cli(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "accounts": {
      const accounts = await listAccounts();
      console.log(JSON.stringify(accounts, null, 2));
      break;
    }
    case "list-posts": {
      const [state, query] = rest;
      const posts = await listPosts({ state: state ?? "draft", query });
      console.log(JSON.stringify(posts, null, 2));
      break;
    }
    case "job": {
      const [jobId] = rest;
      if (!jobId) throw new Error("usage: post-to-publer.ts job <job_id>");
      console.log(JSON.stringify(await getJobStatus(jobId), null, 2));
      break;
    }
    case "delete": {
      if (!rest.length) throw new Error("usage: post-to-publer.ts delete <post_id> [post_id...]");
      console.log(JSON.stringify(await deletePosts(rest), null, 2));
      break;
    }
    case "import": {
      const [url, name] = rest;
      if (!url || !name) throw new Error("usage: post-to-publer.ts import <url> <name>");
      const { mediaId, job } = await importMediaFromUrl(url, name);
      console.error(`[post-to-publer] imported media_id=${mediaId}`);
      console.log(JSON.stringify({ mediaId, status: job.status }, null, 2));
      break;
    }
    default:
      console.error(
        "usage: node tools/post-to-publer.ts <accounts|list-posts [state] [query]|job <id>|delete <id>|import <url> <name>>",
      );
      process.exit(2);
  }
}

// Run as CLI only when invoked directly (not when imported as a module).
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  loadEnv();
  cli().catch((err: unknown) => {
    console.error(`[post-to-publer] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
