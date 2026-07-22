#!/usr/bin/env node
/**
 * publer-draft.ts — the ONLY Node entry the `sffs` Hermes plugin shells into to
 * create a Publer post. It calls the pipeline's DRAFT-ONLY safety core
 * (`createDraftOnly` in hermes/src/guardrails.ts) and NOTHING else: it does not
 * import or expose schedulePost / deletePost(s) / updatePost, so it is
 * physically unable to publish, schedule, or mutate an existing post.
 *
 * This is the "suspenders" half of the belt-and-suspenders DRAFT-ONLY guarantee.
 * The "belt" is the Python tool layer (hermes-nous/sffs/draft_guard.py), which
 * refuses any non-draft state / scheduled_at BEFORE it ever spawns this process.
 *
 * INPUT: a JSON object on stdin, e.g.
 *   { "account_ids": ["..."], "text": "...", "media_ids": ["..."], "type": "video" }
 *
 * MODES:
 *   --dry-run (or HERMES_DRAFT_DRY_RUN=1): validate via validateDraftOnly() and
 *       print the normalized draft payload WITHOUT any network call. Needs no
 *       API keys and no `npm install` (the import chain is Node built-ins only).
 *   (default): call createDraftOnly() for real → prints { ok, job_id, state }.
 *       Requires PUBLER_API_KEY + PUBLER_WORKSPACE_ID in the environment.
 *
 * EXIT CODES: 0 ok · 1 runtime/network error · 2 bad stdin JSON · 3 guard refusal
 * (non-draft state / scheduled_at / missing account_ids). Diagnostics go to
 * stderr; the machine-readable result goes to stdout as a single JSON line.
 */
import { validateDraftOnly, createDraftOnly } from "../../hermes/src/guardrails.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const dryRun =
    process.argv.includes("--dry-run") || process.env.HERMES_DRAFT_DRY_RUN === "1";

  const raw = (await readStdin()).trim();
  let input: Record<string, unknown>;
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`publer-draft: invalid JSON on stdin: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  // Guard FIRST (refuses non-draft state / scheduled_at, forces state="draft").
  let draft;
  try {
    draft = validateDraftOnly(input as any);
  } catch (e) {
    console.error(`publer-draft: REFUSED — ${(e as Error).message}`);
    process.exit(3);
    return;
  }

  if (dryRun) {
    // Network-free proof that the draft-only invariant holds at the Node layer.
    console.log(JSON.stringify({ ok: true, dry_run: true, state: "draft", payload: draft }));
    return;
  }

  // Live: createDraftOnly() re-validates (belt-and-suspenders) then creates a
  // DRAFT only. There is no code path here that can publish or schedule.
  const jobId = await createDraftOnly(draft);
  console.log(JSON.stringify({ ok: true, job_id: jobId, state: "draft" }));
}

main().catch((e) => {
  console.error(`publer-draft: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
