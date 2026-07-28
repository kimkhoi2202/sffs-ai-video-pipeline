/**
 * guardrails.ts — the DRAFT-ONLY safety core. Snapshot/verify run against Metricool,
 * the board the loop actually writes to.
 *
 * Invariants enforced here (belt AND suspenders):
 *   1. The loop's only write path (loopPublish.ts) creates posts with
 *      `draft: true, autoPublish: false`, so an unapproved post is physically
 *      incapable of publishing. That is the approval gate expressed at the platform
 *      level rather than in our own bookkeeping; see approval.ts and publishGate.ts.
 *   2. We snapshot every existing scheduled + published post BEFORE the cycle and
 *      verify AFTER that none disappeared or changed state — proving the loop never
 *      touched a live/scheduled post (it only ever ADDS new drafts).
 *   3. No delete/publish path is imported here, so this module cannot mutate the
 *      board even by accident.
 */
import { CONFIG } from "./config.ts";
import { listPosts as mcListPosts } from "./metricool.ts";
import { info, warn } from "./log.ts";

/**
 * The do-not-touch snapshot, on Metricool.
 *
 * The invariant: capture every post that already exists, and refuse to finish if any
 * of them vanished while the loop ran. A cover-only PUT silently evicted ten
 * published rows on 2026-07-25, and a check of exactly this shape is what caught it
 * each time. It is also why bulk-delete endpoints are never called anywhere in this
 * codebase — a Publer bulk delete once wiped every draft on the account.
 */
const BOARD_FROM = "2026-01-01T00:00:00";
const BOARD_TO = "2030-12-31T23:59:59";

async function boardIds(): Promise<{ scheduled: string[]; published: string[] }> {
  const rows = await mcListPosts(BOARD_FROM, BOARD_TO);
  const scheduled: string[] = [];
  const published: string[] = [];
  for (const p of rows) {
    // uuid is the stable key; the numeric id is reassigned on every update.
    const uuid = String((p as any)?.uuid ?? "");
    if (!uuid) continue;
    const live = (p as any)?.providers ?? [];
    if (live.some((x: any) => x?.status === "PUBLISHED")) published.push(uuid);
    else scheduled.push(uuid);
  }
  return { scheduled, published };
}

export interface DoNotTouchSnapshot {
  scheduled_ids: string[];
  published_ids: string[];
  captured_at: string;
}

export async function snapshotDoNotTouch(): Promise<DoNotTouchSnapshot> {
  const { scheduled, published } = await boardIds();
  const snap: DoNotTouchSnapshot = {
    scheduled_ids: scheduled,
    published_ids: published,
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
  const { scheduled, published } = await boardIds();
  const nowSched = new Set(scheduled);
  const nowPub = new Set(published);
  const missingSched = before.scheduled_ids.filter((id) => !nowSched.has(id) && !nowPub.has(id));
  const missingPub = before.published_ids.filter((id) => !nowPub.has(id));
  if (missingSched.length || missingPub.length) {
    throw new Error(
      `GUARDRAIL VIOLATION: pre-existing posts changed! missing scheduled=${JSON.stringify(missingSched)} ` +
        `missing published=${JSON.stringify(missingPub)}. Aborting.`,
    );
  }
  // Extra sanity: we should have ADDED drafts, and the scheduled/published counts
  // must be >= what we started with (we never remove).
  if (nowSched.size + nowPub.size < before.scheduled_ids.length + before.published_ids.length) {
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

/** The post state the loop is allowed to emit, re-exported for callers that assert on it. */
export const ALLOWED_POST_STATE = CONFIG.ALLOWED_POST_STATE;
