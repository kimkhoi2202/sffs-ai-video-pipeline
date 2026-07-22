#!/usr/bin/env node
/**
 * questions.ts (bridge) — the READ-ONLY Node entry the `sffs` plugin shells into
 * to SELECT fresh, never-before-used questions and to report bank freshness. It
 * wraps ONLY hermes/src/questions.ts:
 *
 *   - `candidates` -> candidateQuestions(filter) : validated, FRESH (never-used)
 *                     questions in a stable seeded order. "Fresh" = excluded from
 *                     BOTH dedup ledgers (content/ab-test-usage.json UNION
 *                     DATA_DIR/hermes-used-sigs.json) plus any in-batch `exclude`.
 *                     Only the two headless-renderable kinds are returned (text /
 *                     numseries). Read-only (reads the bank + ledgers).
 *   - `stats`      -> bankStats() : {total, usable, fresh, used} bank counts.
 *
 * It imports ONLY `candidateQuestions` + `bankStats`. It deliberately does NOT
 * import `markUsed` (the ledger WRITE that marks questions consumed) — that
 * mutation belongs with the drafting step, not selection, so this bridge is
 * physically unable to mutate the never-repeat ledger. questions.ts has NO
 * Publer/LLM import at all (it wraps state / config / log only), so this is a
 * pure, network-free, read-only selector.
 *
 * USAGE:
 *   node questions.ts candidates (stdin=filter JSON)  # -> { ok, count, total_fresh, questions }
 *   node questions.ts stats                           # -> { ok, stats }
 *   add --dry-run to either for a run that echoes the validated request.
 *
 *   candidates filter: { category?, kinds?, seed?, exclude?[], limit? }
 *     category: verbal | quantitative | nonverbal | mixed (mixed/omitted = no filter)
 *     kinds:    subset of ["text","numseries"] (default both)
 *     exclude:  extra sigs to skip (already claimed earlier in this batch)
 *     limit:    cap on returned candidates (default 20; the fresh pool can be large)
 *
 * No keys are ever needed (fully local). EXIT CODES: 0 ok · 1 runtime error ·
 * 2 bad stdin JSON · 3 bad usage. Diagnostics -> stderr; result -> one JSON line.
 */
import { candidateQuestions, bankStats } from "../../hermes/src/questions.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const DEFAULT_LIMIT = 20;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run") || process.env.HERMES_QUESTIONS_DRY_RUN === "1";
  const sub = argv.find((a) => !a.startsWith("-"));

  if (sub !== "candidates" && sub !== "stats") {
    console.error("questions: usage: questions.ts <candidates|stats> [--dry-run]");
    process.exit(3);
    return;
  }

  // ── stats ─────────────────────────────────────────────────────────────
  if (sub === "stats") {
    if (dryRun) {
      console.log(JSON.stringify({ ok: true, dry_run: true, sub, note: "questions dry-run made no network call" }));
      return;
    }
    const stats = bankStats(); // reads bank + used ledgers (local, no network)
    console.log(JSON.stringify({ ok: true, sub, stats }));
    return;
  }

  // ── candidates: read the filter from stdin ──────────────────────────────
  const raw = (await readStdin()).trim();
  let params: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      } else {
        console.error("questions: stdin must be a JSON object of filter params");
        process.exit(2);
        return;
      }
    } catch (e) {
      console.error(`questions: invalid JSON on stdin: ${(e as Error).message}`);
      process.exit(2);
      return;
    }
  }

  const category = typeof params.category === "string" && params.category.trim() ? params.category.trim() : undefined;
  const kinds = Array.isArray(params.kinds)
    ? (params.kinds.filter((k) => k === "text" || k === "numseries") as Array<"text" | "numseries">)
    : undefined;
  const seed = typeof params.seed === "string" && params.seed.trim() ? params.seed.trim() : undefined;
  const exclude = Array.isArray(params.exclude)
    ? new Set((params.exclude as unknown[]).map((s) => String(s)))
    : undefined;
  const limit =
    typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit > 0 ? params.limit : DEFAULT_LIMIT;

  if (dryRun) {
    console.log(
      JSON.stringify({
        ok: true,
        dry_run: true,
        sub,
        request: { category, kinds: kinds && kinds.length ? kinds : undefined, seed, exclude: exclude ? exclude.size : 0, limit },
        note: "questions dry-run made no network call",
      }),
    );
    return;
  }

  // READ-ONLY: select fresh (never-used) candidates, then cap to `limit`.
  const pool = candidateQuestions({ category, kinds: kinds && kinds.length ? kinds : undefined, seed, exclude });
  const questions = pool.slice(0, limit);
  console.log(JSON.stringify({ ok: true, sub, count: questions.length, total_fresh: pool.length, questions }));
}

main().catch((e) => {
  console.error(`questions: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
