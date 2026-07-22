#!/usr/bin/env node
/**
 * reconcile.ts (bridge) — the Node entry the `sffs` plugin shells into to close
 * the A/B LEARNING LOOP for the agent's OWN posts: match each ab-database.json
 * record's `publer_post_id` to the native published post and back-fill
 * `platform_post_id` / `permalink` / `posted_at`.
 *
 * It wraps ONLY hermes/src/reconcile.ts `reconcile`. reconcile.ts's dependency
 * tree is publer.ts READ fns (getPostInsights / flattenPostInsights /
 * listAllPosts) + state.ts local-file JSON helpers + config + log — it imports NO
 * create / schedule / publish / delete / update path anywhere, so this bridge is
 * physically unable to post, publish, schedule, or mutate any Publer post. It
 * only issues analytics/list GETs and writes ONE local JSON file (ab-database.json),
 * and only when a field actually changed (idempotent).
 *
 * USAGE:
 *   node reconcile.ts run                # live: read Publer + back-fill ab-database
 *   node reconcile.ts run --dry-run      # network-free + write-free: echo the plan
 *
 * LIVE needs PUBLER_API_KEY + PUBLER_WORKSPACE_ID (config.ts loads HERMES_ENV_FILE).
 *
 * EXIT CODES: 0 ok · 1 runtime error · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import { reconcile } from "../../hermes/src/reconcile.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_RECONCILE_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-")) ?? "run";

  if (sub !== "run") {
    console.error("reconcile: usage: reconcile.ts run [--dry-run]");
    process.exit(3);
    return;
  }

  if (dryRun) {
    // NETWORK-FREE + WRITE-FREE: do not call reconcile() (which reads Publer and
    // writes ab-database.json). Just echo what a live run would do.
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        note:
          "reconcile dry-run made no network call and wrote no files; a live run would " +
          "back-fill platform_post_id/permalink/posted_at onto ab-database.json from Publer",
      }),
    );
    return;
  }

  // LIVE: read Publer (GET only), back-fill ab-database.json (local write only).
  const result = await reconcile();
  console.log(JSON.stringify({ ok: true, ...result }));
}

main().catch((e) => {
  console.error(`reconcile: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
