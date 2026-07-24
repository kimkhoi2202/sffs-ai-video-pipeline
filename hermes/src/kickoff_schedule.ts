/**
 * kickoff_schedule.ts — the ONLY autonomous scheduling path, HARD-GATED on the
 * kickoff switch. Two independent safeguards keep the OFF loop draft-only:
 *   1. cycle.ts only DYNAMIC-imports this module inside the `armed` branch, so an
 *      un-armed cycle never even loads a module that can reach schedulePost, and
 *   2. createScheduledPostArmed() calls assertKickoffArmed() (fail-closed: throws
 *      when not armed) before it can talk to Publer.
 *
 * It ONLY ever CREATES a new post in state="scheduled" at a policy time inside the
 * Chicago window (scheduler.ts). It never publishes "now" and never mutates/deletes
 * an existing post (deletePost / updatePost are NOT imported), so the do-not-touch
 * guarantee for every pre-existing scheduled/published post is untouched.
 */
import { schedulePost, type CreatePostArgs } from "../../tools/post-to-publer.ts";
import { assertKickoffArmed } from "./kickoff.ts";
import { isWithinWindow } from "./scheduler.ts";

export interface ScheduleInput {
  account_ids: string[];
  text: string;
  media_ids?: string[];
  media_objects?: Array<Record<string, unknown>>; // full media objects (carry the branded cover thumbnail)
  type?: CreatePostArgs["type"];
}

/**
 * Create ONE scheduled post at `whenISO`. Refused unless (a) kickoff is armed and
 * (b) the time is inside the 7am–1am America/Chicago window. Returns the job id.
 */
export async function createScheduledPostArmed(input: ScheduleInput, whenISO: string): Promise<string> {
  assertKickoffArmed(); // fail-closed: throws when the human switch is OFF
  const when = new Date(whenISO);
  if (isNaN(when.getTime())) throw new Error(`createScheduledPostArmed: bad scheduled_at "${whenISO}"`);
  if (!isWithinWindow(when)) {
    throw new Error(`createScheduledPostArmed: "${whenISO}" is in the dead hours (only 7:00am–1:00am America/Chicago allowed)`);
  }
  if (!input.account_ids?.length) throw new Error("createScheduledPostArmed: account_ids required");
  return schedulePost({
    account_ids: input.account_ids,
    text: input.text,
    // Prefer full media_objects (they carry the branded cover thumbnail); else bare media_ids.
    ...(input.media_objects?.length ? { media_objects: input.media_objects } : { media_ids: input.media_ids }),
    type: input.type ?? "video",
    scheduled_at: whenISO, // schedulePost defaults state to "scheduled"
  });
}
