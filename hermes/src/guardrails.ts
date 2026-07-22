/**
 * guardrails.ts — the DRAFT-ONLY safety core. This is the ONLY write path to Publer
 * the loop uses, and it can ONLY create drafts.
 *
 * Invariants enforced here (belt AND suspenders):
 *   1. createDraftOnly() forces state="draft", refuses any non-draft state or any
 *      scheduled_at, and re-asserts CONFIG.DRAFT_ONLY before every call.
 *   2. We snapshot every existing scheduled + published post BEFORE the cycle and
 *      verify AFTER that none disappeared or changed state — proving the loop never
 *      touched a live/scheduled post (it only ever ADDS new drafts).
 *   3. schedulePost / deletePost / updatePost are never imported (see publer.ts).
 */
import { CONFIG, assertDraftOnly } from "./config.ts";
import { createPost, type CreatePostArgs } from "./publer.ts";
import { listAllPosts, postId } from "./publer.ts";
import { info, warn } from "./log.ts";

export interface DoNotTouchSnapshot {
  scheduled_ids: string[];
  published_ids: string[];
  captured_at: string;
}

export async function snapshotDoNotTouch(): Promise<DoNotTouchSnapshot> {
  const [scheduled, published] = await Promise.all([listAllPosts("scheduled"), listAllPosts("published")]);
  const snap: DoNotTouchSnapshot = {
    scheduled_ids: scheduled.map(postId).filter(Boolean),
    published_ids: published.map(postId).filter(Boolean),
    captured_at: new Date().toISOString(),
  };
  info("guardrail: captured do-not-touch snapshot", {
    scheduled: snap.scheduled_ids.length,
    published: snap.published_ids.length,
  });
  return snap;
}

/**
 * Verify the loop did not touch any pre-existing scheduled/published post.
 * Throws if a previously-live post vanished or moved out of its bucket.
 */
export async function verifyDoNotTouch(before: DoNotTouchSnapshot): Promise<void> {
  const [scheduled, published] = await Promise.all([listAllPosts("scheduled"), listAllPosts("published")]);
  const nowSched = new Set(scheduled.map(postId));
  const nowPub = new Set(published.map(postId));
  const missingSched = before.scheduled_ids.filter((id) => !nowSched.has(id));
  const missingPub = before.published_ids.filter((id) => !nowPub.has(id));
  if (missingSched.length || missingPub.length) {
    throw new Error(
      `GUARDRAIL VIOLATION: pre-existing posts changed! missing scheduled=${JSON.stringify(missingSched)} ` +
        `missing published=${JSON.stringify(missingPub)}. Aborting.`,
    );
  }
  // Extra sanity: we should have ADDED drafts, and the scheduled/published counts
  // must be >= what we started with (we never remove).
  if (nowSched.size < before.scheduled_ids.length || nowPub.size < before.published_ids.length) {
    warn("guardrail: live/scheduled counts decreased unexpectedly", {
      before: { scheduled: before.scheduled_ids.length, published: before.published_ids.length },
      now: { scheduled: nowSched.size, published: nowPub.size },
    });
  }
  info("guardrail: verified no pre-existing scheduled/published post was touched", {
    scheduled_now: nowSched.size,
    published_now: nowPub.size,
  });
}

export interface DraftInput {
  account_ids: string[];
  text: string;
  media_ids?: string[];
  media_objects?: Array<Record<string, unknown>>;
  type?: CreatePostArgs["type"];
}

/** A validated, normalized draft payload — state is frozen to "draft". */
export interface DraftPayload {
  account_ids: string[];
  text: string;
  media_ids?: string[];
  media_objects?: Array<Record<string, unknown>>;
  type: CreatePostArgs["type"];
  state: typeof CONFIG.ALLOWED_POST_STATE; // "draft"
}

/**
 * The single source of truth for the DRAFT-ONLY guard, with NO network call.
 * Re-asserts CONFIG.DRAFT_ONLY, refuses any non-draft state or any scheduled_at,
 * requires account_ids, and forces state="draft". createDraftOnly() calls this
 * before it ever talks to Publer; the Nous plugin bridge (hermes-nous/bridge/
 * publer-draft.ts) also calls it for a network-free dry-run validation. This
 * lets the DRAFT-ONLY invariant be tested without keys or network. Throws on any
 * violation.
 */
export function validateDraftOnly(input: DraftInput & Record<string, unknown>): DraftPayload {
  assertDraftOnly();
  if ("state" in input && (input as any).state !== undefined && (input as any).state !== "draft") {
    throw new Error(`createDraftOnly: refusing non-draft state "${(input as any).state}"`);
  }
  if ("scheduled_at" in input && (input as any).scheduled_at) {
    throw new Error("createDraftOnly: refusing scheduled_at — the loop is draft-only");
  }
  if (!input.account_ids?.length) throw new Error("createDraftOnly: account_ids required");
  return {
    account_ids: input.account_ids,
    text: input.text,
    media_ids: input.media_ids,
    media_objects: input.media_objects,
    type: input.type ?? "video",
    state: CONFIG.ALLOWED_POST_STATE, // "draft", frozen
  };
}

/** The ONLY sanctioned Publer write. Creates a DRAFT and nothing else. */
export async function createDraftOnly(input: DraftInput & Record<string, unknown>): Promise<string> {
  // Validate first (belt): refuses non-draft state / scheduled_at, forces draft.
  // Then create — createPost re-applies state="draft" from the validated payload.
  return createPost(validateDraftOnly(input));
}
