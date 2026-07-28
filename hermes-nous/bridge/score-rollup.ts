#!/usr/bin/env node
/**
 * score-rollup.ts (bridge) — the Node entry the `sffs` plugin shells into to run
 * the WRITE-side of scoring: pull matured Metricool analytics, join them onto
 * ab-database.json by platform_post_id, refresh per-post metrics, and recompute
 * the decision rollups (medians + front-runners) in learnings.json.
 *
 * It wraps ONLY hermes/src/score.ts `pullAndScore`. score.ts's dependency tree is
 * metricool.ts READ fns (listPosts / pullInsights) + state.ts local-file
 * JSON helpers + config + log — it has NO create / schedule / publish / delete /
 * update path anywhere, so this bridge is physically unable to post, publish,
 * schedule, or mutate any live post. It only issues analytics GETs and writes
 * two LOCAL JSON files (ab-database.json + learnings.json). This is the deliberate
 * WRITE-side complement to the read-only sffs_score tool (bridge/metricool-read.ts),
 * which never writes those files.
 *
 * USAGE:
 *   node score-rollup.ts run                # live: pull analytics + write rollups
 *   node score-rollup.ts run --dry-run      # network-free: echo the 30d window, no
 *                                             pull, NO file write
 *
 * LIVE needs the METRICOOL_* credentials (config.ts loads HERMES_ENV_FILE).
 * The window is fixed to the last 30 days (matches score.ts). Robust to unmatured
 * posts: it refreshes whatever has metrics and recomputes from those.
 *
 * EXIT CODES: 0 ok · 1 runtime error · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
import { pullAndScore } from "../../hermes/src/score.ts";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_SCORE_ROLLUP_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-")) ?? "run";

  if (sub !== "run") {
    console.error("score-rollup: usage: score-rollup.ts run [--dry-run]");
    process.exit(3);
    return;
  }

  // Fixed 30-day window (mirrors score.ts pullAndScore()).
  const to = ymd(new Date());
  const from = ymd(new Date(Date.now() - 30 * 86400_000));

  if (dryRun) {
    // NETWORK-FREE + WRITE-FREE: do not call pullAndScore (which pulls analytics
    // and writes ab-database.json + learnings.json). Just echo the window.
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        from,
        to,
        note: "score-rollup dry-run made no network call and wrote no files",
      }),
    );
    return;
  }

  // LIVE: pull matured analytics, refresh metrics, recompute rollups + front-runners.
  const result = await pullAndScore();
  console.log(JSON.stringify({ ok: true, ...result }));
}

main().catch((e) => {
  console.error(`score-rollup: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
