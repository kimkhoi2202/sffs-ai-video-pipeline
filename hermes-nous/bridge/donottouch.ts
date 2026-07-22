#!/usr/bin/env node
/**
 * donottouch.ts — the READ-ONLY Node entry the `sffs` plugin shells into to
 * snapshot + verify the do-not-touch guarantee for PRE-EXISTING live posts.
 *
 * It imports ONLY `snapshotDoNotTouch` / `verifyDoNotTouch` from the pipeline's
 * safety core (hermes/src/guardrails.ts) — both of which only ever `listPosts`
 * (GET). It does NOT import or expose createPost / schedulePost / deletePost /
 * updatePost, so it is physically unable to create, publish, schedule, or mutate
 * ANY post. This is the read-only complement to bridge/publer-draft.ts.
 *
 * USAGE:
 *   node donottouch.ts snapshot            # -> { ok, snapshot: {scheduled_ids,...} }
 *   node donottouch.ts verify   (stdin=snapshot JSON)  # -> { ok, verified: true }
 *   add --dry-run (or HERMES_DRAFT_DRY_RUN=1) to either for a NETWORK-FREE run:
 *     snapshot --dry-run -> { ok, dry_run:true }        (no Publer read)
 *     verify   --dry-run -> { ok, dry_run:true }        (validates stdin shape only)
 *
 * LIVE MODE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID in the environment
 * (config.ts loads them from HERMES_ENV_FILE; the Python bridge points that at
 * $HERMES_HOME/.env).
 *
 * EXIT CODES: 0 ok · 1 runtime/network error · 2 bad stdin JSON · 3 bad usage ·
 * 4 do-not-touch VIOLATION (a pre-existing scheduled/published post changed).
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import { snapshotDoNotTouch, verifyDoNotTouch, type DoNotTouchSnapshot } from "../../hermes/src/guardrails.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function isSnapshotShape(x: unknown): x is DoNotTouchSnapshot {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  const okList = (v: unknown) => Array.isArray(v) && v.every((e) => typeof e === "string");
  return okList(o.scheduled_ids) && okList(o.published_ids);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_DRAFT_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "snapshot" && sub !== "verify") {
    console.error("donottouch: usage: donottouch.ts <snapshot|verify> [--dry-run]");
    process.exit(3);
    return;
  }

  if (sub === "snapshot") {
    if (dryRun) {
      console.log(
        JSON.stringify({ ok: true, dry_run: true, note: "snapshot dry-run made no network call" }),
      );
      return;
    }
    // READ-ONLY: lists scheduled + published posts, returns their ids.
    const snapshot = await snapshotDoNotTouch();
    console.log(JSON.stringify({ ok: true, snapshot }));
    return;
  }

  // sub === "verify": read the prior snapshot from stdin.
  const raw = (await readStdin()).trim();
  let input: unknown;
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`donottouch: invalid JSON on stdin: ${(e as Error).message}`);
    process.exit(2);
    return;
  }
  if (!isSnapshotShape(input)) {
    console.error("donottouch: stdin must be a snapshot { scheduled_ids:[], published_ids:[] }");
    process.exit(3);
    return;
  }

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dry_run: true, verified: null }));
    return;
  }

  // READ-ONLY: re-lists and throws if any pre-existing post vanished/moved.
  try {
    await verifyDoNotTouch(input);
  } catch (e) {
    console.error(`donottouch: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(4);
    return;
  }
  console.log(JSON.stringify({ ok: true, verified: true }));
}

main().catch((e) => {
  console.error(`donottouch: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
