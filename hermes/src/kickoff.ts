/**
 * kickoff.ts — the ONE human-only KICKOFF switch that arms the loop's autonomy.
 *
 * TWO regimes, ONE switch:
 *   - OFF (default, shipped state): the loop is DRAFT-ONLY. It creates Publer
 *     DRAFTS and schedules / publishes NOTHING. This is byte-for-byte the current
 *     behavior — cycle.ts takes the exact same createDraftOnly path it always has.
 *   - ARMED: the loop MAY additionally AUTO-SCHEDULE its own NEW drafts at policy
 *     times (scheduler.ts: 7:00am–1:00am CST + natural jitter). It NEVER publishes
 *     "now", NEVER touches a pre-existing scheduled/published post (do-not-touch
 *     snapshot/verify still runs), and stays bounded by the cost governor, quality
 *     gate, brand-voice gate, and kill-switch.
 *
 * ARMING IS A DELIBERATE HUMAN ACT — and is designed so the software factory (which
 * only merges CODE into the repo) CANNOT flip it:
 *   - the switch lives OUTSIDE the repo, in the data dir, and
 *   - a bare `touch` does NOT arm it: the file must CONTAIN the exact ack token, so
 *     an empty/accidental file is ignored.
 *
 * Fail-closed: ANY error, missing file, or malformed token => NOT armed (draft-only).
 * Reversible: delete the file (or unset the env) => back to draft-only next cycle.
 *
 * The 7-day goal clock (goal.ts) starts at the kickoff instant (the file's mtime),
 * so "days left" is real and only counts down once a human has flipped the switch.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The exact token a human must write to arm autonomy (a bare touch won't do it). */
export const KICKOFF_TOKEN = "ARM SFFS AUTONOMY";
/** Env var that can arm autonomy (value must equal KICKOFF_TOKEN). */
export const KICKOFF_ENV = "SFFS_KICKOFF_ARMED";
/** The arming file name inside the data dir. */
export const KICKOFF_FILENAME = "KICKOFF_ARMED";

export interface KickoffStatus {
  /** true only when a VALID arming token is present (env or file). */
  armed: boolean;
  /** where the arm came from, or null when off. */
  source: "env" | "file" | null;
  /** the kickoff instant (ISO) — file mtime, or env-arm detection time; null when off.
   *  This is t0 for the 7-day goal window. */
  since: string | null;
  /** the resolved arming-file path (for docs / the dashboard hint). */
  file: string;
  /** human-readable explanation. */
  note: string;
}

function dataDir(env: NodeJS.ProcessEnv): string {
  return (env.HERMES_DATA_DIR || "").trim() || "/home/ec2-user/hermes-data";
}

/** The absolute path of the arming file. */
export function kickoffFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dataDir(env), KICKOFF_FILENAME);
}

/**
 * Resolve the current kickoff status. Pure read (no writes); never throws.
 * A valid arm requires the exact KICKOFF_TOKEN — via the env var value, or as a
 * substring of the arming file's contents (so the human writes an explicit,
 * self-documenting phrase, not an empty file).
 */
export function kickoffStatus(env: NodeJS.ProcessEnv = process.env): KickoffStatus {
  const file = kickoffFilePath(env);
  // 1) env arm (value must be the exact token)
  try {
    if ((env[KICKOFF_ENV] || "").trim() === KICKOFF_TOKEN) {
      return { armed: true, source: "env", since: new Date().toISOString(), file, note: `armed via env ${KICKOFF_ENV}` };
    }
  } catch {
    /* fall through to file */
  }
  // 2) file arm (contents must CONTAIN the token; empty/accidental file is ignored)
  try {
    if (existsSync(file)) {
      const body = readFileSync(file, "utf8");
      if (body.includes(KICKOFF_TOKEN)) {
        let since: string | null = null;
        try {
          since = new Date(statSync(file).mtimeMs).toISOString();
        } catch {
          since = null;
        }
        return { armed: true, source: "file", since, file, note: `armed via ${file} (token present)` };
      }
      return { armed: false, source: null, since: null, file, note: `arming file present but token missing — NOT armed (write "${KICKOFF_TOKEN}" into it to arm)` };
    }
  } catch {
    /* fail-closed below */
  }
  return { armed: false, source: null, since: null, file, note: "draft-only (kickoff OFF): no valid arming token (env or file)" };
}

/** true iff autonomy is armed. Fail-closed: any error => false (draft-only). */
export function isArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return kickoffStatus(env).armed;
  } catch {
    return false;
  }
}

/** The kickoff instant (ISO) = t0 for the 7-day goal clock, or null when off. */
export function kickoffSince(env: NodeJS.ProcessEnv = process.env): string | null {
  return kickoffStatus(env).since;
}

/**
 * Throw unless autonomy is armed. Every kickoff-gated write path calls this
 * immediately before it can schedule, so an un-armed cycle physically cannot
 * schedule even if a caller wires it up by mistake (fail-closed).
 */
export function assertKickoffArmed(env: NodeJS.ProcessEnv = process.env): void {
  if (!isArmed(env)) {
    throw new Error(
      "KICKOFF NOT ARMED: the loop is DRAFT-ONLY. Autonomous scheduling is refused. " +
        `To arm (human-only): write "${KICKOFF_TOKEN}" into ${kickoffFilePath(env)} (or set env ${KICKOFF_ENV}).`,
    );
  }
}
