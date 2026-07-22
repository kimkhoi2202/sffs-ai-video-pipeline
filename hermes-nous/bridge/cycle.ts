#!/usr/bin/env node
/**
 * cycle.ts (bridge) — the Node entry the `sffs` plugin shells into to run ONE full
 * DRAFT-ONLY A/B cycle end to end. It wraps ONLY hermes/src/cycle.ts `runCycle`,
 * which ties together every proven pipeline module in order:
 *
 *   preflight (assertDraftOnly + LLM ping)
 *     -> snapshotDoNotTouch (read-only, before)
 *     -> pullAndScore        (refresh ab-database.json + learnings.json)
 *     -> planBatch           (design the A/B batch; rotating dimensions incl. the
 *                             narration family + progress-counter arms)
 *   per video: gateDedup -> validateQuestions -> markUsed(after validity) ->
 *              gateCopy -> renderVideo -> gateRenderSanity ->
 *              [live only] uploadToS3 -> importMediaFromUrl -> createDraftOnly
 *     -> verifyDoNotTouch    (read-only, after — proves nothing live was touched)
 *
 * SAFETY (belt AND suspenders):
 *   * createDraftOnly is the ONLY Publer write runCycle performs, and it forces
 *     state="draft" (guardrails.ts). No schedule / publish / delete / update path
 *     is imported anywhere in cycle.ts's dependency tree.
 *   * This bridge FORCES `HERMES_SKIP_GIT=1` (below) so a cycle run from the
 *     isolated sandbox can NEVER `git push origin HEAD:main` (cycle.ts's
 *     gitCommitPush is gated on it). The sffs_cycle Python handler also sets it in
 *     the subprocess env — this is the redundant second layer.
 *
 * MODES (driven by env the Python handler sets BEFORE node starts, because
 * HERMES_DRY_RUN + HERMES_VIDEOS_PER_DAY are read at cycle.ts / config.ts module
 * load):
 *   HERMES_DRY_RUN=1         -> render + gates run, but NO S3 upload / NO Publer
 *                               draft / NO git push (a safe end-to-end dry-run).
 *   (unset)                  -> a REAL draft-only cycle: render + S3 + create
 *                               Publer DRAFTS (still never publishes/schedules,
 *                               still never pushes to main).
 *   HERMES_VIDEOS_PER_DAY=N  -> bound the batch size (validation uses 1).
 *   HERMES_RUN_ID=<id>       -> resumable run id (defaults to today's UTC date).
 *   HERMES_DATA_DIR=<path>   -> where renders/runs land (outside the repo).
 *
 * EXIT CODES: 0 success/partial · 1 failed/crashed.
 * Diagnostics -> stderr; the final RunState -> one JSON line on stdout.
 */

// SUSPENDERS: force the git push off before runCycle() is ever called. cycle.ts
// reads HERMES_SKIP_GIT at RUNTIME (inside runCycle), so setting it here — even
// though ES import of cycle.ts is hoisted above this line — takes effect. The
// Python handler ALSO sets it in the subprocess env (belt).
process.env.HERMES_SKIP_GIT = "1";

import { runCycle } from "../../hermes/src/cycle.ts";

async function main(): Promise<void> {
  const state = await runCycle();
  // The RunState is the source of truth for the dashboard + idempotency; emit it
  // whole as the last stdout line (log.ts INFO lines precede it — the Python
  // handler parses the last JSON line; see failures.md F6).
  console.log(JSON.stringify(state));
  process.exit(state.status === "failed" ? 1 : 0);
}

main().catch((e) => {
  console.error(`cycle: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
