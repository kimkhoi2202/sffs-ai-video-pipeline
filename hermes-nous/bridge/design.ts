#!/usr/bin/env node
/**
 * design.ts (bridge) — the Node entry the `sffs` plugin shells into to DESIGN the
 * day's A/B batch. It wraps ONLY hermes/src/design.ts:
 *
 *   - `catalog`  -> dimensionCatalog()  : the static A/B dimension table (dimension /
 *                  arm / rationale + the narration arm and progress-counter axes).
 *                  Runs NO LLM and makes NO network call — a cheap way to see the
 *                  full A/B space (incl. the narration family: full / none /
 *                  no-question-vo / no-options-vo, and the progress-counter arms).
 *   - `plan`     -> planBatch(runId, target) : the full designer. Selects FRESH,
 *                  never-repeated questions per dimension and writes on-brand,
 *                  gated captions (this path DOES call the LLM for captions).
 *
 * It imports ONLY `planBatch` + `dimensionCatalog` from design.ts. design.ts has
 * NO Publer/create/schedule/publish/delete import anywhere in its dependency tree
 * (it wraps questions/gates/llm/brand/state/config/log only), so this bridge is
 * physically unable to create, publish, schedule, or mutate any post. It is the
 * design-side complement to bridge/publer-read.ts (reads) and bridge/donottouch.ts.
 *
 * USAGE:
 *   node design.ts catalog                       # -> { ok, count, dimensions }
 *   node design.ts plan     (stdin=params JSON)  # -> { ok, run_id, target, planned, plans }
 *   add --dry-run to either for a NETWORK-FREE run that echoes the validated
 *   request and makes no LLM/network call (catalog is already network-free).
 *
 *   plan params: { run_id: string, target: number }
 *
 * LIVE `plan` needs the TrueFoundry key (OPENAI_API_KEY / TFY_API_KEY) for caption
 * generation; if the LLM is unreachable, planBatch falls back to safe on-brand
 * captions (it never throws for that). No Publer keys are needed to design.
 *
 * EXIT CODES: 0 ok · 1 runtime error · 2 bad stdin JSON · 3 bad usage.
 * Diagnostics -> stderr; the machine-readable result -> one JSON line on stdout.
 */
// `catalog` is dependency-free (dimensions.ts pulls only node builtins), so it runs
// even where node_modules is absent. `plan` needs the LLM/gates chain (design.ts ->
// openai etc.), so it is DYNAMICALLY imported only inside the plan branch below.
import { dimensionCatalog } from "../../hermes/src/dimensions.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_DESIGN_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "catalog" && sub !== "plan") {
    console.error("design: usage: design.ts <catalog|plan> [--dry-run]");
    process.exit(3);
    return;
  }

  // ── catalog ─────────────────────────────────────────────────────────────
  // Static table; never touches the LLM/network. dry-run is equivalent here but
  // still echoes for a uniform contract.
  if (sub === "catalog") {
    const dimensions = dimensionCatalog();
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dry_run: true, sub, count: dimensions.length, note: "design dry-run made no network call" }));
      return;
    }
    console.log(JSON.stringify({ ok: true, sub, count: dimensions.length, dimensions }));
    return;
  }

  // ── plan ────────────────────────────────────────────────────────────────
  // sub === "plan": read { run_id, target } from stdin.
  const raw = (await readStdin()).trim();
  let params: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      } else {
        console.error("design: stdin must be a JSON object of params");
        process.exit(2);
        return;
      }
    } catch (e) {
      console.error(`design: invalid JSON on stdin: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
  }

  const runId = typeof params.run_id === "string" && params.run_id.trim() ? params.run_id.trim() : "";
  const target =
    typeof params.target === "number" && Number.isInteger(params.target) && params.target > 0 ? params.target : 0;
  if (!runId || !target) {
    console.error("design: plan requires run_id (string) and target (positive integer) on stdin");
    process.exit(3);
    return;
  }

  if (dryRun) {
    console.log(
      JSON.stringify({ ok: true, dry_run: true, sub, request: { run_id: runId, target }, note: "design dry-run made no network call" }),
    );
    return;
  }

  // DESIGN ONLY: selects fresh questions + generates gated captions. No post I/O.
  const { planBatch } = await import("../../hermes/src/design.ts");
  const plans = await planBatch(runId, target);
  console.log(JSON.stringify({ ok: true, run_id: runId, target, planned: plans.length, plans }));
}

main().catch((e) => {
  console.error(`design: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
